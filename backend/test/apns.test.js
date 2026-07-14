import assert from "node:assert/strict";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import test from "node:test";
import { APNsClient } from "../src/apns.js";

test("VoIP delivery uses the correct APNs host, headers, and minimal payload", async () => {
  const observed = {};
  const connect = (host, options) => {
    observed.host = host;
    observed.connectOptions = options;
    const client = new EventEmitter();
    client.close = () => {};
    client.request = (headers) => {
      observed.headers = headers;
      const request = new EventEmitter();
      request.setEncoding = () => {};
      request.end = (payload) => {
        observed.payload = JSON.parse(payload);
        queueMicrotask(() => {
          request.emit("response", { ":status": 200 });
          request.emit("end");
        });
      };
      return request;
    };
    return client;
  };
  const { privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const client = new APNsClient({
    teamID: "TEAMID1234",
    keyID: "KEYID12345",
    privateKey,
    bundleID: "com.chirag.agentcaller",
    connect,
  });

  await client.sendVoIP(
    { token: "a".repeat(64), environment: "sandbox" },
    { id: "call-id", callerName: "Hermes", message: "Wake up", audioID: "audio-id" },
  );

  assert.equal(observed.host, "https://api.sandbox.push.apple.com");
  assert.deepEqual(observed.connectOptions, { family: 4 });
  assert.equal(observed.headers[":path"], `/3/device/${"a".repeat(64)}`);
  assert.equal(observed.headers["apns-topic"], "com.chirag.agentcaller.voip");
  assert.equal(observed.headers["apns-push-type"], "voip");
  assert.equal(observed.headers["apns-priority"], "10");
  assert.equal(observed.headers["apns-expiration"], "0");
  assert.match(observed.headers.authorization, /^bearer /);
  assert.deepEqual(observed.payload, {
    call_id: "call-id",
    caller_name: "Hermes",
    message: "Wake up",
    audio_id: "audio-id",
  });
});
