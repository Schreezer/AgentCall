import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Store } from "../src/store.js";
import { CallWorker } from "../src/worker.js";

function makeStore(options) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "caller-relay-"));
  return new Store(path.join(directory, "state.json"), options);
}

const device = {
  token: "a".repeat(64),
  platform: "ios",
  environment: "sandbox",
  device_name: "iPhone",
};

test("installation pairing issues a scoped agent token and consumes the code", () => {
  const store = makeStore();
  const created = store.createInstallation(device);
  const claimed = store.claimPairingCode(created.installation.pairingCode);
  assert.equal(claimed.installationID, created.installation.id);
  assert.equal(store.findInstallationByAgentToken(claimed.agentToken).id, created.installation.id);
  assert.equal(store.claimPairingCode(created.installation.pairingCode), null);
  const status = store.getInstallation(created.installation.id, created.installationSecret);
  assert.equal(status.paired, true);
  assert.equal(status.pairingCode, null);
});

test("expired pairing codes cannot be claimed", async () => {
  const store = makeStore({ pairingTTLSeconds: 0.001 });
  const created = store.createInstallation(device);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(store.claimPairingCode(created.installation.pairingCode), null);
});

test("installation credential updates only its own device", () => {
  const store = makeStore();
  const first = store.createInstallation(device);
  const second = store.createInstallation({ ...device, token: "b".repeat(64) });
  assert.equal(store.updateDevice(first.installation.id, second.installationSecret, device), null);
  const updated = store.updateDevice(first.installation.id, first.installationSecret, {
    ...device,
    device_name: "Renamed iPhone",
  });
  assert.equal(updated.device.device_name, "Renamed iPhone");
});

test("installation deletion revokes the agent and removes its queued calls", () => {
  const store = makeStore();
  const created = store.createInstallation(device);
  const claimed = store.claimPairingCode(created.installation.pairingCode);
  const call = store.createCall(created.installation.id, {
    callerName: "Hermes",
    message: "Old relay call",
    scheduledAt: new Date().toISOString(),
  }, "old-relay-call");

  assert.equal(store.deleteInstallation(created.installation.id, "wrong-secret"), false);
  assert.equal(store.deleteInstallation(created.installation.id, created.installationSecret), true);
  assert.equal(store.getInstallation(created.installation.id, created.installationSecret), null);
  assert.equal(store.findInstallationByAgentToken(claimed.agentToken), null);
  assert.equal(store.getCall(call.call.id, created.installation.id), null);
});

test("call idempotency is scoped to one installation", () => {
  const store = makeStore();
  const one = store.createInstallation(device).installation;
  const two = store.createInstallation({ ...device, token: "b".repeat(64) }).installation;
  const input = { callerName: "Hermes", message: "Wake up", scheduledAt: new Date().toISOString() };
  const first = store.createCall(one.id, input, "wake-up-1");
  const duplicate = store.createCall(one.id, input, "wake-up-1");
  const otherUser = store.createCall(two.id, input, "wake-up-1");
  assert.equal(first.created, true);
  assert.equal(duplicate.created, false);
  assert.equal(otherUser.created, true);
  assert.equal(first.call.id, duplicate.call.id);
  assert.notEqual(first.call.id, otherUser.call.id);
});

test("worker delivers a due call only to its paired installation", async () => {
  const store = makeStore();
  const target = store.createInstallation(device).installation;
  store.createInstallation({ ...device, token: "b".repeat(64) });
  const { call } = store.createCall(target.id, {
    callerName: "Hermes",
    message: "Go",
    scheduledAt: new Date(0).toISOString(),
  }, "go-now");
  const deliveries = [];
  const apns = { configured: true, sendVoIP: async (registeredDevice, dueCall) => deliveries.push([registeredDevice.token, dueCall.id]) };
  const worker = new CallWorker(store, apns);
  await worker.tick();
  assert.deepEqual(deliveries, [[device.token, call.id]]);
  assert.equal(store.getCall(call.id, target.id).status, "delivered");
});
