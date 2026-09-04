import { env, exports } from "cloudflare:workers";
import { runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { hashCredential } from "../src/core.js";

describe("Hosted agent", () => {
  it("enables the built-in assistant, chats over SSE, and persists history", async () => {
    const { installationID, secret } = await registerInstallation();

    const before = await requestJSON(`/v1/installations/${installationID}/agent/status`, { token: secret });
    expect(before.status).toBe(409);
    expect(before.body.error).toBe("hosted_agent_disabled");

    const enabled = await requestJSON(`/v1/installations/${installationID}/agent/enable`, {
      method: "POST",
      token: secret,
      body: { timezone: "America/New_York", display_name: "Sol" },
    });
    expect(enabled.status).toBe(200);
    expect(enabled.body.agent_mode).toBe("hosted");
    expect(enabled.body.agent.settings.timezone).toBe("America/New_York");
    expect(enabled.body.agent.settings.displayName).toBe("Sol");

    const installation = await requestJSON(`/v1/installations/${installationID}`, { token: secret });
    expect(installation.body.agent_mode).toBe("hosted");

    const events = await chat(installationID, secret, "hello there");
    expect(events.map((event) => event.type)).toContain("text");
    const done = events.find((event) => event.type === "done");
    expect(done.text).toBe("Hello from your assistant.");

    const history = await requestJSON(`/v1/installations/${installationID}/agent/messages`, { token: secret });
    expect(history.status).toBe(200);
    expect(history.body.messages.map((message) => [message.role, message.text])).toEqual([
      ["user", "hello there"],
      ["assistant", "Hello from your assistant."],
    ]);
  });

  it("places a live voice call through the shared call pipeline when asked", async () => {
    const { installationID, secret } = await enableHostedInstallation();

    const events = await chat(installationID, secret, "CALL_ME please");
    const toolEvents = events.filter((event) => event.type === "tool");
    expect(toolEvents[0]).toMatchObject({ name: "place_call", status: "running" });
    expect(toolEvents[1]).toMatchObject({ name: "place_call", status: "done" });
    expect(events.at(-1)).toMatchObject({ type: "done", text: "Done, I took care of it." });

    const call = await env.DB.prepare(
      "SELECT * FROM calls WHERE installation_id = ?1 ORDER BY created_at DESC LIMIT 1",
    ).bind(installationID).first();
    expect(call.mode).toBe("live_voice");
    expect(call.caller_name).toBe("Caller");
    expect(call.origin_hermes_session_id).toBe(`hosted:${installationID}`);
    expect(JSON.parse(call.call_context_json)).toMatchObject({
      reason: "The user asked for a call",
      opening_question: "How are you doing right now?",
    });

    const status = await requestJSON(`/v1/installations/${installationID}/agent/status`, { token: secret });
    expect(status.body.usage.calls).toBe(1);
    expect(status.body.usage.turns).toBe(1);
  });

  it("blocks calls during quiet hours and reports the refusal to the model", async () => {
    const { installationID, secret } = await enableHostedInstallation();
    const settings = await requestJSON(`/v1/installations/${installationID}/agent/settings`, {
      method: "PUT",
      token: secret,
      body: { quiet_start: "00:00", quiet_end: "23:59", timezone: "UTC" },
    });
    expect(settings.status).toBe(200);

    const events = await chat(installationID, secret, "CALL_ME now");
    expect(events.find((event) => event.type === "tool" && event.status !== "running")).toMatchObject({
      name: "place_call",
      status: "failed",
    });
    expect(events.at(-1)).toMatchObject({ type: "done", text: "That did not work; I can try later." });

    const calls = await env.DB.prepare("SELECT COUNT(*) AS count FROM calls WHERE installation_id = ?1")
      .bind(installationID).first();
    expect(Number(calls.count)).toBe(0);
    const status = await requestJSON(`/v1/installations/${installationID}/agent/status`, { token: secret });
    expect(status.body.usage.calls).toBe(0);
  });

  it("creates, lists, and cancels schedules", async () => {
    const { installationID, secret } = await enableHostedInstallation();

    const events = await chat(installationID, secret, "SCHEDULE_ME every morning");
    expect(events.find((event) => event.type === "tool" && event.status === "done")).toMatchObject({
      name: "create_schedule",
    });

    const listed = await requestJSON(`/v1/installations/${installationID}/agent/schedules`, { token: secret });
    expect(listed.status).toBe(200);
    expect(listed.body.schedules).toHaveLength(1);
    expect(listed.body.schedules[0]).toMatchObject({
      label: "Morning check-in",
      type: "cron",
      cron: "0 12 * * *",
    });
    expect(Date.parse(listed.body.schedules[0].next_run_at)).toBeGreaterThan(Date.now() - 60_000);

    const removed = await exports.default.fetch(
      `https://relay.test/v1/installations/${installationID}/agent/schedules/${listed.body.schedules[0].id}`,
      { method: "DELETE", headers: { authorization: `Bearer ${secret}` } },
    );
    expect(removed.status).toBe(204);
    const after = await requestJSON(`/v1/installations/${installationID}/agent/schedules`, { token: secret });
    expect(after.body.schedules).toHaveLength(0);
  });

  it("remembers notes and lists them", async () => {
    const { installationID, secret } = await enableHostedInstallation();
    await chat(installationID, secret, "REMEMBER_ME this");
    const memories = await requestJSON(`/v1/installations/${installationID}/agent/memories`, { token: secret });
    expect(memories.body.memories.map((memory) => memory.note)).toEqual(["The user drinks tea, not coffee."]);
  });

  it("answers voice-agent questions through the MCP tools and streams the event to the phone", async () => {
    const { installationID, secret } = await enableHostedInstallation();
    const now = Date.now();
    const callID = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO calls
        (id, installation_id, caller_name, message, scheduled_at, status, idempotency_key,
         created_at, delivery_errors, mode, call_context_json, origin_hermes_session_id, request_hash)
       VALUES (?1, ?2, 'Caller', 'Check-in', ?3, 'delivered', ?4, ?3, '[]',
               'live_voice', ?5, ?6, 'hash')`,
    ).bind(callID, installationID, now, `hosted-${callID}`, JSON.stringify({ reason: "Check-in" }), `hosted:${installationID}`).run();

    const bootstrap = await requestJSON(
      `/v1/installations/${installationID}/calls/${callID}/voice-bootstrap`,
      { method: "POST", token: secret, body: {} },
    );
    expect(bootstrap.status).toBe(200);
    expect(bootstrap.body.provider).toBe("xai");
    expect(bootstrap.body.session.tools[0].server_label).toBe("assistant");
    expect(bootstrap.body.session.instructions).toContain("the user's assistant");

    const voiceSessionID = bootstrap.body.voice_session_id;
    const mcpToken = "hosted-voice-tool-token";
    await env.DB.prepare("UPDATE voice_sessions SET mcp_token_hash = ?2 WHERE id = ?1")
      .bind(voiceSessionID, await hashCredential(mcpToken)).run();

    const asked = await mcpRequest({
      id: 1,
      method: "tools/call",
      params: {
        name: "ask_hermes",
        arguments: { request: "When is my next appointment?", context_scope: "origin" },
      },
    }, mcpToken);
    expect(asked.status).toBe(200);
    const accepted = asked.body.result.structuredContent;
    expect(accepted).toMatchObject({ status: "queued", completion_delivery: "caller_events" });
    expect(accepted.operation_id).toMatch(/^voiceop_[0-9a-f]{32}$/);

    const replayed = await mcpRequest({
      id: 1,
      method: "tools/call",
      params: {
        name: "ask_hermes",
        arguments: { request: "When is my next appointment?", context_scope: "origin" },
      },
    }, mcpToken);
    expect(replayed.body.result.structuredContent.operation_id).toBe(accepted.operation_id);

    const agent = env.HOSTED_AGENT.getByName(installationID);
    await vi.waitFor(async () => {
      await runDurableObjectAlarm(agent);
      const row = await env.DB.prepare("SELECT status FROM hermes_operations WHERE id = ?1")
        .bind(accepted.operation_id).first();
      expect(row.status).toBe("answered");
    }, { timeout: 10_000, interval: 100 });

    const events = await requestJSON(
      `/v1/installations/${installationID}/voice-sessions/${voiceSessionID}/hermes-events?after=0`,
      { token: secret },
    );
    expect(events.body.events).toEqual([
      expect.objectContaining({
        operation_id: accepted.operation_id,
        status: "answered",
        answer: "Your next appointment is at three.",
      }),
    ]);

    const checked = await mcpRequest({
      id: 2,
      method: "tools/call",
      params: { name: "check_hermes_task", arguments: { operation_id: accepted.operation_id } },
    }, mcpToken);
    expect(checked.body.result.structuredContent).toMatchObject({
      status: "answered",
      answer: "Your next appointment is at three.",
    });
  });

  it("disables the assistant and wipes its state", async () => {
    const { installationID, secret } = await enableHostedInstallation();
    await chat(installationID, secret, "REMEMBER_ME this");

    const disabled = await exports.default.fetch(
      `https://relay.test/v1/installations/${installationID}/agent`,
      { method: "DELETE", headers: { authorization: `Bearer ${secret}` } },
    );
    expect(disabled.status).toBe(204);

    const installation = await requestJSON(`/v1/installations/${installationID}`, { token: secret });
    expect(installation.body.agent_mode).toBe("external");
    const blocked = await requestJSON(`/v1/installations/${installationID}/agent/memories`, { token: secret });
    expect(blocked.status).toBe(409);

    const reenabled = await requestJSON(`/v1/installations/${installationID}/agent/enable`, {
      method: "POST",
      token: secret,
      body: {},
    });
    expect(reenabled.status).toBe(200);
    const memories = await requestJSON(`/v1/installations/${installationID}/agent/memories`, { token: secret });
    expect(memories.body.memories).toEqual([]);
  });
});

async function registerInstallation() {
  const registration = await requestJSON("/v1/installations", {
    method: "POST",
    body: {
      token: "ab".repeat(32),
      alert_token: "cd".repeat(32),
      platform: "ios",
      environment: "sandbox",
      device_name: "Hosted test iPhone",
    },
  });
  expect(registration.status).toBe(201);
  return {
    installationID: registration.body.installation_id,
    secret: registration.body.installation_secret,
  };
}

async function enableHostedInstallation() {
  const installation = await registerInstallation();
  const enabled = await requestJSON(`/v1/installations/${installation.installationID}/agent/enable`, {
    method: "POST",
    token: installation.secret,
    body: { timezone: "UTC" },
  });
  expect(enabled.status).toBe(200);
  return installation;
}

async function chat(installationID, secret, message) {
  const response = await exports.default.fetch(
    `https://relay.test/v1/installations/${installationID}/agent/chat`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify({ message }),
    },
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  const text = await response.text();
  return text
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)));
}

async function requestJSON(path, { method = "GET", body, token } = {}) {
  const headers = new Headers();
  if (body !== undefined) headers.set("content-type", "application/json");
  if (token) headers.set("authorization", `Bearer ${token}`);
  const response = await exports.default.fetch(`https://relay.test${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function mcpRequest(body, token) {
  const headers = new Headers({
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    authorization: `Bearer ${token}`,
  });
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
