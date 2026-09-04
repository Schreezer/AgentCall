import assert from "node:assert/strict";
import test from "node:test";
import { APNsClient } from "../src/apns.js";

test("sends the Worker-compatible APNs VoIP request and reuses its JWT", async () => {
  const keys = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const privateKey = await crypto.subtle.exportKey("pkcs8", keys.privateKey);
  const env = {
    APNS_TEAM_ID: "TEAMID1234",
    APNS_KEY_ID: "KEYID12345",
    APNS_PRIVATE_KEY: pem(privateKey),
    APNS_BUNDLE_ID: "com.chirag.agentcaller",
  };
  const requests = [];
  const fetcher = async function (url, init) {
    assert.equal(this, undefined);
    requests.push({ url, init });
    return new Response(null, { status: 200, headers: { "apns-id": "push-id" } });
  };
  const client = new APNsClient(env, {
    fetcher,
    now: () => Date.parse("2026-07-27T12:00:00Z"),
  });
  const device = { environment: "sandbox", device_token: "ab".repeat(32) };
  const call = {
    id: "123e4567-e89b-42d3-a456-426614174000",
    caller_name: "Hermes",
    message: "Wake up",
    mode: "live_voice",
  };

  await client.sendVoIP(device, call);
  await client.sendVoIP(device, call);

  assert.equal(requests.length, 2);
  assert.equal(
    requests[0].url,
    `https://api.sandbox.push.apple.com/3/device/${device.device_token}`,
  );
  assert.equal(requests[0].init.headers["apns-topic"], "com.chirag.agentcaller.voip");
  assert.equal(requests[0].init.headers["apns-push-type"], "voip");
  assert.equal(requests[0].init.headers["apns-id"], call.id);
  assert.ok(requests[0].init.signal instanceof AbortSignal);
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    call_id: call.id,
    caller_name: "Hermes",
    message: "Wake up",
    mode: "live_voice",
  });
  assert.equal(
    requests[0].init.headers.authorization,
    requests[1].init.headers.authorization,
  );

  const token = requests[0].init.headers.authorization.replace("bearer ", "");
  const [header, claims, signature] = token.split(".");
  assert.deepEqual(decodeJSON(header), { alg: "ES256", kid: "KEYID12345" });
  assert.deepEqual(decodeJSON(claims), {
    iss: "TEAMID1234",
    iat: Date.parse("2026-07-27T12:00:00Z") / 1000,
  });
  assert.equal(
    await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      keys.publicKey,
      decodeBase64url(signature),
      new TextEncoder().encode(`${header}.${claims}`),
    ),
    true,
  );
});

test("sends one-way messages as standard APNs alerts", async () => {
  const keys = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const privateKey = await crypto.subtle.exportKey("pkcs8", keys.privateKey);
  const requests = [];
  const client = new APNsClient({
    APNS_TEAM_ID: "TEAMID1234",
    APNS_KEY_ID: "KEYID12345",
    APNS_PRIVATE_KEY: pem(privateKey),
    APNS_BUNDLE_ID: "com.chirag.agentcaller",
  }, {
    fetcher: async (url, init) => {
      requests.push({ url, init });
      return new Response(null, { status: 200 });
    },
  });
  const device = {
    environment: "production",
    device_token: "ab".repeat(32),
    alert_device_token: "cd".repeat(32),
  };
  const message = {
    id: "123e4567-e89b-42d3-a456-426614174000",
    caller_name: "Hermes",
    message: "Wake up",
    mode: "message",
  };

  await client.sendAlert(device, message);

  assert.equal(requests[0].url, `https://api.push.apple.com/3/device/${device.alert_device_token}`);
  assert.equal(requests[0].init.headers["apns-topic"], "com.chirag.agentcaller");
  assert.equal(requests[0].init.headers["apns-push-type"], "alert");
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    aps: {
      alert: { title: "Hermes - AI agent", body: "Wake up" },
      sound: "default",
      "thread-id": "agentcall-messages",
    },
    event: "agent_message",
    message_id: message.id,
    caller_name: "Hermes",
  });
  await assert.rejects(() => client.sendVoIP(device, message), /live voice/);
  await assert.rejects(
    () => client.sendAlert(device, { ...message, mode: "live_voice" }),
    /VoIP delivery/,
  );
});

function pem(buffer) {
  const base64 = Buffer.from(buffer).toString("base64").match(/.{1,64}/g).join("\n");
  return `-----BEGIN PRIVATE KEY-----\n${base64}\n-----END PRIVATE KEY-----`;
}

function decodeJSON(value) {
  return JSON.parse(Buffer.from(value, "base64url").toString());
}

function decodeBase64url(value) {
  return Buffer.from(value, "base64url");
}
