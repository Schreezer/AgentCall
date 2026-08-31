import assert from "node:assert/strict";
import test from "node:test";
import { createBrokerServer } from "../src/server.mjs";

async function withServer(service, callback) {
  const server = createBrokerServer({ service, bearerToken: "broker-secret".repeat(3) });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    await callback(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("requires broker authentication and validates the WebRTC offer", async () => {
  const service = { startSession: async () => assert.fail("must not start") };
  await withServer(service, async (baseURL) => {
    const unauthorized = await fetch(`${baseURL}/health`);
    assert.equal(unauthorized.status, 401);

    const invalid = await fetch(`${baseURL}/v1/sessions`, {
      method: "POST",
      headers: { authorization: `Bearer ${"broker-secret".repeat(3)}`, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(invalid.status, 400);
  });
});

test("returns the Codex WebRTC answer without exposing the tool credential", async () => {
  let observed;
  const service = {
    startSession: async (input) => {
      observed = input;
      return { answerSDP: "v=0\r\nanswer" };
    },
  };
  await withServer(service, async (baseURL) => {
    const response = await fetch(`${baseURL}/v1/sessions`, {
      method: "POST",
      headers: { authorization: `Bearer ${"broker-secret".repeat(3)}`, "content-type": "application/json" },
      body: JSON.stringify({
        session_id: "00000000-0000-4000-8000-000000000003",
        offer_sdp: "v=0\r\noffer",
        instructions: "Speak naturally.",
        tool_token: "x".repeat(32),
      }),
    });
    assert.equal(response.status, 201);
    const payload = await response.json();
    assert.deepEqual(payload, {
      session_id: "00000000-0000-4000-8000-000000000003",
      answer_sdp: "v=0\r\nanswer",
    });
    assert.equal(observed.toolToken, "x".repeat(32));
    assert.doesNotMatch(JSON.stringify(payload), /xxx/);
  });
});
