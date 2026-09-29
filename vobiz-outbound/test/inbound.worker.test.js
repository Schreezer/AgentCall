import { env } from "cloudflare:workers";
import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createPstnCall, handleInboundCallback } from "../src/index.js";

const AGENT = "test-hermes-token-32-chars-long-value";
const BRIDGE = "test-bridge-token-32-chars-long-value";
const DID = "+918071580171";
const CALLER = "+919000000001";
const ANSWER_PATH = "/v1/vobiz/inbound/answer";
const HANGUP_PATH = "/v1/vobiz/inbound/hangup";

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
  const body = new URLSearchParams(fields);
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
    const response = await SELF.fetch(callback);
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
});
