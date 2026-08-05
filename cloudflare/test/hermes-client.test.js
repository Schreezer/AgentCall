import assert from "node:assert/strict";
import test from "node:test";
import { HermesClient, HERMES_ORIGIN } from "../src/hermes-client.js";

test("Hermes private requests use the IPv4 loopback listener", async () => {
  let capturedRequest;
  const client = new HermesClient({
    HERMES_API_KEY: "test-key",
    HERMES_PRIVATE: {
      async fetch(request) {
        capturedRequest = request;
        return new Response(JSON.stringify({ session_id: "caller-test" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      },
    },
  });

  await client.createSession("caller-test");

  assert.equal(HERMES_ORIGIN, "http://127.0.0.1:8642");
  assert.equal(capturedRequest.url, "http://127.0.0.1:8642/api/sessions");
  assert.equal(capturedRequest.headers.get("authorization"), "Bearer test-key");
  assert.deepEqual(await capturedRequest.json(), {
    id: "caller-test",
    title: "Caller voice caller-test",
  });
});

test("Hermes HTTP failures preserve a bounded structured error detail", async () => {
  const client = new HermesClient({
    HERMES_API_KEY: "test-key",
    HERMES_PRIVATE: {
      async fetch() {
        return Response.json(
          { error: { code: "invalid_request", type: "validation_error", message: "Session ID is invalid" } },
          { status: 400 },
        );
      },
    },
  });

  await assert.rejects(
    client.createSession("bad"),
    /hermes_http_400:invalid_request:validation_error:Session ID is invalid/,
  );
});
