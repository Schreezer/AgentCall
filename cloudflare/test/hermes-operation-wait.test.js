import assert from "node:assert/strict";
import test from "node:test";
import {
  awaitHermesOperation,
  configuredHermesWaitMs,
  isTerminalHermesStatus,
} from "../src/hermes-operation-wait.js";

test("waits for a terminal Hermes result and marks it for automatic delivery", async () => {
  const statuses = [
    { status: "running", operation_id: "voiceop_test" },
    { status: "answered", operation_id: "voiceop_test", answer: "Done" },
  ];
  const coordinator = {
    async operationStatus() {
      return statuses.shift();
    },
  };

  const result = await awaitHermesOperation(
    coordinator,
    { status: "queued", operation_id: "voiceop_test" },
    1_000,
    { sleep: async () => {}, initialDelayMs: 0, maxDelayMs: 0 },
  );

  assert.deepEqual(result, {
    status: "answered",
    operation_id: "voiceop_test",
    answer: "Done",
    completion_delivery: "automatic",
  });
});

test("returns an explicit fallback when the automatic wait is disabled", async () => {
  const result = await awaitHermesOperation(
    { operationStatus: async () => assert.fail("should not poll") },
    { status: "queued", operation_id: "voiceop_test" },
    0,
  );

  assert.equal(result.status, "queued");
  assert.equal(result.completion_delivery, "manual_fallback");
  assert.match(result.summary, /check_hermes_task/);
});

test("bounds wait configuration and recognizes terminal states", () => {
  assert.equal(configuredHermesWaitMs(undefined), 45_000);
  assert.equal(configuredHermesWaitMs("invalid"), 45_000);
  assert.equal(configuredHermesWaitMs(-1), 0);
  assert.equal(configuredHermesWaitMs(120_000), 90_000);
  assert.equal(isTerminalHermesStatus("needs_external_approval"), true);
  assert.equal(isTerminalHermesStatus("running"), false);
});
