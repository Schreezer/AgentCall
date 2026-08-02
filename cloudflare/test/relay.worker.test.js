import { env, exports } from "cloudflare:workers";
import {
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { hashCredential } from "../src/core.js";

describe("Cloudflare relay", () => {
  it("runs registration, pairing, audio, idempotency, and alarm delivery", async () => {
    const health = await exports.default.fetch("https://relay.test/health");
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({
      ok: true,
      storageReady: true,
      apnsReady: true,
    });

    const registration = await requestJSON("/v1/installations", {
      method: "POST",
      body: {
        token: "ab".repeat(32),
        platform: "ios",
        environment: "sandbox",
        device_name: "Workers test",
      },
    });
    expect(registration.status).toBe(201);

    const pairing = await requestJSON("/v1/pairings/claim", {
      method: "POST",
      body: { pairing_code: registration.body.pairing_code },
    });
    expect(pairing.status).toBe(200);

    const audioUpload = await exports.default.fetch("https://relay.test/v1/audio", {
      method: "POST",
      headers: {
        authorization: `Bearer ${pairing.body.agent_token}`,
        "content-type": "audio/mpeg",
        "idempotency-key": "workers-audio-test-0001",
        "x-audio-filename": "hello.mp3",
      },
      body: new Uint8Array([73, 68, 51, 4, 0, 0, 0, 0]),
    });
    expect(audioUpload.status).toBe(201);
    const audio = await audioUpload.json();

    const downloaded = await exports.default.fetch(
      `https://relay.test/v1/installations/${registration.body.installation_id}/audio/${audio.audio_id}`,
      {
        headers: {
          authorization: `Bearer ${registration.body.installation_secret}`,
        },
      },
    );
    expect(downloaded.status).toBe(200);
    expect(downloaded.headers.get("content-type")).toBe("audio/mpeg");
    expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(
      new Uint8Array([73, 68, 51, 4, 0, 0, 0, 0]),
    );

    const callInput = {
      message: "Workers runtime delivery test",
      caller_name: "Test",
      audio_id: audio.audio_id,
      scheduled_at: new Date(Date.now() + 60_000).toISOString(),
    };
    const first = await requestJSON("/v1/calls", {
      method: "POST",
      token: pairing.body.agent_token,
      idempotencyKey: "workers-call-test-0001",
      body: callInput,
    });
    const second = await requestJSON("/v1/calls", {
      method: "POST",
      token: pairing.body.agent_token,
      idempotencyKey: "workers-call-test-0001",
      body: callInput,
    });
    expect(first.status).toBe(202);
    expect(second.status).toBe(200);
    expect(second.body.id).toBe(first.body.id);
    expect(first.body.status).toBe("scheduled");

    await env.DB.prepare("UPDATE calls SET scheduled_at = ?2 WHERE id = ?1")
      .bind(first.body.id, Date.now() - 1)
      .run();
    const scheduler = env.SCHEDULER.getByName(registration.body.installation_id);
    expect(await runDurableObjectAlarm(scheduler)).toBe(true);

    const terminal = await requestJSON(`/v1/calls/${first.body.id}`, {
      token: pairing.body.agent_token,
    });
    expect(terminal.status).toBe(200);
    expect(terminal.body.status).toBe("failed");
    expect(terminal.body.delivery_errors[0]).toMatch(/invalid base64|private key/i);

    const recovering = await requestJSON("/v1/calls", {
      method: "POST",
      token: pairing.body.agent_token,
      idempotencyKey: "workers-call-test-0002",
      body: {
        message: "Receipt recovery test",
        scheduled_at: new Date(Date.now() + 120_000).toISOString(),
      },
    });
    await env.DB.prepare(
      "UPDATE calls SET status = 'delivering', scheduled_at = ?2 WHERE id = ?1",
    )
      .bind(recovering.body.id, Date.now() - 1)
      .run();
    await runInDurableObject(scheduler, async (_instance, state) => {
      await state.storage.put(`apns-receipt:${recovering.body.id}`, {
        apnsID: recovering.body.id,
        deliveredAt: Date.now(),
      });
      await state.storage.setAlarm(Date.now() + 60_000);
    });
    expect(await runDurableObjectAlarm(scheduler)).toBe(true);
    const recovered = await requestJSON(`/v1/calls/${recovering.body.id}`, {
      token: pairing.body.agent_token,
    });
    expect(recovered.body.status).toBe("delivered");
  });

  it("authenticates the stateless MCP endpoint and preserves operation scope", async () => {
    const installationID = crypto.randomUUID();
    const callID = crypto.randomUUID();
    const voiceSessionID = crypto.randomUUID();
    const token = "mcp_test_token_123456789";
    const operationID = `voiceop_${"a".repeat(32)}`;
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO installations
          (id, installation_secret_hash, device_token, environment, created_at, updated_at)
         VALUES (?1, 'hash', ?2, 'sandbox', ?3, ?3)`,
      ).bind(installationID, "ab".repeat(32), now),
      env.DB.prepare(
        `INSERT INTO calls
          (id, installation_id, caller_name, message, scheduled_at, status, idempotency_key,
           created_at, delivery_errors, mode, call_context_json, origin_hermes_session_id, request_hash)
         VALUES (?1, ?2, 'Hermes', 'Reason', ?3, 'delivered', 'mcp-call', ?3, '[]',
                 'live_voice', '{}', 'origin-session', 'hash')`,
      ).bind(callID, installationID, now),
      env.DB.prepare(
        `INSERT INTO voice_sessions
          (id, installation_id, call_id, mcp_token_hash, origin_hermes_session_id, created_at, expires_at)
         VALUES (?1, ?2, ?3, ?4, 'origin-session', ?5, ?6)`,
      ).bind(voiceSessionID, installationID, callID, await hashCredential(token), now, now + 60_000),
      env.DB.prepare(
        `INSERT INTO hermes_operations
          (id, installation_id, call_id, voice_session_id, workflow_id, replay_key, request_hash,
           status, hermes_session_id, result_json, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?1, 'replay', 'hash', 'answered', 'origin-session', ?5, ?6, ?6)`,
      ).bind(operationID, installationID, callID, voiceSessionID, JSON.stringify({ answer: "Verified answer" }), now),
    ]);
    const coordinator = env.HERMES_COORDINATOR.getByName(installationID);
    await runInDurableObject(coordinator, async (_instance, state) => {
      await state.storage.put(`operation:${operationID}`, {
        id: operationID,
        installationID,
        callID,
        voiceSessionID,
        workflowID: operationID,
        replayKey: "replay",
        requestHash: "hash",
        status: "answered",
        hermesSessionID: "origin-session",
        result: { answer: "Verified answer" },
        createdAt: now,
        updatedAt: now,
      });
    });

    const unauthorized = await mcpRequest({
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } },
    });
    expect(unauthorized.status).toBe(401);

    const initialized = await mcpRequest({
      id: 2,
      method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } },
    }, token);
    expect(initialized.status).toBe(200);
    expect(initialized.body.result.serverInfo.name).toBe("caller-hermes");

    const listed = await mcpRequest({ id: 3, method: "tools/list", params: {} }, token);
    expect(listed.body.result.tools.map((tool) => tool.name)).toEqual([
      "ask_hermes",
      "check_hermes_task",
    ]);

    const checked = await mcpRequest({
      id: 4,
      method: "tools/call",
      params: { name: "check_hermes_task", arguments: { operation_id: operationID } },
    }, token);
    expect(checked.body.result.structuredContent).toMatchObject({
      status: "answered",
      answer: "Verified answer",
      hermes_session_id: "origin-session",
    });
  });

  it("mints a call-scoped xAI bootstrap without exposing permanent credentials", async () => {
    const registration = await requestJSON("/v1/installations", {
      method: "POST",
      body: {
        token: "cd".repeat(32),
        alert_token: "ef".repeat(32),
        platform: "ios",
        environment: "sandbox",
      },
    });
    const pairing = await requestJSON("/v1/pairings/claim", {
      method: "POST",
      body: { pairing_code: registration.body.pairing_code },
    });
    const call = await requestJSON("/v1/calls", {
      method: "POST",
      token: pairing.body.agent_token,
      idempotencyKey: "live-voice-call-test-01",
      body: {
        mode: "live_voice",
        message: "Hermes needs your decision",
        call_context: {
          reason: "A decision is due",
          relevant_context: "The relevant facts",
          desired_outcome: "Choose an option",
          urgency: "important",
        },
        origin_hermes_session_id: "session-origin-1",
      },
    });
    const bootstrap = await requestJSON(
      `/v1/installations/${registration.body.installation_id}/calls/${call.body.id}/voice-bootstrap`,
      { method: "POST", token: registration.body.installation_secret, body: {} },
    );
    expect(bootstrap.status).toBe(200);
    expect(bootstrap.body.xai.ephemeral_token).toBe("ephemeral-only");
    expect(bootstrap.body.session.tools[0]).toMatchObject({
      type: "mcp",
      allowed_tools: ["ask_hermes", "check_hermes_task"],
    });
    expect(bootstrap.body.session.instructions).toContain("A decision is due");
    expect(JSON.stringify(bootstrap.body)).not.toContain("XAI_API_KEY");
  });
});

async function requestJSON(
  path,
  { method = "GET", body, token, idempotencyKey } = {},
) {
  const headers = new Headers();
  if (body !== undefined) headers.set("content-type", "application/json");
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (idempotencyKey) headers.set("idempotency-key", idempotencyKey);
  const response = await exports.default.fetch(`https://relay.test${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const jsonText = response.headers.get("content-type")?.includes("text/event-stream")
    ? text.split("\n").find((line) => line.startsWith("data: "))?.slice(6)
    : text;
  return { status: response.status, body: JSON.parse(jsonText) };
}

async function mcpRequest(body, token) {
  const headers = new Headers({
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
  });
  if (token) headers.set("authorization", `Bearer ${token}`);
  const response = await exports.default.fetch("https://relay.test/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", ...body }),
  });
  const text = await response.text();
  const jsonText = response.headers.get("content-type")?.includes("text/event-stream")
    ? text.split("\n").find((line) => line.startsWith("data: "))?.slice(6)
    : text;
  return { status: response.status, body: JSON.parse(jsonText) };
}
