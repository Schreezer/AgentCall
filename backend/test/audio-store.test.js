import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AudioStore } from "../src/audio-store.js";

function makeAudioStore(options) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "caller-audio-"));
  return new AudioStore(directory, options);
}

test("audio upload is installation-scoped and idempotent", () => {
  const store = makeAudioStore();
  const input = {
    data: Buffer.from("audio bytes"),
    contentType: "audio/mpeg",
    filename: "speech.mp3",
    idempotencyKey: "reminder-1-audio",
  };
  const first = store.save("installation-1", input);
  const duplicate = store.save("installation-1", input);

  assert.equal(first.created, true);
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.audio.id, first.audio.id);
  assert.equal(store.read(first.audio.id, "installation-2"), null);
  assert.deepEqual(store.read(first.audio.id, "installation-1").data, input.data);
});

test("expired audio is deleted and unavailable", () => {
  let now = Date.parse("2026-07-14T00:00:00Z");
  const store = makeAudioStore({ ttlSeconds: 60, now: () => now });
  const { audio } = store.save("installation-1", {
    data: Buffer.from("audio bytes"),
    contentType: "audio/mp4",
    filename: "speech.m4a",
    idempotencyKey: "reminder-2-audio",
  });

  now += 61_000;
  assert.equal(store.metadata(audio.id, "installation-1"), null);
  assert.equal(store.read(audio.id, "installation-1"), null);
});

test("audio uploads enforce format and size limits", () => {
  const store = makeAudioStore({ maxBytes: 4 });
  assert.throws(
    () => store.save("installation-1", {
      data: Buffer.from("12345"),
      contentType: "audio/mpeg",
      idempotencyKey: "large-audio",
    }),
    { code: "BODY_TOO_LARGE" },
  );
  assert.throws(
    () => store.save("installation-1", {
      data: Buffer.from("1234"),
      contentType: "text/plain",
      idempotencyKey: "wrong-format",
    }),
    { code: "UNSUPPORTED_AUDIO_TYPE" },
  );
});
