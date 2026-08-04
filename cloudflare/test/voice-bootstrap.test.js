import assert from "node:assert/strict";
import test from "node:test";
import { mintXaiClientSecret } from "../src/voice-bootstrap.js";

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
