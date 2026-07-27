import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeAudioContentType,
  safeFilename,
  validIdempotencyKey,
  validateCall,
  validateDevice,
} from "../src/core.js";

test("validates iOS device registration", () => {
  assert.equal(
    validateDevice({
      token: "ab".repeat(32),
      platform: "ios",
      environment: "sandbox",
      device_name: "Test iPhone",
    }),
    null,
  );
  assert.equal(
    validateDevice({ token: "bad", platform: "ios", environment: "sandbox" }),
    "invalid_device_token",
  );
});

test("normalizes a call and preserves its audio attachment", () => {
  const now = Date.parse("2026-07-27T12:00:00Z");
  const result = validateCall(
    {
      message: " Wake up ",
      caller_name: " PersonalClaw ",
      audio_id: "123e4567-e89b-42d3-a456-426614174000",
      scheduled_at: "2026-07-27T12:01:00Z",
    },
    now,
  );
  assert.deepEqual(result, {
    value: {
      message: "Wake up",
      callerName: "PersonalClaw",
      audioID: "123e4567-e89b-42d3-a456-426614174000",
      scheduledAt: now + 60_000,
    },
  });
});

test("rejects invalid call and upload inputs", () => {
  assert.equal(validateCall({ message: "" }).error, "message_must_be_1_to_500_characters");
  assert.equal(validateCall({ message: "ok", scheduled_at: "later" }).error, "scheduled_at_must_be_iso_8601");
  assert.equal(validIdempotencyKey("short"), false);
  assert.equal(validIdempotencyKey("stable-event-key"), true);
  assert.equal(normalizeAudioContentType(" Audio/MPEG; charset=binary "), "audio/mpeg");
  assert.equal(safeFilename("../../hello\u0000.m4a"), "hello.m4a");
});
