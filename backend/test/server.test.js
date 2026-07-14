import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createServer } from "../src/server.js";
import { Store } from "../src/store.js";

async function withRelay(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "caller-relay-api-"));
  const store = new Store(path.join(directory, "state.json"));
  const worker = { apns: { configured: false }, tick: async () => {} };
  const server = createServer({
    config: { publicBaseURL: "http://127.0.0.1" },
    store,
    worker,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseURL = `http://127.0.0.1:${server.address().port}`;
  try {
    await run(baseURL);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("app registration, agent claim, and authorized call form one complete flow", async () => {
  await withRelay(async (baseURL) => {
    const registration = await fetch(`${baseURL}/v1/installations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "c".repeat(64), platform: "ios", environment: "sandbox" }),
    });
    assert.equal(registration.status, 201);
    const installation = await registration.json();
    assert.match(installation.pairing_code, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    assert.ok(installation.installation_secret);

    const claim = await fetch(`${baseURL}/v1/pairings/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pairing_code: installation.pairing_code }),
    });
    assert.equal(claim.status, 200);
    const credential = await claim.json();

    const status = await fetch(`${baseURL}/v1/installations/${installation.installation_id}`, {
      headers: { authorization: `Bearer ${installation.installation_secret}` },
    });
    assert.equal(status.status, 200);
    assert.equal((await status.json()).paired, true);

    const unauthorized = await fetch(`${baseURL}/v1/calls`, { method: "POST" });
    assert.equal(unauthorized.status, 401);

    const call = await fetch(`${baseURL}/v1/calls`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${credential.agent_token}`,
        "content-type": "application/json",
        "idempotency-key": "api-flow-1",
      },
      body: JSON.stringify({ message: "This is urgent", caller_name: "Hermes" }),
    });
    assert.equal(call.status, 202);
    assert.equal((await call.json()).status, "scheduled");
  });
});

test("app can revoke its installation before changing relays", async () => {
  await withRelay(async (baseURL) => {
    const registration = await fetch(`${baseURL}/v1/installations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "d".repeat(64), platform: "ios", environment: "sandbox" }),
    });
    const installation = await registration.json();

    const unauthorized = await fetch(`${baseURL}/v1/installations/${installation.installation_id}`, {
      method: "DELETE",
      headers: { authorization: "Bearer wrong-secret" },
    });
    assert.equal(unauthorized.status, 401);

    const deleted = await fetch(`${baseURL}/v1/installations/${installation.installation_id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${installation.installation_secret}` },
    });
    assert.equal(deleted.status, 204);

    const status = await fetch(`${baseURL}/v1/installations/${installation.installation_id}`, {
      headers: { authorization: `Bearer ${installation.installation_secret}` },
    });
    assert.equal(status.status, 401);
  });
});
