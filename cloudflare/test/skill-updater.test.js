import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { releaseMetadata } from "../src/skill-release.js";

test("the pinned bootstrap verifies and atomically installs the signed skill", async () => {
  const fixture = await updaterFixture(false);
  try {
    const result = await runPython(fixture.bootstrapPath, [
      "--relay-url", fixture.baseURL,
      "--env-file", fixture.envPath,
      "--skill-dir", fixture.skillPath,
    ]);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      status: "updated",
      installed_version: "0.4.0",
      previous_version: "0.0.0",
    });
    const state = JSON.parse(await readFile(join(fixture.skillPath, ".caller-release.json"), "utf8"));
    assert.equal(state.skill_version, "0.4.0");
    assert.match(await readFile(join(fixture.skillPath, "SKILL.md"), "utf8"), /keep the skill current/i);

    const check = await runPython(join(fixture.skillPath, "scripts/update.py"), [
      "--relay-url", fixture.baseURL,
      "--env-file", fixture.envPath,
      "--skill-dir", fixture.skillPath,
      "--check-only",
    ]);
    assert.equal(check.code, 0, check.stderr);
    assert.equal(JSON.parse(check.stdout).status, "current");
  } finally {
    await fixture.close();
  }
});

test("the bootstrap rejects a manifest changed after signing", async () => {
  const fixture = await updaterFixture(true);
  try {
    const result = await runPython(fixture.bootstrapPath, [
      "--relay-url", fixture.baseURL,
      "--env-file", fixture.envPath,
      "--skill-dir", fixture.skillPath,
    ]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /signature verification failed/);
    await assert.rejects(readFile(join(fixture.skillPath, "SKILL.md")));
  } finally {
    await fixture.close();
  }
});

async function updaterFixture(tamperManifest) {
  const release = releaseMetadata();
  const root = await mkdtemp(join(tmpdir(), "caller-updater-test-"));
  const envPath = join(root, "hermes.env");
  const bootstrapPath = join(root, "bootstrap.py");
  const skillPath = join(root, "skills", "urgent-caller");
  await writeFile(envPath, "CALLER_AGENT_TOKEN=test-agent-token\n", { mode: 0o600 });
  await writeFile(bootstrapPath, release.bootstrap, { mode: 0o700 });

  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (request.headers.authorization !== "Bearer test-agent-token") {
      response.writeHead(401, { "content-type": "application/json" });
      return response.end(JSON.stringify({ error: "invalid_agent_credential" }));
    }
    if (url.pathname === "/v1/agent-package/urgent-caller/manifest") {
      const manifest = tamperManifest
        ? { ...release.manifest, release_notes: `${release.manifest.release_notes} tampered` }
        : release.manifest;
      response.writeHead(200, { "content-type": "application/json" });
      return response.end(JSON.stringify({ manifest, signature: release.signature }));
    }
    const match = url.pathname.match(
      /^\/v1\/agent-package\/urgent-caller\/files\/(\d+\.\d+\.\d+)\/(.+)$/,
    );
    if (match && match[1] === release.manifest.skill_version) {
      const path = match[2].split("/").map(decodeURIComponent).join("/");
      if (Object.hasOwn(release.files, path)) {
        response.writeHead(200, { "content-type": "application/octet-stream" });
        return response.end(release.files[path]);
      }
    }
    response.writeHead(404, { "content-type": "application/json" });
    return response.end(JSON.stringify({ error: "not_found" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseURL = `http://127.0.0.1:${address.port}`;
  await writeFile(envPath, `CALLER_RELAY_URL=${baseURL}\nCALLER_AGENT_TOKEN=test-agent-token\n`, { mode: 0o600 });
  return {
    baseURL,
    bootstrapPath,
    envPath,
    skillPath,
    async close() {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await rm(root, { recursive: true, force: true });
    },
  };
}

function runPython(script, argumentsList) {
  return new Promise((resolve, reject) => {
    const child = spawn("python3", [script, ...argumentsList], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() }));
  });
}
