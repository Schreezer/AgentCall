import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { CodexAppServerClient, TESTED_CODEX_VERSION } from "./app-server-client.mjs";
import { CodexVoiceService, serviceError } from "./service.mjs";

const MAX_BODY_BYTES = 160_000;

export function createBrokerServer({ service, bearerToken }) {
  if (typeof bearerToken !== "string" || bearerToken.length < 32) {
    throw new Error("CODEX_VOICE_BROKER_TOKEN must contain at least 32 characters");
  }
  return createServer(async (request, response) => {
    try {
      if (!authorized(request.headers.authorization, bearerToken)) {
        return sendJSON(response, 401, { error: "invalid_broker_credential" });
      }
      const url = new URL(request.url, "http://broker.invalid");
      if (request.method === "GET" && url.pathname === "/health") {
        return sendJSON(response, 200, {
          ok: true,
          service: "agentcaller-codex-voice-broker",
          codex_version: TESTED_CODEX_VERSION,
        });
      }
      if (request.method === "POST" && url.pathname === "/v1/sessions") {
        const body = await readJSON(request, MAX_BODY_BYTES);
        validateStart(body);
        const result = await service.startSession({
          sessionID: body.session_id,
          offerSDP: body.offer_sdp,
          instructions: body.instructions,
          toolToken: body.tool_token,
          voice: body.voice,
        });
        return sendJSON(response, 201, {
          session_id: body.session_id,
          answer_sdp: result.answerSDP,
        });
      }
      const sessionMatch = url.pathname.match(/^\/v1\/sessions\/([0-9a-f-]+)$/i);
      if (request.method === "DELETE" && sessionMatch) {
        const removed = await service.stopSession(sessionMatch[1].toLowerCase());
        response.writeHead(removed ? 204 : 404, { "cache-control": "no-store" });
        return response.end();
      }
      return sendJSON(response, 404, { error: "not_found" });
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 500;
      if (status === 500) console.error(error);
      return sendJSON(response, status, { error: status === 500 ? "internal_error" : error.message });
    }
  });
}

function validateStart(body) {
  if (!body || typeof body !== "object") throw serviceError(400, "invalid_request");
  if (!/^[0-9a-f-]{36}$/i.test(body.session_id ?? "")) throw serviceError(400, "invalid_session_id");
  if (typeof body.offer_sdp !== "string" || !body.offer_sdp.startsWith("v=0\r\n")) {
    throw serviceError(400, "invalid_offer_sdp");
  }
  if (typeof body.instructions !== "string" || !body.instructions.trim()) {
    throw serviceError(400, "instructions_required");
  }
  if (typeof body.tool_token !== "string" || body.tool_token.length < 32) {
    throw serviceError(400, "tool_token_required");
  }
}

async function readJSON(request, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw serviceError(413, "request_too_large");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw serviceError(400, "invalid_json");
  }
}

function authorized(header, expected) {
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const actual = Buffer.from(header.slice(7));
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

function sendJSON(response, status, body) {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(body));
}

async function main() {
  const relayURL = process.env.CALLER_RELAY_URL;
  const bearerToken = process.env.CODEX_VOICE_BROKER_TOKEN;
  if (!relayURL) throw new Error("CALLER_RELAY_URL is required");
  const relay = new URL(relayURL);
  if (relay.protocol !== "https:" && relay.hostname !== "localhost" && relay.hostname !== "127.0.0.1") {
    throw new Error("CALLER_RELAY_URL must use HTTPS unless it is loopback");
  }
  const appServer = await CodexAppServerClient.launch({
    command: process.env.CODEX_COMMAND || "codex",
    expectedVersion: process.env.CODEX_EXPECTED_VERSION || TESTED_CODEX_VERSION,
  });
  const service = new CodexVoiceService({
    appServer,
    relayURL,
    workspace: process.env.CODEX_VOICE_WORKSPACE || "/tmp/agentcaller-codex-voice",
  });
  await service.initialize();
  const server = createBrokerServer({ service, bearerToken });
  const host = process.env.CODEX_VOICE_BROKER_HOST || "127.0.0.1";
  const port = Number(process.env.CODEX_VOICE_BROKER_PORT || 8791);
  server.listen(port, host, () => console.log(`Codex voice broker listening on http://${host}:${port}`));

  const shutdown = async () => {
    server.close();
    await service.close();
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
