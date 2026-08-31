import assert from "node:assert/strict";
import test from "node:test";
import {
  createCodexBrokerSession,
  mintXaiClientSecret,
} from "../src/voice-bootstrap.js";

const env = { XAI_API_KEY: "test-key" };

test("mints an xAI client secret with the documented request shape", async () => {
  let observedRequest;
  const result = await mintXaiClientSecret(env, {
    fetchImpl: async (url, init) => {
      observedRequest = { url, init };
      return Response.json({ value: "ephemeral-only" });
    },
  });

  assert.deepEqual(result, { ok: true, token: "ephemeral-only" });
  assert.equal(observedRequest.url, "https://api.x.ai/v1/realtime/client_secrets");
  assert.equal(observedRequest.init.method, "POST");
  assert.equal(observedRequest.init.headers.authorization, "Bearer test-key");
  assert.deepEqual(JSON.parse(observedRequest.init.body), {
    expires_after: { seconds: 300 },
  });
});

test("reports an upstream rejection without retaining its message or credentials", async () => {
  const result = await mintXaiClientSecret(env, {
    fetchImpl: async () => Response.json(
      {
        error: {
          type: "authentication_error",
          code: "invalid_api_key",
          message: "Rejected key secret-value-must-not-escape",
        },
      },
      { status: 401, headers: { "x-request-id": "req-safe_123" } },
    ),
  });

  assert.deepEqual(result, {
    ok: false,
    status: 502,
    error: "xai_client_secret_failed",
    diagnostic: {
      upstream_status: 401,
      upstream_request_id: "req-safe_123",
      reason: "upstream_rejected",
      upstream_error_type: "authentication_error",
      upstream_error_code: "invalid_api_key",
    },
  });
  assert.doesNotMatch(JSON.stringify(result), /secret-value/);
});

test("distinguishes timeouts and malformed successful responses", async () => {
  const timeout = await mintXaiClientSecret(env, {
    fetchImpl: async () => {
      throw new DOMException("timed out", "TimeoutError");
    },
  });
  assert.deepEqual(timeout, {
    ok: false,
    status: 502,
    error: "xai_client_secret_unreachable",
    diagnostic: { reason: "timeout" },
  });

  const malformed = await mintXaiClientSecret(env, {
    fetchImpl: async () => new Response("not-json", { status: 200 }),
  });
  assert.deepEqual(malformed, {
    ok: false,
    status: 502,
    error: "xai_client_secret_invalid_response",
    diagnostic: { upstream_status: 200, reason: "invalid_json" },
  });
});

test("creates a Codex broker session without returning its call-scoped tool token", async () => {
  let observed;
  const result = await createCodexBrokerSession(
    {
      CODEX_VOICE_BROKER_URL: "https://codex-broker.example/private",
      CODEX_VOICE_BROKER_TOKEN: "broker-secret",
      CODEX_VOICE: "sol",
    },
    {
      sessionID: "00000000-0000-4000-8000-000000000001",
      offerSDP: "v=0\r\noffer",
      instructions: "Speak naturally.",
      toolToken: "call-scoped-secret",
    },
    {
      fetchImpl: async (url, init) => {
        observed = { url: String(url), init };
        return Response.json({ answer_sdp: "v=0\r\nanswer" });
      },
    },
  );

  assert.deepEqual(result, { ok: true, answerSDP: "v=0\r\nanswer" });
  assert.equal(observed.url, "https://codex-broker.example/private/v1/sessions");
  assert.equal(observed.init.headers.authorization, "Bearer broker-secret");
  assert.deepEqual(JSON.parse(observed.init.body), {
    session_id: "00000000-0000-4000-8000-000000000001",
    offer_sdp: "v=0\r\noffer",
    instructions: "Speak naturally.",
    tool_token: "call-scoped-secret",
    voice: "sol",
  });
  assert.doesNotMatch(JSON.stringify(result), /call-scoped-secret|broker-secret/);
});

test("requires HTTPS and sanitizes Codex broker failures", async () => {
  const invalidURL = await createCodexBrokerSession(
    {
      CODEX_VOICE_BROKER_URL: "http://codex-broker.example",
      CODEX_VOICE_BROKER_TOKEN: "secret",
    },
    {},
  );
  assert.deepEqual(invalidURL, {
    ok: false,
    status: 503,
    error: "codex_broker_url_must_use_https",
  });

  const rejected = await createCodexBrokerSession(
    {
      CODEX_VOICE_BROKER_URL: "https://codex-broker.example",
      CODEX_VOICE_BROKER_TOKEN: "secret",
    },
    {
      sessionID: "00000000-0000-4000-8000-000000000001",
      offerSDP: "v=0\r\noffer",
      instructions: "Speak naturally.",
      toolToken: "call-secret",
    },
    {
      fetchImpl: async () => Response.json(
        { error: "authentication failed with secret-value" },
        { status: 401, headers: { "x-request-id": "safe-request-id" } },
      ),
    },
  );
  assert.equal(rejected.error, "codex_broker_rejected");
  assert.equal(rejected.diagnostic.upstream_request_id, "safe-request-id");
  assert.doesNotMatch(JSON.stringify(rejected), /secret-value|call-secret/);
});
