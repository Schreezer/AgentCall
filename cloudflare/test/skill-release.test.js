import assert from "node:assert/strict";
import { createHash, createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { releaseMetadata, withSkillReleaseHeaders } from "../src/skill-release.js";

test("ships a complete hash-verified and Ed25519-signed urgent-caller release", () => {
  const release = releaseMetadata();
  assert.equal(release.manifest.skill_name, "urgent-caller");
  assert.equal(release.manifest.skill_version, "0.4.1");
  assert.equal(release.manifest.change_class, "compatible");
  assert.equal(release.manifest.requires_user_approval, false);

  for (const entry of release.manifest.files) {
    const content = release.files[entry.path];
    assert.equal(Buffer.byteLength(content), entry.size);
    assert.equal(createHash("sha256").update(content).digest("hex"), entry.sha256);
  }
  assert.equal(
    release.bootstrapSha256,
    createHash("sha256").update(release.bootstrap).digest("hex"),
  );
  const swiftInstructions = readFileSync(
    new URL("../../ios/AgentCaller/AgentSetupInstructions.swift", import.meta.url),
    "utf8",
  );
  const setupPrompt = readFileSync(new URL("../../HERMES_CALLER_SETUP_PROMPT.md", import.meta.url), "utf8");
  assert.match(swiftInstructions, new RegExp(`bootstrapSHA256 = "${release.bootstrapSha256}"`));
  assert.ok(setupPrompt.includes(release.bootstrapSha256));

  const keyMatch = release.files["scripts/update.py"].match(
    /TRUSTED_RELEASE_PUBLIC_KEY = """(-----BEGIN PUBLIC KEY-----[\s\S]+?-----END PUBLIC KEY-----)"""/,
  );
  assert.ok(keyMatch, "generated updater must contain the pinned public key");
  assert.equal(
    verify(
      null,
      Buffer.from(canonicalJSON(release.manifest)),
      createPublicKey(keyMatch[1]),
      Buffer.from(release.signature, "base64"),
    ),
    true,
  );
});

test("advertises compatible, available, and required skill update states", async () => {
  const current = withSkillReleaseHeaders(new Response("ok"), requestWithVersion("0.4.1"));
  assert.equal(current.headers.get("x-caller-skill-update"), "current");

  const available = withSkillReleaseHeaders(new Response("ok"), requestWithVersion("0.3.0"));
  assert.equal(available.headers.get("x-caller-skill-update"), "available");

  const required = withSkillReleaseHeaders(new Response("ok"), requestWithVersion("0.2.0"));
  assert.equal(required.headers.get("x-caller-skill-update"), "required");
  assert.equal(await required.text(), "ok");
});

function requestWithVersion(version) {
  return new Request("https://relay.test", { headers: { "x-caller-skill-version": version } });
}

function canonicalJSON(value) {
  return JSON.stringify(sortValue(value));
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])]));
  }
  return value;
}
