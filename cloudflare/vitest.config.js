import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";
import { MockAgent } from "undici";

const directory = path.dirname(fileURLToPath(import.meta.url));

process.env.APNS_TEAM_ID ??= "TESTTEAMID";
process.env.APNS_KEY_ID ??= "TESTKEYID";
process.env.APNS_PRIVATE_KEY ??= "not-a-real-private-key";
const fetchMock = new MockAgent();
fetchMock.disableNetConnect();
fetchMock
  .get("https://api.x.ai")
  .intercept({ path: "/v1/realtime/client_secrets", method: "POST" })
  .reply(200, { value: "ephemeral-only" })
  .persist();

// Scripted Anthropic Messages API used by the hosted-agent tests. The reply depends on the
// latest user message so a test can drive a tool call and its follow-up deterministically.
fetchMock
  .get("https://api.anthropic.com")
  .intercept({ path: (value) => value.startsWith("/v1/messages"), method: "POST" })
  .reply(
    200,
    // undici resolves a promise-returning data function before replying, which lets the
    // scripted reply read the streamed request body.
    async (request) => scriptedAnthropicReply(await requestBodyText(request.body)),
    { headers: { "content-type": "text/event-stream" } },
  )
  .persist();

async function requestBodyText(body) {
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  if (body && typeof body[Symbol.asyncIterator] === "function") {
    const chunks = [];
    for await (const chunk of body) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString("utf8");
  }
  return "";
}

function scriptedAnthropicReply(rawBody) {
  let body = {};
  try {
    body = JSON.parse(rawBody);
  } catch {
    body = {};
  }
  const last = Array.isArray(body.messages) ? body.messages.at(-1) : null;
  if (last?.role === "user" && Array.isArray(last.content)) {
    const failed = last.content.some((block) => block.is_error);
    return anthropicTextStream(failed ? "That did not work; I can try later." : "Done, I took care of it.");
  }
  const text = typeof last?.content === "string" ? last.content : "";
  if (text.includes("CALL_ME")) {
    return anthropicToolStream("place_call", {
      message: "Checking in as requested",
      reason: "The user asked for a call",
      relevant_context: "Nothing else pending",
      desired_outcome: "Confirm the user is fine",
      urgency: "normal",
      opening_question: "How are you doing right now?",
    });
  }
  if (text.includes("SCHEDULE_ME")) {
    return anthropicToolStream("create_schedule", {
      label: "Morning check-in",
      instruction: "Call the user and ask how they slept.",
      cron: "0 12 * * *",
    });
  }
  if (text.includes("REMEMBER_ME")) {
    return anthropicToolStream("remember", { note: "The user drinks tea, not coffee." });
  }
  if (text.includes("voice agent asks")) {
    return anthropicTextStream("Your next appointment is at three.");
  }
  return anthropicTextStream("Hello from your assistant.");
}

function anthropicEvents(events) {
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

function anthropicMessageStart() {
  return {
    type: "message_start",
    message: {
      id: `msg_${Math.random().toString(16).slice(2)}`,
      type: "message",
      role: "assistant",
      model: "claude-opus-5",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 12, output_tokens: 1 },
    },
  };
}

function anthropicTextStream(text) {
  return anthropicEvents([
    anthropicMessageStart(),
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 8 } },
    { type: "message_stop" },
  ]);
}

function anthropicToolStream(name, input) {
  return anthropicEvents([
    anthropicMessageStart(),
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "On it." } },
    { type: "content_block_stop", index: 0 },
    {
      type: "content_block_start",
      index: 1,
      content_block: { type: "tool_use", id: `toolu_${Math.random().toString(16).slice(2)}`, name, input: {} },
    },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } },
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 20 } },
    { type: "message_stop" },
  ]);
}

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: path.join(directory, "wrangler.jsonc") },
      miniflare: {
        fetchMock,
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(
            path.join(directory, "migrations"),
          ),
          APNS_TEAM_ID: process.env.APNS_TEAM_ID,
          APNS_KEY_ID: process.env.APNS_KEY_ID,
          APNS_PRIVATE_KEY: process.env.APNS_PRIVATE_KEY,
          XAI_API_KEY: "test-xai-key",
          ANTHROPIC_API_KEY: "test-anthropic-key",
          LIVE_VOICE_ENABLED: "true",
          LIVE_VOICE_BACKEND: "legacy",
          LIVE_VOICE_PROVIDER: "xai",
        },
      },
    })),
  ],
  test: {
    include: ["test/**/*.worker.test.js"],
    setupFiles: ["./test/apply-migrations.js"],
  },
});
