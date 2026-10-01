import { env } from "cloudflare:workers";
import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPstnCall, handleInboundCallback } from "../src/index.js";

const AGENT = "test-hermes-token-32-chars-long-value";
const BRIDGE = "test-bridge-token-32-chars-long-value";
const DID = "+918071580171";
const CALLER = "+919000000001";
const ANSWER_PATH = "/v1/vobiz/inbound/answer";
const HANGUP_PATH = "/v1/vobiz/inbound/hangup";
const CALLBACK_TOKEN = "AbCDefGHijKLmnopQRSTuvWXyz0123456789_-abcdc";
const TOKEN_ANSWER_PATH = `${ANSWER_PATH}/${CALLBACK_TOKEN}`;
const TOKEN_HANGUP_PATH = `${HANGUP_PATH}/${CALLBACK_TOKEN}`;

function unsignedCallback(path, event, callUUID = crypto.randomUUID(), overrides = {}) {
  return new Request(`https://relay.example${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      Event: event, CallUUID: callUUID, Direction: "inbound", From: CALLER,
      To: DID, auth_id: "test-auth", ...overrides,
    }),
  });
}

async function signedCallback(path, event, nonce, overrides = {}, options = {}) {
  const fields = {
    Event: event,
    CallUUID: options.callUUID || "550e8400-e29b-41d4-a716-446655440000",
    Direction: "inbound",
    From: CALLER,
    To: DID,
    auth_id: "test-auth",
    ...overrides,
  };
  return signedCallbackWithParams(path, nonce, new URLSearchParams(fields), options);
}

async function signedCallbackWithParams(path, nonce, body, options = {}) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode("test-vobiz-auth-token"),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const version = options.version || "v3";
  const message = `https://relay.example${path}${version === "v3" ? "." : ""}${nonce}`;
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return new Request(`https://relay.example${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      [`x-vobiz-signature-${version}`]: btoa(String.fromCharCode(...new Uint8Array(signature))),
      [`x-vobiz-signature-${version}-nonce`]: nonce,
    },
    body,
  });
}

const healthyBridge = async (input) => {
  expect(new URL(input).toString()).toBe("https://bridge.example/health");
  return Response.json({ ok: true, codex_ready: true, inbound_enabled: true });
};

const enabledEnv = () => ({ ...env, VOBIZ_INBOUND_ENABLED: "true" });
const disabledEnv = () => ({ ...env, VOBIZ_INBOUND_ENABLED: "false" });

describe("signed Vobiz inbound relay", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM vobiz_callback_nonces").run();
    await env.DB.prepare("DELETE FROM vobiz_inbound_callback_nonces").run();
    await env.DB.prepare("DELETE FROM vobiz_caller_notification_outbox").run();
    await env.DB.prepare("DELETE FROM vobiz_inbound_calls").run();
    await env.DB.prepare("DELETE FROM vobiz_pstn_calls").run();
  });

  it("proves a signed callback while disabled, blocks unsigned traffic, and starts no media", async () => {
    const unsigned = await SELF.fetch("https://relay.example" + ANSWER_PATH, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ Event: "StartApp", CallUUID: crypto.randomUUID(),
        Direction: "inbound", To: DID, auth_id: "test-auth" }),
    });
    expect(unsigned.status).toBe(403);
    const callback = await signedCallback(ANSWER_PATH, "StartApp", "12345678901234567890");
    const response = await handleInboundCallback(callback, disabledEnv(), "answer", healthyBridge);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("<Hangup/>");
    const inbox = await SELF.fetch("https://relay.example/v1/inbound-calls", {
      headers: { authorization: `Bearer ${AGENT}` },
    });
    expect(inbox.status).toBe(200);
    const calls = (await inbox.json()).calls;
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ direction: "inbound", status: "blocked_disabled",
      caller_number: null, called_number: DID, delivery_status: "unknown" });
    expect(calls[0]).not.toHaveProperty("inbound_report");
    expect((await SELF.fetch("https://relay.example/v1/inbound-calls")).status).toBe(401);
    const detail = await (await SELF.fetch(`https://relay.example/v1/inbound-calls/${calls[0].id}`, {
      headers: { authorization: `Bearer ${AGENT}` },
    })).json();
    expect(detail).toMatchObject({ status: "blocked_disabled", inbound_report: null,
      source_type: "unknown" });
    expect((await SELF.fetch(`https://relay.example/v1/vobiz/bridge/calls/${calls[0].id}`, {
      headers: { authorization: `Bearer ${BRIDGE}` },
    })).status).toBe(404);
  });

  it("rejects wrong account, direction, DID, event, and replay with changed form body", async () => {
    const local = enabledEnv();
    const invalidSignature = await signedCallback(ANSWER_PATH, "StartApp", "12345678901234567907",
      {}, { callUUID: crypto.randomUUID() });
    invalidSignature.headers.set("x-vobiz-signature-v3", btoa("invalid"));
    expect((await handleInboundCallback(invalidSignature, local, "answer", healthyBridge)).status).toBe(403);
    const oversized = await signedCallback(ANSWER_PATH, "StartApp", "12345678901234567908",
      { Extra: "x".repeat(17_000) }, { callUUID: crypto.randomUUID() });
    expect((await handleInboundCallback(oversized, local, "answer", healthyBridge)).status).toBe(403);
    const cases = [
      { auth_id: "wrong" },
      { Direction: "outbound" },
      { To: "+919999999999" },
      { Event: "Answer" },
    ];
    for (let index = 0; index < cases.length; index++) {
      const nonce = String(12345678901234567890n + BigInt(index));
      const result = await handleInboundCallback(
        await signedCallback(ANSWER_PATH, "StartApp", nonce, cases[index],
          { callUUID: crypto.randomUUID() }), local, "answer", healthyBridge,
      );
      expect(result.status).toBe(403);
    }
    const callUUID = crypto.randomUUID();
    const original = await handleInboundCallback(
      await signedCallback(ANSWER_PATH, "StartApp", "12345678901234567900", {}, { callUUID }),
      local, "answer", healthyBridge,
    );
    expect(original.status).toBe(200);
    const changedBody = await handleInboundCallback(
      await signedCallback(ANSWER_PATH, "StartApp", "12345678901234567900",
        { From: "+919999999999" }, { callUUID }), local, "answer", healthyBridge,
    );
    expect(changedBody.status).toBe(403);
    const retry = await handleInboundCallback(
      await signedCallback(ANSWER_PATH, "StartApp", "12345678901234567900", {}, { callUUID }),
      local, "answer", healthyBridge,
    );
    expect(retry.status).toBe(200);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM vobiz_inbound_calls").first()).count).toBe(1);
  });

  it("logs only a structured reason when verified inbound fields are rejected", async () => {
    const local = enabledEnv();
    const cases = [
      { reason: "event_missing", mutate: (params) => params.delete("Event") },
      { reason: "event_duplicate", mutate: (params) => params.append("Event", "StartApp") },
      { reason: "event_mismatch", mutate: (params) => params.set("Event", "Answer") },
      { reason: "direction_missing", mutate: (params) => params.delete("Direction") },
      { reason: "direction_duplicate", mutate: (params) => params.append("Direction", "inbound") },
      { reason: "direction_mismatch", mutate: (params) => params.set("Direction", "outbound") },
      { reason: "auth_id_missing", mutate: (params) => params.delete("auth_id") },
      { reason: "auth_id_duplicate", mutate: (params) => params.append("auth_id", "test-auth") },
      { reason: "auth_id_mismatch", mutate: (params) => params.set("auth_id", "wrong-account") },
      { reason: "call_uuid_missing", mutate: (params) => params.delete("CallUUID") },
      { reason: "call_uuid_duplicate", mutate: (params) => params.append("CallUUID", crypto.randomUUID()) },
      { reason: "call_uuid_invalid", mutate: (params) => params.set("CallUUID", "not-a-uuid") },
      { reason: "to_missing", mutate: (params) => params.delete("To") },
      { reason: "to_duplicate", mutate: (params) => params.append("To", DID) },
      { reason: "to_mismatch", mutate: (params) => params.set("To", "+919999999999") },
      { reason: "from_duplicate", mutate: (params) => params.append("From", "+919999999999") },
    ];
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (let index = 0; index < cases.length; index++) {
        const callUUID = crypto.randomUUID();
        const params = new URLSearchParams({ Event: "StartApp", CallUUID: callUUID,
          Direction: "inbound", From: CALLER, To: DID, auth_id: "test-auth" });
        cases[index].mutate(params);
        const response = await handleInboundCallback(
          await signedCallbackWithParams(ANSWER_PATH,
            String(12345678901234568000n + BigInt(index)), params),
          local, "answer", healthyBridge,
        );
        expect(response.status).toBe(403);
        const logged = warning.mock.calls.at(-1);
        expect(logged).toHaveLength(1);
        expect(JSON.parse(logged[0])).toEqual({
          event: "vobiz_inbound_callback_rejected",
          kind: "answer",
          reason: cases[index].reason,
        });
        expect(logged[0]).not.toContain(callUUID);
        expect(logged[0]).not.toContain(CALLER);
        expect(logged[0]).not.toContain(DID);
        expect(logged[0]).not.toContain(CALLBACK_TOKEN);
      }
      expect(warning).toHaveBeenCalledTimes(cases.length);
    } finally {
      warning.mockRestore();
    }
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM vobiz_inbound_calls").first()).count)
      .toBe(0);
  });

  it("logs privacy-safe reasons for inbound configuration and token precheck failures", async () => {
    const wrongToken = CALLBACK_TOKEN.slice(0, -1) + "g";
    const cases = [
      { reason: "inbound_config_missing", local: { ...enabledEnv(), VOBIZ_AUTH_ID: undefined },
        path: ANSWER_PATH, token: null, status: 503, error: "vobiz_inbound_not_configured" },
      { reason: "invalid_base_url", local: { ...enabledEnv(), VOBIZ_PUBLIC_BASE_URL: "http://relay.example" },
        path: ANSWER_PATH, token: null, status: 503, error: "vobiz_inbound_not_configured" },
      { reason: "invalid_bridge_url", local: { ...enabledEnv(), VOBIZ_BRIDGE_WSS_URL: "https://bridge.example/vobiz" },
        path: ANSWER_PATH, token: null, status: 503, error: "vobiz_inbound_not_configured" },
      { reason: "token_path_mismatch", local: enabledEnv(),
        path: TOKEN_HANGUP_PATH, token: CALLBACK_TOKEN, status: 403,
        error: "invalid_vobiz_callback" },
      { reason: "token_invalid", local: enabledEnv(),
        path: `${ANSWER_PATH}/${wrongToken}`, token: wrongToken, status: 403,
        error: "invalid_vobiz_callback" },
    ];
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (const testCase of cases) {
        const callUUID = crypto.randomUUID();
        const response = await handleInboundCallback(
          unsignedCallback(testCase.path, "StartApp", callUUID),
          testCase.local, "answer", healthyBridge, testCase.token,
        );
        expect(response.status).toBe(testCase.status);
        expect(await response.json()).toEqual({ error: testCase.error });
        const logged = warning.mock.calls.at(-1);
        expect(logged).toHaveLength(1);
        expect(JSON.parse(logged[0])).toEqual({
          event: "vobiz_inbound_callback_rejected",
          kind: "answer",
          reason: testCase.reason,
        });
        for (const sensitive of [CALLBACK_TOKEN, wrongToken, CALLER, DID,
          callUUID, "relay.example", "bridge.example"]) {
          expect(logged[0]).not.toContain(sensitive);
        }
      }
      expect(warning).toHaveBeenCalledTimes(cases.length);
    } finally {
      warning.mockRestore();
    }
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM vobiz_inbound_calls").first()).count)
      .toBe(0);
  });

  it("does not log a field rejection for a valid verified inbound callback", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const response = await handleInboundCallback(
        await signedCallback(ANSWER_PATH, "StartApp", "12345678901234568100",
          {}, { callUUID: crypto.randomUUID() }),
        disabledEnv(), "answer", healthyBridge,
      );
      expect(response.status).toBe(200);
      expect(warning).not.toHaveBeenCalled();
    } finally {
      warning.mockRestore();
    }
  });

  it("accepts concurrent Answer retries as one call and one bridge claim", async () => {
    const local = enabledEnv();
    const callUUID = crypto.randomUUID();
    const [first, second] = await Promise.all([
      handleInboundCallback(await signedCallback(ANSWER_PATH, "StartApp",
        "12345678901234567901", {}, { callUUID }), local, "answer", healthyBridge),
      handleInboundCallback(await signedCallback(ANSWER_PATH, "StartApp",
        "12345678901234567902", {}, { callUUID }), local, "answer", healthyBridge),
    ]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM vobiz_inbound_calls").first()).count).toBe(1);
    const row = await env.DB.prepare("SELECT id FROM vobiz_inbound_calls").first();
    const claim = async () => SELF.fetch(`https://relay.example/v1/vobiz/bridge/calls/${row.id}/claim`, {
      method: "POST", headers: { authorization: `Bearer ${BRIDGE}` },
    });
    const claims = await Promise.all([claim(), claim()]);
    expect(claims.map((result) => result.status).sort()).toEqual([200, 409]);
  });

  it("fails a second simultaneous inbound call and blocks an outbound dispatch while one is active", async () => {
    const local = enabledEnv();
    const [first, second] = await Promise.all([
      handleInboundCallback(await signedCallback(ANSWER_PATH, "StartApp",
        "12345678901234567905", {}, { callUUID: crypto.randomUUID() }),
      local, "answer", healthyBridge),
      handleInboundCallback(await signedCallback(ANSWER_PATH, "StartApp",
        "12345678901234567906", {}, { callUUID: crypto.randomUUID() }),
      local, "answer", healthyBridge),
    ]);
    const xml = await Promise.all([first.text(), second.text()]);
    expect(xml.filter((body) => body.includes("<Stream"))).toHaveLength(1);
    expect(xml.filter((body) => body.includes("<Hangup/>"))).toHaveLength(1);
    const rows = (await env.DB.prepare("SELECT status, provider_status FROM vobiz_inbound_calls").all()).results;
    expect(rows.map((row) => row.status).sort()).toEqual(["connected", "failed"]);
    expect(rows.some((row) => row.provider_status === "another_call_active")).toBe(true);
    const outbound = await createPstnCall(new Request("https://relay.example/v1/pstn-calls", {
      method: "POST",
      headers: { "idempotency-key": crypto.randomUUID(),
        "content-type": "application/json" },
      body: JSON.stringify({ to: "+919876543210", briefing: "Say hello." }),
    }), local, healthyBridge);
    expect(outbound.status).toBe(409);
    expect((await outbound.json()).error).toBe("another_call_active");
  });

  it("streams one inbound call, exposes unverified caller metadata, and stores a bounded message report", async () => {
    const local = enabledEnv();
    const callUUID = crypto.randomUUID();
    const response = await handleInboundCallback(
      await signedCallback(ANSWER_PATH, "StartApp", "12345678901234567891",
        { From: "9000000001" }, { callUUID, version: "v2" }),
      local, "answer", healthyBridge,
    );
    expect(response.status).toBe(200);
    const xml = await response.text();
    expect(xml).toContain('contentType="audio/x-l16;rate=16000"');
    expect(xml).toContain("wss://bridge.example/vobiz?token=");
    expect(xml).not.toContain(CALLER);
    const inbox = (await (await SELF.fetch("https://relay.example/v1/inbound-calls", {
      headers: { authorization: `Bearer ${AGENT}` },
    })).json()).calls;
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ status: "connected", caller_number: CALLER,
      called_number: DID });
    expect(inbox[0]).not.toHaveProperty("source_type");
    const id = inbox[0].id;
    const bridgeURL = `https://relay.example/v1/vobiz/bridge/calls/${id}`;
    const context = await (await SELF.fetch(bridgeURL, {
      headers: { authorization: `Bearer ${BRIDGE}` },
    })).json();
    expect(context).toMatchObject({ id, direction: "inbound", caller_number: CALLER,
      called_number: DID, destination_number: DID, vobiz_call_id: callUUID,
      source_type: "unknown" });
    expect(context.opening_speech).toContain("AI assistant");
    expect((await SELF.fetch(`${bridgeURL}/claim`, {
      method: "POST", headers: { authorization: `Bearer ${BRIDGE}` },
    })).status).toBe(200);
    expect((await SELF.fetch(`${bridgeURL}/claim`, {
      method: "POST", headers: { authorization: `Bearer ${BRIDGE}` },
    })).status).toBe(409);
    expect((await SELF.fetch(`${bridgeURL}/events`, {
      method: "POST", headers: { authorization: `Bearer ${BRIDGE}`,
        "content-type": "application/json" },
      body: JSON.stringify({ event: "connected" }),
    })).status).toBe(200);
    expect((await SELF.fetch(`${bridgeURL}/events`, {
      method: "POST", headers: { authorization: `Bearer ${BRIDGE}`,
        "content-type": "application/json" },
      body: JSON.stringify({ event: "ended", transcript: [
        { role: "user", text: "Please remind him to call me tomorrow. My code is 123456." },
      ], inbound_report: "Please remind him to call me tomorrow. My code is 123456." }),
    })).status).toBe(200);
    expect((await handleInboundCallback(
      await signedCallback(HANGUP_PATH, "Hangup", "12345678901234567892", {}, { callUUID }),
      local, "hangup",
    )).status).toBe(200);
    const status = await (await SELF.fetch(`https://relay.example/v1/inbound-calls/${id}`, {
      headers: { authorization: `Bearer ${AGENT}` },
    })).json();
    expect(status).toMatchObject({ status: "completed", caller_number: CALLER,
      provider_status: "hangup", delivery_status: "unknown",
      acknowledgement_status: "unknown", outcome_evidence: null });
    expect(status.inbound_report).toContain("[code omitted]");
    expect(status.inbound_report).not.toContain("123456");
    expect(status.summary).toContain("[code omitted]");
    expect((await (await SELF.fetch("https://relay.example/v1/inbound-calls", {
      headers: { authorization: `Bearer ${AGENT}` },
    })).json()).calls[0]).not.toHaveProperty("inbound_report");
  });

  it("records unavailable bridge and hangup-before-answer without opening a stream", async () => {
    const local = enabledEnv();
    const unavailableUUID = crypto.randomUUID();
    const unavailable = await handleInboundCallback(
      await signedCallback(ANSWER_PATH, "StartApp", "12345678901234567893",
        { From: "123" }, { callUUID: unavailableUUID }),
      local, "answer", async () => Response.json({ ok: true, codex_ready: true,
        inbound_enabled: false }),
    );
    expect(unavailable.status).toBe(200);
    expect(await unavailable.text()).toContain("<Hangup/>");
    const missedUUID = crypto.randomUUID();
    const missed = await handleInboundCallback(
      await signedCallback(HANGUP_PATH, "Hangup", "12345678901234567894",
        { From: "anonymous", CallStatus: "no-answer" }, { callUUID: missedUUID }),
      local, "hangup",
    );
    expect(missed.status).toBe(200);
    const rows = (await env.DB.prepare("SELECT status, from_number, provider_status FROM vobiz_inbound_calls").all()).results;
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.status === "failed" && row.from_number === null)).toBe(true);
    expect(rows.some((row) => row.provider_status === "codex_bridge_unavailable")).toBe(true);
  });

  it("marks a hangup before Codex media connects as failed", async () => {
    const local = enabledEnv();
    const callUUID = crypto.randomUUID();
    const answer = await handleInboundCallback(
      await signedCallback(ANSWER_PATH, "StartApp", "12345678901234567903", {}, { callUUID }),
      local, "answer", healthyBridge,
    );
    expect(answer.status).toBe(200);
    const hangup = await handleInboundCallback(
      await signedCallback(HANGUP_PATH, "Hangup", "12345678901234567904", {}, { callUUID }),
      local, "hangup",
    );
    expect(hangup.status).toBe(200);
    const row = await env.DB.prepare("SELECT status, bridge_connected_at FROM vobiz_inbound_calls").first();
    expect(row).toMatchObject({ status: "failed", bridge_connected_at: null });
  });

  it("accepts the exact 256-bit token URL with HMAC while disabled and fails closed for missing or wrong secrets", async () => {
    const callUUID = crypto.randomUUID();
    const accepted = await handleInboundCallback(
      await signedCallback(TOKEN_ANSWER_PATH, "StartApp", "12345678901234568200",
        {}, { callUUID }),
      disabledEnv(), "answer", healthyBridge, CALLBACK_TOKEN,
    );
    expect(accepted.status).toBe(200);
    expect(await accepted.text()).toContain("<Hangup/>");
    expect((await env.DB.prepare("SELECT status FROM vobiz_inbound_calls").first()).status)
      .toBe("blocked_disabled");

    const wrongToken = CALLBACK_TOKEN.slice(0, -1) + "g";
    expect((await SELF.fetch(unsignedCallback(
      `${ANSWER_PATH}/${wrongToken}`, "StartApp", crypto.randomUUID(),
    ))).status).toBe(403);
    expect((await handleInboundCallback(
      unsignedCallback(TOKEN_ANSWER_PATH, "StartApp"),
      { ...enabledEnv(), VOBIZ_INBOUND_CALLBACK_TOKEN: undefined },
      "answer", healthyBridge, CALLBACK_TOKEN,
    )).status).toBe(403);
    expect((await handleInboundCallback(
      unsignedCallback(TOKEN_ANSWER_PATH, "StartApp"),
      { ...enabledEnv(), VOBIZ_INBOUND_CALLBACK_TOKEN: "short" },
      "answer", healthyBridge, CALLBACK_TOKEN,
    )).status).toBe(403);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM vobiz_inbound_calls").first()).count)
      .toBe(1);
  });

  it("binds signed token Answer and Hangup retries to one exact body per call UUID and event", async () => {
    const local = { ...enabledEnv(), VOBIZ_INBOUND_CALLBACK_TOKEN: CALLBACK_TOKEN };
    const callUUID = crypto.randomUUID();
    const answer = await handleInboundCallback(
      await signedCallback(TOKEN_ANSWER_PATH, "StartApp", "12345678901234568201",
        {}, { callUUID }),
      local, "answer", healthyBridge, CALLBACK_TOKEN,
    );
    expect(answer.status).toBe(200);
    expect(await answer.text()).toContain("<Stream");
    const retry = await handleInboundCallback(
      await signedCallback(TOKEN_ANSWER_PATH, "StartApp", "12345678901234568201",
        {}, { callUUID }),
      local, "answer", healthyBridge, CALLBACK_TOKEN,
    );
    expect(retry.status).toBe(200);
    const altered = await handleInboundCallback(
      await signedCallback(TOKEN_ANSWER_PATH, "StartApp", "12345678901234568201",
        { From: "+919999999999" }, { callUUID }),
      local, "answer", healthyBridge, CALLBACK_TOKEN,
    );
    expect(altered.status).toBe(403);
    const hangup = await handleInboundCallback(
      await signedCallback(TOKEN_HANGUP_PATH, "Hangup", "12345678901234568202",
        {}, { callUUID }),
      local, "hangup", fetch, CALLBACK_TOKEN,
    );
    expect(hangup.status).toBe(200);
    const changedHangup = await handleInboundCallback(
      await signedCallback(TOKEN_HANGUP_PATH, "Hangup", "12345678901234568202",
        { CallStatus: "failed" }, { callUUID }),
      local, "hangup", fetch, CALLBACK_TOKEN,
    );
    expect(changedHangup.status).toBe(403);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM vobiz_inbound_calls").first()).count)
      .toBe(1);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM vobiz_inbound_callback_nonces").first()).count)
      .toBe(4);
  });

  it("rejects a token callback with the wrong DID, account, direction, event, or UUID", async () => {
    const local = { ...enabledEnv(), VOBIZ_INBOUND_CALLBACK_TOKEN: CALLBACK_TOKEN };
    const invalidCases = [
      { To: "+919999999999" },
      { auth_id: "another-account" },
      { Direction: "outbound" },
      { Event: "Hangup" },
      { CallUUID: "not-a-uuid" },
    ];
    for (let index = 0; index < invalidCases.length; index++) {
      const fields = invalidCases[index];
      const response = await handleInboundCallback(
        await signedCallback(TOKEN_ANSWER_PATH, "StartApp",
          String(12345678901234568210n + BigInt(index)), fields,
          { callUUID: crypto.randomUUID() }),
        local, "answer", healthyBridge, CALLBACK_TOKEN,
      );
      expect(response.status).toBe(403);
    }
    const queried = new Request(`https://relay.example${TOKEN_ANSWER_PATH}?extra=1`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ Event: "StartApp", CallUUID: crypto.randomUUID(),
        Direction: "inbound", To: DID, auth_id: "test-auth" }),
    });
    expect((await handleInboundCallback(queried, local, "answer", healthyBridge,
      CALLBACK_TOKEN)).status).toBe(403);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM vobiz_inbound_calls").first()).count)
      .toBe(0);
  });

  it("accepts signed token callbacks when Vobiz omits optional routing fields", async () => {
    const local = { ...disabledEnv(), VOBIZ_INBOUND_CALLBACK_TOKEN: CALLBACK_TOKEN };
    const omissions = [["Direction", "To"], ["Direction"], ["To"]];
    for (let index = 0; index < omissions.length; index++) {
      const callUUID = crypto.randomUUID();
      const params = new URLSearchParams({ Event: "StartApp", CallUUID: callUUID,
        Direction: "inbound", From: CALLER, To: DID, auth_id: "test-auth" });
      for (const field of omissions[index]) params.delete(field);
      const response = await handleInboundCallback(
        await signedCallbackWithParams(TOKEN_ANSWER_PATH,
          String(12345678901234568220n + BigInt(index)), params),
        local, "answer", healthyBridge, CALLBACK_TOKEN,
      );
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("<Hangup/>");
      const row = await env.DB.prepare(
        "SELECT to_number, status FROM vobiz_inbound_calls WHERE vobiz_call_uuid = ?1",
      ).bind(callUUID).first();
      expect(row).toMatchObject({ to_number: DID, status: "blocked_disabled" });
    }
  });

  it("completes signed token Answer and Hangup handling when both routing fields are omitted", async () => {
    const local = { ...enabledEnv(), VOBIZ_INBOUND_CALLBACK_TOKEN: CALLBACK_TOKEN };
    const callUUID = crypto.randomUUID();
    const callbackParams = (event) => new URLSearchParams({
      Event: event, CallUUID: callUUID, From: CALLER, auth_id: "test-auth",
    });
    const answer = await handleInboundCallback(
      await signedCallbackWithParams(TOKEN_ANSWER_PATH, "12345678901234568240",
        callbackParams("StartApp")),
      local, "answer", healthyBridge, CALLBACK_TOKEN,
    );
    expect(answer.status).toBe(200);
    expect(await answer.text()).toContain("<Stream");
    expect(await env.DB.prepare(
      "SELECT status, to_number, ended_at FROM vobiz_inbound_calls WHERE vobiz_call_uuid = ?1",
    ).bind(callUUID).first()).toMatchObject({
      status: "connected", to_number: DID, ended_at: null,
    });

    const hangup = await handleInboundCallback(
      await signedCallbackWithParams(TOKEN_HANGUP_PATH, "12345678901234568241",
        callbackParams("Hangup")),
      local, "hangup", fetch, CALLBACK_TOKEN,
    );
    expect(hangup.status).toBe(200);
    const terminal = await env.DB.prepare(
      `SELECT status, provider_status, to_number, ended_at
         FROM vobiz_inbound_calls WHERE vobiz_call_uuid = ?1`,
    ).bind(callUUID).first();
    expect(terminal).toMatchObject({ status: "failed", provider_status: "hangup",
      to_number: DID });
    expect(terminal.ended_at).not.toBeNull();
    const tokenNonces = await env.DB.prepare(
      `SELECT nonce FROM vobiz_inbound_callback_nonces
        WHERE nonce IN (?1, ?2) ORDER BY nonce`,
    ).bind(`token:answer:${callUUID}`, `token:hangup:${callUUID}`).all();
    expect(tokenNonces.results.map((row) => row.nonce)).toEqual([
      `token:answer:${callUUID}`, `token:hangup:${callUUID}`,
    ]);
  });

  it("requires HMAC on token callbacks and rejects wrong or duplicate optional routing fields", async () => {
    const local = { ...enabledEnv(), VOBIZ_INBOUND_CALLBACK_TOKEN: CALLBACK_TOKEN };
    expect((await handleInboundCallback(
      unsignedCallback(TOKEN_ANSWER_PATH, "StartApp"),
      local, "answer", healthyBridge, CALLBACK_TOKEN,
    )).status).toBe(403);
    const cases = [
      (params) => params.set("Direction", "outbound"),
      (params) => params.append("Direction", "inbound"),
      (params) => params.set("To", "+919999999999"),
      (params) => params.append("To", DID),
    ];
    for (let index = 0; index < cases.length; index++) {
      const params = new URLSearchParams({ Event: "StartApp", CallUUID: crypto.randomUUID(),
        Direction: "inbound", From: CALLER, To: DID, auth_id: "test-auth" });
      cases[index](params);
      const response = await handleInboundCallback(
        await signedCallbackWithParams(TOKEN_ANSWER_PATH,
          String(12345678901234568230n + BigInt(index)), params),
        local, "answer", healthyBridge, CALLBACK_TOKEN,
      );
      expect(response.status).toBe(403);
    }
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM vobiz_inbound_calls").first()).count)
      .toBe(0);
  });

  it("rejects invalid V2 or V3 HMAC headers even when the token is valid", async () => {
    const local = { ...enabledEnv(), VOBIZ_INBOUND_CALLBACK_TOKEN: CALLBACK_TOKEN };
    const badV3 = unsignedCallback(TOKEN_ANSWER_PATH, "StartApp");
    badV3.headers.set("x-vobiz-signature-v3", btoa("invalid"));
    badV3.headers.set("x-vobiz-signature-v3-nonce", "12345678901234567890");
    expect((await handleInboundCallback(badV3, local, "answer", healthyBridge,
      CALLBACK_TOKEN)).status).toBe(403);

    const validV3BadV2 = await signedCallback(TOKEN_ANSWER_PATH, "StartApp",
      "12345678901234567891", {}, { callUUID: crypto.randomUUID() });
    validV3BadV2.headers.set("x-vobiz-signature-v2", btoa("invalid"));
    validV3BadV2.headers.set("x-vobiz-signature-v2-nonce", "12345678901234567892");
    expect((await handleInboundCallback(validV3BadV2, local, "answer", healthyBridge,
      CALLBACK_TOKEN)).status).toBe(403);
    const nonceOnly = unsignedCallback(TOKEN_ANSWER_PATH, "StartApp");
    nonceOnly.headers.set("x-vobiz-signature-v2-nonce", "12345678901234567893");
    expect((await handleInboundCallback(nonceOnly, local, "answer", healthyBridge,
      CALLBACK_TOKEN)).status).toBe(403);
    const signedToken = await signedCallback(TOKEN_ANSWER_PATH, "StartApp",
      "12345678901234567894", {}, { callUUID: crypto.randomUUID() });
    expect((await handleInboundCallback(signedToken, local, "answer", healthyBridge,
      CALLBACK_TOKEN)).status).toBe(200);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM vobiz_inbound_calls").first()).count)
      .toBe(1);
  });
});
