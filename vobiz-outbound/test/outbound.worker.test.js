import { env } from "cloudflare:workers";
import { SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker, { createPstnCall, getPstnCall, handleVobizCallback } from "../src/index.js";

const AGENT = "test-hermes-token-32-chars-long-value";
const BRIDGE = "test-bridge-token-32-chars-long-value";
const PROVIDER_ID = "550e8400-e29b-41d4-a716-446655440000";
const DESTINATION = "+919876543210";
const DID = "+918071580171";
const requests = [];

function fakeFetchFor(providerID = PROVIDER_ID) { return async (input, init) => {
  const url = new URL(input);
  requests.push({ url: url.toString(), method: init?.method || "GET",
    payload: init?.body ? JSON.parse(init.body) : null });
  if (url.toString() === "https://bridge.example/health") {
    return Response.json({ ok: true, codex_ready: true });
  }
  if (url.toString() === "https://api.vobiz.ai/api/v1/Account/test-auth/Call/") {
    return Response.json({ message: "Call fired", request_uuid: providerID });
  }
  throw new Error(`unexpected fetch ${url}`);
}; }

const fakeFetch = fakeFetchFor();

async function signedCallback(path, event, nonce, includeNumbers = true) {
  const parameters = { Event: event, CallUUID: PROVIDER_ID,
    auth_id: "test-auth",
    ...(includeNumbers ? { From: DID, To: DESTINATION } : {}) };
  const body = new URLSearchParams(parameters).toString();
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode("test-vobiz-auth-token"),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key,
    new TextEncoder().encode(`https://relay.example${path}.${nonce}`));
  return new Request(`https://relay.example${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-vobiz-signature-v3": btoa(String.fromCharCode(...new Uint8Array(signature))),
      "x-vobiz-signature-v3-nonce": nonce,
    },
    body,
  });
}

function unsignedCallback(path, event, nationalNumbers = false, extra = {}, providerID = PROVIDER_ID, headers = {}) {
  return new Request(`https://relay.example${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams({
      Event: event, CallUUID: providerID,
      From: nationalNumbers ? DID.slice(3) : DID,
      To: nationalNumbers ? DESTINATION.slice(3) : DESTINATION,
      auth_id: "test-auth", ...extra,
    }).toString(),
  });
}

function callRequest(briefing, key = crypto.randomUUID(), openingSpeech) {
  return new Request("https://relay.example/v1/pstn-calls", {
    method: "POST",
    headers: { authorization: `Bearer ${AGENT}`, "idempotency-key": key,
      "content-type": "application/json" },
    body: JSON.stringify({ to: DESTINATION, briefing, opening_speech: openingSpeech }),
  });
}

describe("isolated Vobiz outbound relay", () => {
  beforeEach(async () => {
    requests.length = 0;
    await env.DB.prepare("DELETE FROM vobiz_callback_nonces").run();
    await env.DB.prepare("DELETE FROM vobiz_pstn_calls").run();
    await env.DB.prepare("DELETE FROM request_rates").run();
  });

  afterEach(() => vi.useRealTimers());

  it("requires scoped bearer auth and a ready Codex bridge, then dispatches once per idempotency key", async () => {
    expect((await SELF.fetch("https://relay.example/health")).status).toBe(200);
    const endpoint = "https://relay.example/v1/pstn-calls";
    const key = crypto.randomUUID();
    const body = { to: DESTINATION, briefing: "Ask if my Jio phone can hear the greeting." };
    const send = (token, payload = body) => createPstnCall(new Request(endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "idempotency-key": key,
        "content-type": "application/json" },
      body: JSON.stringify(payload),
    }), env, fakeFetch);
    expect((await SELF.fetch(endpoint, { method: "POST", headers: {
      authorization: "Bearer bad-token", "idempotency-key": key, "content-type": "application/json",
    }, body: JSON.stringify(body) })).status).toBe(401);
    expect((await send(AGENT, { ...body, to: "+14155550100" })).status).toBe(400);
    expect((await send(AGENT, { ...body, to: DESTINATION.slice(1) })).status).toBe(400);
    expect((await createPstnCall(callRequest(body.briefing),
      { ...env, VOBIZ_ALLOWED_DESTINATIONS: "+919999999999" }, fakeFetch)).status).toBe(403);
    const first = await send(AGENT);
    expect(first.status, await first.clone().text()).toBe(201);
    const call = await first.json();
    expect(call).toMatchObject({ direction: "outbound", status: "queued", to_number: DESTINATION });
    expect((await send(AGENT)).status).toBe(200);
    expect((await send(AGENT, { ...body, briefing: "A different request" })).status).toBe(409);
    const activeConflict = await createPstnCall(callRequest("Another call while the first is active."), env, fakeFetch);
    expect(activeConflict.status).toBe(409);
    expect((await activeConflict.json()).error).toBe("another_call_active");
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM vobiz_pstn_calls").first()).count).toBe(1);
    expect(requests.filter((item) => item.url.includes("api.vobiz.ai"))).toHaveLength(1);

    const providerRequest = requests.find((item) => item.url.includes("api.vobiz.ai"));
    const answerPath = new URL(providerRequest.payload.answer_url).pathname;
    const callbackToken = answerPath.split("/").at(-1);
    const wrongToken = await SELF.fetch(`https://relay.example/v1/vobiz/answer/${call.id}/${"x".repeat(43)}`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ Event: "StartApp", CallUUID: PROVIDER_ID,
        From: DID, To: DESTINATION, auth_id: "test-auth" }).toString(),
    });
    expect(wrongToken.status).toBe(403);
    const ringPath = new URL(providerRequest.payload.ring_url).pathname;
    expect((await SELF.fetch(unsignedCallback(ringPath, "Ring", true, {}, PROVIDER_ID,
      { "x-vobiz-signature": "legacy-header-is-not-v2-or-v3" }))).status).toBe(200);
    expect((await SELF.fetch(unsignedCallback(ringPath, "Ring", false, {}, PROVIDER_ID,
      { "x-vobiz-signature-ma-v3": "multi-account-header-is-not-standard-v3" }))).status).toBe(200);
    const tampered = await signedCallback(answerPath, "StartApp", "12345678901234567892");
    tampered.headers.set("x-vobiz-signature-v3", btoa("invalid"));
    expect((await SELF.fetch(tampered)).status).toBe(403);
    const answered = await handleVobizCallback(
      await signedCallback(answerPath, "StartApp", "12345678901234567890", false),
      { ...env, VOBIZ_OUTBOUND_ENABLED: "false" }, "answer", call.id, callbackToken, fakeFetch,
    );
    expect(answered.status).toBe(200);
    const xml = await answered.text();
    expect(xml).toContain('contentType="audio/x-l16;rate=16000"');
    expect(xml).toContain("wss://bridge.example/vobiz?token=");
    expect(xml).not.toContain(body.briefing);

    const bridgePath = `https://relay.example/v1/vobiz/bridge/calls/${call.id}`;
    expect((await SELF.fetch(bridgePath, { headers: { authorization: `Bearer ${AGENT}` } })).status).toBe(401);
    const context = await (await SELF.fetch(bridgePath,
      { headers: { authorization: `Bearer ${BRIDGE}` } })).json();
    expect(context).toMatchObject({ id: call.id, direction: "outbound",
      destination_number: DESTINATION, vobiz_call_id: PROVIDER_ID });
    expect((await SELF.fetch(`${bridgePath}/claim`, {
      method: "POST", headers: { authorization: `Bearer ${BRIDGE}` },
    })).status).toBe(200);
    expect((await SELF.fetch(`${bridgePath}/claim`, {
      method: "POST", headers: { authorization: `Bearer ${BRIDGE}` },
    })).status).toBe(409);
    expect((await SELF.fetch(`${bridgePath}/events`, {
      method: "POST", headers: { authorization: `Bearer ${BRIDGE}`, "content-type": "application/json" },
      body: JSON.stringify({ event: "ended", transcript: [
        { role: "user", text: "My code is 123456. Thanks for calling." },
      ] }),
    })).status).toBe(200);
    const ended = await (await SELF.fetch(`https://relay.example/v1/pstn-calls/${call.id}`,
      { headers: { authorization: `Bearer ${AGENT}` } })).json();
    expect(ended).toMatchObject({ status: "completed", summary: "My code is [code omitted]. Thanks for calling." });

    const hungup = await SELF.fetch(await signedCallback(new URL(providerRequest.payload.hangup_url).pathname, "Hangup",
      "12345678901234567891"));
    expect(hungup.status).toBe(200);
  });

  it("marks unanswered calls failed and preserves a Codex bridge failure on later Hangup", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const noAnswerProviderID = crypto.randomUUID();
    const noAnswer = await createPstnCall(callRequest("Say hello if answered."), env,
      fakeFetchFor(noAnswerProviderID));
    expect(noAnswer.status).toBe(201);
    const noAnswerCall = await noAnswer.json();
    const noAnswerRequest = requests.at(-1).payload;
    const noAnswerPath = new URL(noAnswerRequest.hangup_url).pathname;
    expect((await SELF.fetch(unsignedCallback(noAnswerPath, "Hangup", false,
      { CallStatus: "no-answer", HangupCause: "6010" }, noAnswerProviderID))).status).toBe(200);
    expect((await (await getPstnCall(env, noAnswerCall.id)).json()).status).toBe("failed");

    vi.setSystemTime(Date.now() + 1_100);
    const failedProviderID = crypto.randomUUID();
    const failedCallResponse = await createPstnCall(callRequest("Say hello if answered."), env,
      fakeFetchFor(failedProviderID));
    expect(failedCallResponse.status).toBe(201);
    const failedCall = await failedCallResponse.json();
    const failedRequest = requests.at(-1).payload;
    const answerPath = new URL(failedRequest.answer_url).pathname;
    const callbackToken = answerPath.split("/").at(-1);
    expect((await handleVobizCallback(unsignedCallback(answerPath, "StartApp", false,
      {}, failedProviderID), env, "answer", failedCall.id, callbackToken, fakeFetch)).status).toBe(200);
    const eventsURL = `https://relay.example/v1/vobiz/bridge/calls/${failedCall.id}/events`;
    for (const event of ["connected", "failed"]) {
      expect((await SELF.fetch(eventsURL, { method: "POST", headers: {
        authorization: `Bearer ${BRIDGE}`, "content-type": "application/json",
      }, body: JSON.stringify({ event, detail: "Codex failed" }) })).status).toBe(200);
    }
    const failedPath = new URL(failedRequest.hangup_url).pathname;
    expect((await SELF.fetch(unsignedCallback(failedPath, "Hangup", false,
      { CallStatus: "completed" }, failedProviderID))).status).toBe(200);
    expect((await (await getPstnCall(env, failedCall.id)).json()).status).toBe("failed");
  });

  it("enforces a rolling 1000ms provider dispatch gap across a second boundary", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const justBeforeBoundary = Math.floor(Date.now() / 1_000) * 1_000 + 999;
    vi.setSystemTime(justBeforeBoundary);
    const first = await createPstnCall(callRequest("Say hello."), env, fakeFetch);
    expect(first.status).toBe(201);
    const payload = requests.at(-1).payload;
    expect(payload.time_limit).toBe(180);
    expect((await SELF.fetch(unsignedCallback(new URL(payload.hangup_url).pathname,
      "Hangup", false, { CallStatus: "no-answer" }))).status).toBe(200);
    vi.setSystemTime(justBeforeBoundary + 2);
    const second = await createPstnCall(callRequest("Try after first ended."), env, fakeFetch);
    expect(second.status).toBe(429);
    expect(requests.filter((item) => item.url.includes("api.vobiz.ai"))).toHaveLength(1);
    vi.setSystemTime(justBeforeBoundary + 1_000);
    const third = await createPstnCall(callRequest("Try a second later."), env,
      fakeFetchFor(crypto.randomUUID()));
    expect(third.status).toBe(201);
  });

  it("hangs up and records failure if the Codex bridge becomes unavailable at answer time", async () => {
    const providerID = crypto.randomUUID();
    const first = await createPstnCall(callRequest("Say hello."), env, fakeFetchFor(providerID));
    expect(first.status).toBe(201);
    const call = await first.json();
    const answerPath = new URL(requests.at(-1).payload.answer_url).pathname;
    const callbackToken = answerPath.split("/").at(-1);
    const unavailableFetch = async (input) => {
      expect(new URL(input).pathname).toBe("/health");
      return Response.json({ ok: true, codex_ready: false });
    };
    const answered = await handleVobizCallback(unsignedCallback(answerPath, "StartApp", false,
      {}, providerID), env, "answer", call.id, callbackToken, unavailableFetch);
    expect(answered.status).toBe(200);
    expect(await answered.text()).toContain("<Hangup/>");
    expect((await (await getPstnCall(env, call.id)).json()).status).toBe("failed");
  });

  it("stores a bounded custom AI-disclosed opening and includes it in idempotency", async () => {
    const key = crypto.randomUUID();
    const briefing = "Greet Chirag and ask how he is doing.";
    const speech = "Hi Chirag, this is your Hermes AI agent. How are you doing?";
    expect((await createPstnCall(callRequest(briefing, key, "Hi Chirag, this is Hermes."),
      env, fakeFetch)).status).toBe(400);
    expect((await createPstnCall(callRequest(briefing, key, `${speech}\u0001`),
      env, fakeFetch)).status).toBe(400);
    expect((await createPstnCall(callRequest(briefing, key, `${speech} ${"x".repeat(321)}`),
      env, fakeFetch)).status).toBe(400);
    const placed = await createPstnCall(callRequest(briefing, key, speech), env, fakeFetch);
    expect(placed.status).toBe(201);
    const call = await placed.json();
    const context = await (await SELF.fetch(
      `https://relay.example/v1/vobiz/bridge/calls/${call.id}`,
      { headers: { authorization: `Bearer ${BRIDGE}` } })).json();
    expect(context.opening_speech).toBe(speech);
    expect((await createPstnCall(callRequest(briefing, key, speech), env, fakeFetch)).status).toBe(200);
    expect((await createPstnCall(callRequest(briefing, key), env, fakeFetch)).status).toBe(409);
    expect(requests.filter((item) => item.url.includes("api.vobiz.ai"))).toHaveLength(1);
  });

  it("never logs a callback bearer in an error path", async () => {
    const callbackToken = "s".repeat(43);
    const callbackID = crypto.randomUUID();
    const logger = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await worker.fetch(new Request(
        `https://relay.example/v1/vobiz/answer/${callbackID}/${callbackToken}`,
        { method: "POST" }), { ...env, DB: { prepare() { throw new Error("storage failure"); } } });
      expect(response.status).toBe(500);
      expect(logger).toHaveBeenCalled();
      expect(JSON.stringify(logger.mock.calls)).not.toContain(callbackToken);
    } finally {
      logger.mockRestore();
    }
  });

  it("stays disabled unless explicitly enabled", async () => {
    const local = { ...env, VOBIZ_OUTBOUND_ENABLED: "false" };
    const response = await createPstnCall(new Request("https://relay.example/v1/pstn-calls", {
      method: "POST", headers: { "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify({ to: DESTINATION, briefing: "Say hello" }),
    }), local);
    expect(response.status).toBe(503);
  });
});
