import assert from "node:assert/strict";
import test from "node:test";
import { CodexVoiceService, hermesTools } from "../src/service.mjs";

class FakeAppServer {
  constructor() {
    this.requests = [];
    this.waiter = null;
  }
  setRequestHandler(handler) { this.handler = handler; }
  request(method, params) {
    this.requests.push({ method, params });
    if (method === "thread/start") return Promise.resolve({ thread: { id: "thread-1" } });
    if (method === "thread/realtime/start") {
      queueMicrotask(() => this.waiter({ threadId: "thread-1", sdp: "v=0\r\nanswer" }));
    }
    return Promise.resolve({});
  }
  waitForNotification(_method, predicate) {
    return new Promise((resolve) => { this.waiter = (value) => predicate(value) && resolve(value); });
  }
}

test("starts V3 audio WebRTC on an ephemeral read-only thread", async () => {
  const appServer = new FakeAppServer();
  const service = new CodexVoiceService({
    appServer,
    relayURL: "https://relay.example",
    workspace: "/tmp/caller-broker-test",
    fetchImpl: async () => Response.json({ events: [], next_cursor: 0 }),
    eventPollMs: 60_000,
  });

  const result = await service.startSession({
    sessionID: "00000000-0000-4000-8000-000000000001",
    offerSDP: "v=0\r\noffer",
    instructions: "Speak naturally.",
    toolToken: "t".repeat(32),
  });

  assert.equal(result.answerSDP, "v=0\r\nanswer");
  assert.deepEqual(appServer.requests[0], {
    method: "thread/start",
    params: {
      ephemeral: true,
      cwd: "/tmp/caller-broker-test",
      sandbox: "read-only",
      approvalPolicy: "never",
      dynamicTools: hermesTools(),
    },
  });
  assert.deepEqual(appServer.requests[1], {
    method: "thread/realtime/start",
    params: {
      threadId: "thread-1",
      outputModality: "audio",
      version: "v3",
      includeStartupContext: false,
      realtimeStartInstructions: "Speak naturally.",
      voice: "sol",
      transport: { type: "webrtc", sdp: "v=0\r\noffer" },
    },
  });
  await service.stopSession("00000000-0000-4000-8000-000000000001");
});

test("forwards Codex dynamic tool calls with the call-scoped credential", async () => {
  const appServer = new FakeAppServer();
  let request;
  const service = new CodexVoiceService({
    appServer,
    relayURL: "https://relay.example/base/",
    workspace: "/tmp/caller-broker-test",
    fetchImpl: async (url, init) => {
      request = { url: String(url), init };
      return Response.json({ success: true, contentItems: [{ type: "inputText", text: "queued" }] });
    },
    eventPollMs: 60_000,
  });
  await service.startSession({
    sessionID: "00000000-0000-4000-8000-000000000002",
    offerSDP: "v=0\r\noffer",
    instructions: "Speak naturally.",
    toolToken: "s".repeat(32),
  });

  const result = await appServer.handler("item/tool/call", {
    threadId: "thread-1",
    callId: "call-1",
    tool: "ask_hermes",
    arguments: { request: "hello", context_scope: "origin" },
  });

  assert.equal(request.url, "https://relay.example/base/v1/codex-tools/00000000-0000-4000-8000-000000000002/call");
  assert.equal(request.init.headers.authorization, `Bearer ${"s".repeat(32)}`);
  assert.deepEqual(JSON.parse(request.init.body), {
    request_id: "call-1",
    name: "ask_hermes",
    arguments: { request: "hello", context_scope: "origin" },
  });
  assert.deepEqual(result, {
    success: true,
    contentItems: [{ type: "inputText", text: "queued" }],
  });
  await service.stopSession("00000000-0000-4000-8000-000000000002");
});
