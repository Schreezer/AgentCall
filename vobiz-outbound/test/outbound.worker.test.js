import { env } from "cloudflare:workers";
import { SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker, { bridgeActionToken, bridgeCallEvent, bridgeToken, createPstnCall, getPstnCall, getPstnProviderStatus,
  handleVobizCallback, reconcilePstnCall } from "../src/index.js";

const AGENT = "test-hermes-token-32-chars-long-value";
const BRIDGE = "test-bridge-token-32-chars-long-value";
const PROVIDER_ID = "550e8400-e29b-41d4-a716-446655440000";
const DESTINATION = "+919876543210";
const DID = "+918071580171";
const requests = [];

function fakeFetchFor(providerID = PROVIDER_ID) { return async (input, init) => {
  const url = new URL(input);
  requests.push({ url: url.toString(), method: init?.method || "GET",
    payload: init?.body ? JSON.parse(init.body) : null,
    authorization: init?.headers?.authorization, redirect: init?.redirect });
  if (url.toString() === "https://bridge.example/health") {
    return Response.json({ ok: true, codex_ready: true, runtime_ready: true });
  }
  if (/^\/(prepare|cancel)\/[0-9a-f-]+$/.test(url.pathname) && url.origin === "https://bridge.example") {
    const action = url.pathname.split("/")[1];
    return Response.json({ ok: true, [action === "prepare" ? "prepared" : "cancelled"]: true });
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

function callbackWithParameters(path, entries, headers = {}) {
  return new Request(`https://relay.example${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(entries).toString(),
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
    const prepareRequests = requests.filter((item) => new URL(item.url).pathname.startsWith("/prepare/"));
    expect(prepareRequests).toHaveLength(1);
    expect(prepareRequests[0].redirect).toBe("manual");
    expect(new URL(prepareRequests[0].url).pathname).toBe(`/prepare/${call.id}`);
    expect(requests.findIndex((item) => item === prepareRequests[0])).toBeLessThan(
      requests.findIndex((item) => item.url.includes("api.vobiz.ai")));
    const actionToken = prepareRequests[0].authorization?.match(/^Bearer (.+)$/)?.[1];
    const [encodedPayload, encodedSignature] = actionToken?.split(".") || [];
    const payloadBytes = Uint8Array.from(atob(encodedPayload.replace(/-/g, "+").replace(/_/g, "/")),
      (character) => character.charCodeAt(0));
    const tokenPayload = JSON.parse(new TextDecoder().decode(payloadBytes));
    expect(tokenPayload).toMatchObject({ v: 2, id: call.id, direction: "outbound", action: "prepare" });
    expect(tokenPayload.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
    const keyForToken = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.VOBIZ_BRIDGE_SECRET),
      { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    const signature = Uint8Array.from(atob(encodedSignature.replace(/-/g, "+").replace(/_/g, "/")),
      (character) => character.charCodeAt(0));
    expect(await crypto.subtle.verify("HMAC", keyForToken, signature,
      new TextEncoder().encode(encodedPayload))).toBe(true);

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
    expect((await SELF.fetch(callbackWithParameters(ringPath, [
      ["Event", "Ring"], ["RequestUUID", PROVIDER_ID], ["Direction", "outbound"],
      ["From", DID], ["To", DESTINATION],
    ]))).status).toBe(200);
    expect((await SELF.fetch(callbackWithParameters(ringPath, [
      ["Event", "Ring"], ["RequestUUID", PROVIDER_ID], ["CallUUID", PROVIDER_ID],
      ["auth_id", "test-auth"],
    ]))).status).toBe(200);
    expect((await SELF.fetch(callbackWithParameters(ringPath, [
      ["Event", "Ring"], ["CallUUID", PROVIDER_ID], ["auth_id", "wrong-auth"],
    ]))).status).toBe(403);
    expect((await SELF.fetch(callbackWithParameters(ringPath, [
      ["Event", "Ring"], ["CallUUID", PROVIDER_ID], ["auth_id", "test-auth"],
      ["auth_id", "test-auth"],
    ]))).status).toBe(403);
    expect((await SELF.fetch(callbackWithParameters(ringPath, [
      ["Event", "Ring"], ["Event", "StartApp"], ["CallUUID", PROVIDER_ID],
    ]))).status).toBe(400);
    expect((await SELF.fetch(callbackWithParameters(ringPath, [
      ["Event", "Ring"], ["RequestUUID", PROVIDER_ID], ["CallUUID", crypto.randomUUID()],
    ]))).status).toBe(403);
    expect((await SELF.fetch(callbackWithParameters(ringPath, [
      ["Event", "Ring"], ["RequestUUID", PROVIDER_ID], ["Direction", "inbound"],
    ]))).status).toBe(403);
    const tampered = await signedCallback(answerPath, "StartApp", "12345678901234567892");
    tampered.headers.set("x-vobiz-signature-v3", btoa("invalid"));
    expect((await SELF.fetch(tampered)).status).toBe(403);
    expect((await SELF.fetch(await signedCallback(
      ringPath, "Ring", "12345678901234567893",
    ))).status).toBe(200);
    const remoteRequestsBeforeAnswer = requests.length;
    const answered = await handleVobizCallback(
      callbackWithParameters(answerPath, [
        ["Event", "StartApp"], ["RequestUUID", PROVIDER_ID], ["Direction", "outbound"],
        ["From", DID], ["To", DESTINATION],
      ]),
      { ...env, VOBIZ_OUTBOUND_ENABLED: "false" }, "answer", call.id, callbackToken, fakeFetch,
    );
    expect(answered.status).toBe(200);
    const xml = await answered.text();
    expect(xml).toContain('contentType="audio/x-l16;rate=16000"');
    expect(xml).toContain("wss://bridge.example/vobiz?token=");
    expect(xml).not.toContain(body.briefing);
    expect(requests).toHaveLength(remoteRequestsBeforeAnswer);
    const streamURL = new URL(xml.match(/<Stream[^>]*>([^<]+)<\/Stream>/)?.[1]);
    const [streamPayload, streamSignature] = streamURL.searchParams.get("token").split(".");
    const token = JSON.parse(new TextDecoder().decode(Uint8Array.from(
      atob(streamPayload.replace(/-/g, "+").replace(/_/g, "/")),
      (character) => character.charCodeAt(0))));
    expect(token).toEqual({ v: 2, id: call.id, direction: "outbound",
      exp: expect.any(Number), provider_call_id: PROVIDER_ID });
    expect(await crypto.subtle.verify("HMAC", keyForToken, Uint8Array.from(
      atob(streamSignature.replace(/-/g, "+").replace(/_/g, "/")),
      (character) => character.charCodeAt(0)),
    new TextEncoder().encode(streamPayload))).toBe(true);

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
    expect(await (await getPstnCall(env, call.id)).json()).toMatchObject({ status: "completed",
      provider_status: "hangup" });
  });

  it("fails health when the outbound terminal evidence migration is missing", async () => {
    let probedColumns = false;
    const missingMigrationEnv = { ...env, DB: {
      prepare(query) {
        if (query.includes("FROM vobiz_pstn_calls LIMIT 1")) {
          probedColumns = query.includes("bridge_terminal_event") &&
            query.includes("provider_terminal_outcome");
          return { async first() { throw new Error("no such column: bridge_terminal_event"); } };
        }
        return env.DB.prepare(query);
      },
    } };
    const health = await worker.fetch(new Request("https://relay.example/health"), missingMigrationEnv);
    expect(probedColumns).toBe(true);
    expect(health.status).toBe(500);
    expect(await health.json()).toEqual({ error: "internal_error" });
  });

  it.each([
    ["bridge rejection", () => new Response(null, { status: 503 })],
    ["bridge timeout", () => { throw new Error("connection timed out"); }],
    ["bridge redirect", () => Response.redirect("https://unexpected.example/steal", 302)],
    ["incomplete bridge response", () => Response.json({ ok: true, prepared: false })],
  ])("never dials if preparation has a %s", async (_, prepareResult) => {
    const key = crypto.randomUUID();
    const seen = [];
    const fetcher = async (input, init) => {
      const url = new URL(input);
      seen.push({ url: url.toString(), redirect: init?.redirect, authorization: init?.headers?.authorization });
      if (url.pathname === "/health") return Response.json({ ok: true, codex_ready: true });
      if (url.pathname.startsWith("/prepare/")) return prepareResult();
      if (url.pathname.startsWith("/cancel/")) return Response.json({ ok: true, cancelled: true });
      throw new Error(`provider should not be called after failed prepare: ${url.origin}`);
    };
    const attempt = await createPstnCall(callRequest("Greet me.", key), env, fetcher);
    expect(attempt.status).toBe(503);
    const { id, error } = await attempt.json();
    expect(error).toBe("codex_prepare_failed");
    expect(seen.map((item) => new URL(item.url).pathname)).toEqual([
      "/health", `/prepare/${id}`, `/cancel/${id}`,
    ]);
    expect(seen[1].redirect).toBe("manual");
    expect(seen[2].redirect).toBe("manual");
    expect((await env.DB.prepare(
      "SELECT status, provider_status, ended_at FROM vobiz_pstn_calls WHERE id = ?1",
    ).bind(id).first())).toMatchObject({ status: "failed", provider_status: "codex_prepare_failed",
      ended_at: expect.any(Number) });
    const repeated = await createPstnCall(callRequest("Greet me.", key), env, fetcher);
    expect(repeated.status).toBe(200);
    expect((await repeated.json()).id).toBe(id);
    expect(seen).toHaveLength(3);
  });

  it("cancels a prepared session when Vobiz rejects the call definitively", async () => {
    const seen = [];
    const fetcher = async (input, init) => {
      const url = new URL(input);
      seen.push(url.pathname);
      if (url.pathname === "/health") return Response.json({ ok: true, codex_ready: true });
      if (url.pathname.startsWith("/prepare/")) return Response.json({ ok: true, prepared: true });
      if (url.origin === "https://api.vobiz.ai") {
        expect(init.redirect).toBe("manual");
        return new Response(null, { status: 400 });
      }
      if (url.pathname.startsWith("/cancel/")) return Response.json({ ok: true, cancelled: true });
      throw new Error(`unexpected fetch: ${url.origin}`);
    };
    const response = await createPstnCall(callRequest("Greet me."), env, fetcher);
    expect(response.status).toBe(502);
    const { id, status, provider_status: providerStatus } = await response.json();
    expect(status).toBe("failed");
    expect(providerStatus).toBe("http_400");
    expect(seen).toEqual(["/health", `/prepare/${id}`, "/api/v1/Account/test-auth/Call/",
      `/cancel/${id}`]);
  });

  it("retains preparation if provider dispatch has an unknown outcome", async () => {
    const seen = [];
    const fetcher = async (input) => {
      const url = new URL(input);
      seen.push(url.pathname);
      if (url.pathname === "/health") return Response.json({ ok: true, codex_ready: true });
      if (url.pathname.startsWith("/prepare/")) return Response.json({ ok: true, prepared: true });
      if (url.origin === "https://api.vobiz.ai") throw new Error("transport outcome unknown");
      throw new Error("preparation must stay alive for a late provider callback");
    };
    const response = await createPstnCall(callRequest("Greet me."), env, fetcher);
    expect(response.status).toBe(201);
    const { id, status } = await response.json();
    expect(status).toBe("dispatch_unknown");
    expect(seen).toEqual(["/health", `/prepare/${id}`, "/api/v1/Account/test-auth/Call/"]);
  });

  it("uses action-scoped tokens and the WSS path prefix for bridge HTTP actions", async () => {
    const call = { id: crypto.randomUUID() };
    await expect(bridgeActionToken(env.VOBIZ_BRIDGE_SECRET, call, "claim"))
      .rejects.toThrow("invalid_bridge_action");
    const seen = [];
    const prefixEnv = { ...env, VOBIZ_BRIDGE_WSS_URL: "wss://bridge.example/caller-vobiz/vobiz" };
    const fetcher = async (input) => {
      const url = new URL(input);
      seen.push(url.pathname);
      if (url.pathname === "/caller-vobiz/health") return Response.json({ ok: true, codex_ready: true });
      if (url.pathname.startsWith("/caller-vobiz/prepare/")) {
        return Response.json({ ok: true, prepared: true });
      }
      if (url.origin === "https://api.vobiz.ai") return Response.json({ request_uuid: PROVIDER_ID });
      throw new Error(`unexpected fetch: ${url.pathname}`);
    };
    const response = await createPstnCall(callRequest("Greet me."), prefixEnv, fetcher);
    expect(response.status).toBe(201);
    const { id } = await response.json();
    expect(seen).toEqual(["/caller-vobiz/health", `/caller-vobiz/prepare/${id}`,
      "/api/v1/Account/test-auth/Call/"]);
  });

  it("keeps the inbound stream token at V1 and requires a provider ID for outbound V2", async () => {
    const id = crypto.randomUUID();
    const inbound = await bridgeToken(env.VOBIZ_BRIDGE_SECRET, { id, direction: "inbound" });
    const payload = inbound.split(".")[0];
    const decoded = JSON.parse(new TextDecoder().decode(Uint8Array.from(
      atob(payload.replace(/-/g, "+").replace(/_/g, "/")),
      (character) => character.charCodeAt(0))));
    expect(decoded).toEqual({ v: 1, id, exp: expect.any(Number), direction: "inbound" });
    await expect(bridgeToken(env.VOBIZ_BRIDGE_SECRET, { id, direction: "outbound" }))
      .rejects.toThrow("provider_call_id_required");
    await expect(bridgeToken(env.VOBIZ_BRIDGE_SECRET, { id, direction: "outbound",
      vobiz_call_uuid: "not-a-uuid" })).rejects.toThrow("provider_call_id_required");
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
    expect((await handleVobizCallback(unsignedCallback(noAnswerPath, "Hangup", false,
      { CallStatus: "no-answer", HangupCause: "6010" }, noAnswerProviderID), env,
    "hangup", noAnswerCall.id, noAnswerPath.split("/").at(-1), fakeFetch)).status).toBe(200);
    expect((await (await getPstnCall(env, noAnswerCall.id)).json()).status).toBe("failed");
    expect(requests.some((item) => item.url === `https://bridge.example/cancel/${noAnswerCall.id}`)).toBe(true);

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
    expect((await handleVobizCallback(unsignedCallback(failedPath, "Hangup", false,
      { CallStatus: "completed" }, failedProviderID), env, "hangup", failedCall.id,
    failedPath.split("/").at(-1), fakeFetch)).status).toBe(200);
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
    expect(payload).not.toHaveProperty("hangup_on_ring");
    expect(payload).not.toHaveProperty("ring_timeout");
    const firstCall = await first.json();
    const firstHangupPath = new URL(payload.hangup_url).pathname;
    expect((await handleVobizCallback(unsignedCallback(firstHangupPath,
      "Hangup", false, { CallStatus: "no-answer" }), env, "hangup", firstCall.id,
    firstHangupPath.split("/").at(-1), fakeFetch)).status).toBe(200);
    vi.setSystemTime(justBeforeBoundary + 2);
    const second = await createPstnCall(callRequest("Try after first ended."), env, fakeFetch);
    expect(second.status).toBe(429);
    expect(requests.filter((item) => item.url.includes("api.vobiz.ai"))).toHaveLength(1);
    vi.setSystemTime(justBeforeBoundary + 1_000);
    const third = await createPstnCall(callRequest("Try a second later."), env,
      fakeFetchFor(crypto.randomUUID()));
    expect(third.status).toBe(201);
  });

  it("returns the prepared stream without an answer-time bridge request", async () => {
    const providerID = crypto.randomUUID();
    const first = await createPstnCall(callRequest("Say hello."), env, fakeFetchFor(providerID));
    expect(first.status).toBe(201);
    const call = await first.json();
    const answerPath = new URL(requests.at(-1).payload.answer_url).pathname;
    const callbackToken = answerPath.split("/").at(-1);
    let answerFetches = 0;
    const unavailableFetch = async () => {
      answerFetches += 1;
      throw new Error("answer path must not depend on the bridge HTTP route");
    };
    const answered = await handleVobizCallback(unsignedCallback(answerPath, "StartApp", false,
      {}, providerID), env, "answer", call.id, callbackToken, unavailableFetch);
    expect(answered.status).toBe(200);
    expect(await answered.text()).toContain("<Stream");
    expect(answerFetches).toBe(0);
    expect((await (await getPstnCall(env, call.id)).json()).status).toBe("connected");
  });

  it("rejects a mismatched provider ID before minting an outbound stream token", async () => {
    const providerID = crypto.randomUUID();
    const placed = await createPstnCall(callRequest("Say hello."), env, fakeFetchFor(providerID));
    expect(placed.status).toBe(201);
    const { id } = await placed.json();
    const answerPath = new URL(requests.at(-1).payload.answer_url).pathname;
    const callbackToken = answerPath.split("/").at(-1);
    const response = await handleVobizCallback(unsignedCallback(answerPath, "StartApp", false,
      {}, crypto.randomUUID()), env, "answer", id, callbackToken, async () => {
      throw new Error("mismatched callback must not call the bridge");
    });
    expect(response.status).toBe(403);
    expect((await (await getPstnCall(env, id)).json()).status).toBe("queued");
  });

  it("accepts an outbound report after Hangup overtakes its background bridge claim", async () => {
    const placed = await createPstnCall(callRequest("Ask why they called."), env, fakeFetch);
    const { id } = await placed.json();
    const providerRequest = requests.at(-1).payload;
    const answerPath = new URL(providerRequest.answer_url).pathname;
    const hangupPath = new URL(providerRequest.hangup_url).pathname;
    const answer = await handleVobizCallback(unsignedCallback(answerPath, "StartApp"),
      env, "answer", id, answerPath.split("/").at(-1), fakeFetch);
    expect(await answer.text()).toContain("<Stream");
    const hungup = await handleVobizCallback(unsignedCallback(hangupPath, "Hangup", false,
      { CallStatus: "completed" }), env, "hangup", id, hangupPath.split("/").at(-1), fakeFetch);
    expect(hungup.status).toBe(200);
    expect(await (await getPstnCall(env, id)).json()).toMatchObject({ status: "failed",
      provider_status: "completed" });
    expect(await env.DB.prepare(
      "SELECT bridge_terminal_event, provider_terminal_outcome FROM vobiz_pstn_calls WHERE id = ?1",
    ).bind(id).first()).toMatchObject({ bridge_terminal_event: null,
      provider_terminal_outcome: "completed" });
    expect((await SELF.fetch(`https://relay.example/v1/vobiz/bridge/calls/${id}/claim`, {
      method: "POST", headers: { authorization: `Bearer ${BRIDGE}` },
    })).status).toBe(409);
    const lateReport = await SELF.fetch(`https://relay.example/v1/vobiz/bridge/calls/${id}/events`, {
      method: "POST", headers: { authorization: `Bearer ${BRIDGE}`,
        "content-type": "application/json" },
      body: JSON.stringify({ event: "ended", transcript: [
        { role: "user", text: "I called to ask about the appointment." },
      ] }),
    });
    expect(lateReport.status).toBe(200);
    expect(await (await getPstnCall(env, id)).json()).toMatchObject({ status: "completed",
      provider_status: "completed", summary: "I called to ask about the appointment." });
    expect(await env.DB.prepare(
      "SELECT bridge_terminal_event, provider_terminal_outcome FROM vobiz_pstn_calls WHERE id = ?1",
    ).bind(id).first()).toMatchObject({ bridge_terminal_event: "ended",
      provider_terminal_outcome: "completed" });
  });

  it("does not claim a successful call from Answer and a normal Hangup alone", async () => {
    const placed = await createPstnCall(callRequest("Say hello."), env, fakeFetch);
    const { id } = await placed.json();
    const providerRequest = requests.at(-1).payload;
    const answerPath = new URL(providerRequest.answer_url).pathname;
    const hangupPath = new URL(providerRequest.hangup_url).pathname;
    expect((await handleVobizCallback(unsignedCallback(answerPath, "StartApp"), env,
      "answer", id, answerPath.split("/").at(-1), fakeFetch)).status).toBe(200);
    expect((await handleVobizCallback(unsignedCallback(hangupPath, "Hangup", false,
      { CallStatus: "completed", HangupCause: "NORMAL_CLEARING" }), env, "hangup", id,
    hangupPath.split("/").at(-1), fakeFetch)).status).toBe(200);
    expect(await (await getPstnCall(env, id)).json()).toMatchObject({ status: "failed",
      provider_status: "completed:NORMAL_CLEARING" });
    expect(await env.DB.prepare(
      "SELECT bridge_terminal_event, provider_terminal_outcome FROM vobiz_pstn_calls WHERE id = ?1",
    ).bind(id).first()).toMatchObject({ bridge_terminal_event: null,
      provider_terminal_outcome: "completed" });
  });

  it("requires the bridge terminal report even when the bridge claimed the call", async () => {
    const placed = await createPstnCall(callRequest("Say hello."), env, fakeFetch);
    const { id } = await placed.json();
    const providerRequest = requests.at(-1).payload;
    const answerPath = new URL(providerRequest.answer_url).pathname;
    const hangupPath = new URL(providerRequest.hangup_url).pathname;
    expect((await handleVobizCallback(unsignedCallback(answerPath, "StartApp"), env,
      "answer", id, answerPath.split("/").at(-1), fakeFetch)).status).toBe(200);
    expect((await SELF.fetch(`https://relay.example/v1/vobiz/bridge/calls/${id}/claim`, {
      method: "POST", headers: { authorization: `Bearer ${BRIDGE}` },
    })).status).toBe(200);
    expect((await handleVobizCallback(unsignedCallback(hangupPath, "Hangup", false,
      { CallStatus: "completed" }), env, "hangup", id, hangupPath.split("/").at(-1),
    fakeFetch)).status).toBe(200);
    expect((await (await getPstnCall(env, id)).json()).status).toBe("failed");
    expect((await SELF.fetch(`https://relay.example/v1/vobiz/bridge/calls/${id}/events`, {
      method: "POST", headers: { authorization: `Bearer ${BRIDGE}`,
        "content-type": "application/json" },
      body: JSON.stringify({ event: "ended", summary: "The caller heard the greeting." }),
    })).status).toBe(200);
    expect((await (await getPstnCall(env, id)).json()).status).toBe("completed");
  });

  it("lets a late bridge failure keep a normal provider Hangup failed", async () => {
    const placed = await createPstnCall(callRequest("Say hello."), env, fakeFetch);
    const { id } = await placed.json();
    const providerRequest = requests.at(-1).payload;
    const answerPath = new URL(providerRequest.answer_url).pathname;
    const hangupPath = new URL(providerRequest.hangup_url).pathname;
    expect((await handleVobizCallback(unsignedCallback(answerPath, "StartApp"),
      env, "answer", id, answerPath.split("/").at(-1), fakeFetch)).status).toBe(200);
    expect((await handleVobizCallback(unsignedCallback(hangupPath, "Hangup", false,
      { CallStatus: "completed" }), env, "hangup", id, hangupPath.split("/").at(-1),
    fakeFetch)).status).toBe(200);
    expect((await (await getPstnCall(env, id)).json()).status).toBe("failed");
    expect((await SELF.fetch(`https://relay.example/v1/vobiz/bridge/calls/${id}/events`, {
      method: "POST", headers: { authorization: `Bearer ${BRIDGE}`,
        "content-type": "application/json" },
      body: JSON.stringify({ event: "failed", detail: "Opening speech timed out" }),
    })).status).toBe(200);
    expect((await (await getPstnCall(env, id)).json()).status).toBe("failed");
    expect(await env.DB.prepare(
      "SELECT bridge_terminal_event, provider_terminal_outcome FROM vobiz_pstn_calls WHERE id = ?1",
    ).bind(id).first()).toMatchObject({ bridge_terminal_event: "failed",
      provider_terminal_outcome: "completed" });
    expect((await SELF.fetch(`https://relay.example/v1/vobiz/bridge/calls/${id}/events`, {
      method: "POST", headers: { authorization: `Bearer ${BRIDGE}`,
        "content-type": "application/json" },
      body: JSON.stringify({ event: "ended", summary: "Delayed duplicate" }),
    })).status).toBe(200);
    expect(await (await getPstnCall(env, id)).json()).toMatchObject({ status: "failed",
      summary: null });
  });

  it("keeps the first terminal summary when a duplicate bridge report arrives", async () => {
    const placed = await createPstnCall(callRequest("Say hello."), env, fakeFetch);
    const { id } = await placed.json();
    const providerRequest = requests.at(-1).payload;
    const answerPath = new URL(providerRequest.answer_url).pathname;
    expect((await handleVobizCallback(unsignedCallback(answerPath, "StartApp"), env,
      "answer", id, answerPath.split("/").at(-1), fakeFetch)).status).toBe(200);
    const report = (summary) => SELF.fetch(
      `https://relay.example/v1/vobiz/bridge/calls/${id}/events`, {
        method: "POST", headers: { authorization: `Bearer ${BRIDGE}`,
          "content-type": "application/json" },
        body: JSON.stringify({ event: "ended", summary }),
      });
    expect((await report("The first call summary.")).status).toBe(200);
    expect((await report("A conflicting duplicate summary.")).status).toBe(200);
    expect(await (await getPstnCall(env, id)).json()).toMatchObject({ status: "completed",
      summary: "The first call summary.", bridge_terminal_event: "ended" });
  });

  it("lets provider media failure override an earlier successful bridge report", async () => {
    const placed = await createPstnCall(callRequest("Say hello."), env, fakeFetch);
    const { id } = await placed.json();
    const providerRequest = requests.at(-1).payload;
    const answerPath = new URL(providerRequest.answer_url).pathname;
    const hangupPath = new URL(providerRequest.hangup_url).pathname;
    expect((await handleVobizCallback(unsignedCallback(answerPath, "StartApp"), env,
      "answer", id, answerPath.split("/").at(-1), fakeFetch)).status).toBe(200);
    expect((await SELF.fetch(`https://relay.example/v1/vobiz/bridge/calls/${id}/events`, {
      method: "POST", headers: { authorization: `Bearer ${BRIDGE}`,
        "content-type": "application/json" },
      body: JSON.stringify({ event: "ended", summary: "A greeting played." }),
    })).status).toBe(200);
    expect((await (await getPstnCall(env, id)).json()).status).toBe("completed");
    expect((await handleVobizCallback(unsignedCallback(hangupPath, "Hangup", false,
      { CallStatus: "completed", HangupCause: "MEDIA_TIMEOUT" }), env, "hangup", id,
    hangupPath.split("/").at(-1), fakeFetch)).status).toBe(200);
    expect(await (await getPstnCall(env, id)).json()).toMatchObject({ status: "failed",
      provider_terminal_outcome: "failed", bridge_terminal_event: "ended",
      provider_status: "completed:MEDIA_TIMEOUT" });
    expect((await handleVobizCallback(unsignedCallback(hangupPath, "Hangup", false,
      { CallStatus: "completed", HangupCause: "NORMAL_CLEARING" }), env, "hangup", id,
    hangupPath.split("/").at(-1), fakeFetch)).status).toBe(200);
    expect(await (await getPstnCall(env, id)).json()).toMatchObject({ status: "failed",
      provider_status: "completed:MEDIA_TIMEOUT", provider_terminal_outcome: "failed" });
  });

  it("keeps an unanswered owner-canceled call canceled", async () => {
    const placed = await createPstnCall(callRequest("Say hello."), env, fakeFetch);
    const { id } = await placed.json();
    const hangupPath = new URL(requests.at(-1).payload.hangup_url).pathname;
    expect((await handleVobizCallback(unsignedCallback(hangupPath, "Hangup", false,
      { CallStatus: "canceled", HangupCause: "ORIGINATOR_CANCEL" }), env, "hangup", id,
    hangupPath.split("/").at(-1), fakeFetch)).status).toBe(200);
    expect(await (await getPstnCall(env, id)).json()).toMatchObject({ status: "canceled",
      provider_terminal_outcome: "canceled", bridge_terminal_event: null });
    expect((await handleVobizCallback(unsignedCallback(hangupPath, "Hangup", false,
      { CallStatus: "completed" }), env, "hangup", id, hangupPath.split("/").at(-1),
    fakeFetch)).status).toBe(200);
    expect((await (await getPstnCall(env, id)).json()).status).toBe("canceled");
  });

  it.each([
    ["completed", "completed:NORMAL_CLEARING", "failed", "MEDIA_TIMEOUT"],
    ["canceled", "canceled:ORIGINATOR_CANCEL", "completed", "NORMAL_CLEARING"],
  ])("preserves a legacy %s row without terminal evidence on duplicate Hangup",
    async (legacyStatus, legacyProviderStatus, callbackStatus, callbackCause) => {
      const placed = await createPstnCall(callRequest("Say hello."), env, fakeFetch);
      const { id } = await placed.json();
      const hangupPath = new URL(requests.at(-1).payload.hangup_url).pathname;
      const endedAt = Date.now() - 1_000;
      await env.DB.prepare(
        `UPDATE vobiz_pstn_calls SET status = ?2, provider_status = ?3,
          ended_at = ?4 WHERE id = ?1`,
      ).bind(id, legacyStatus, legacyProviderStatus, endedAt).run();
      expect((await handleVobizCallback(unsignedCallback(hangupPath, "Hangup", false,
        { CallStatus: callbackStatus, HangupCause: callbackCause }), env, "hangup", id,
      hangupPath.split("/").at(-1), fakeFetch)).status).toBe(200);
      expect(await (await getPstnCall(env, id)).json()).toMatchObject({ status: legacyStatus,
        provider_status: legacyProviderStatus, provider_terminal_outcome: null,
        bridge_terminal_event: null, ended_at: endedAt });
    });

  it.each(["bridge failure before provider cancel", "provider cancel before bridge failure"])(
    "keeps an authenticated %s as failed", async (ordering) => {
      const placed = await createPstnCall(callRequest("Say hello."), env, fakeFetch);
      const { id } = await placed.json();
      const hangupPath = new URL(requests.at(-1).payload.hangup_url).pathname;
      const failedReport = () => SELF.fetch(
        `https://relay.example/v1/vobiz/bridge/calls/${id}/events`, {
          method: "POST", headers: { authorization: `Bearer ${BRIDGE}`,
            "content-type": "application/json" },
          body: JSON.stringify({ event: "failed", detail: "Voice session unavailable" }),
        });
      const canceledHangup = () => handleVobizCallback(unsignedCallback(hangupPath, "Hangup", false,
        { CallStatus: "canceled", HangupCause: "ORIGINATOR_CANCEL" }), env, "hangup", id,
      hangupPath.split("/").at(-1), fakeFetch);
      if (ordering === "bridge failure before provider cancel") {
        expect((await failedReport()).status).toBe(200);
        expect((await canceledHangup()).status).toBe(200);
      } else {
        expect((await canceledHangup()).status).toBe(200);
        expect((await (await getPstnCall(env, id)).json()).status).toBe("canceled");
        expect((await failedReport()).status).toBe(200);
        expect((await canceledHangup()).status).toBe(200);
      }
      expect(await (await getPstnCall(env, id)).json()).toMatchObject({ status: "failed",
        provider_terminal_outcome: "canceled", bridge_terminal_event: "failed" });
    });

  it("does not let a stale Hangup row overwrite a concurrent bridge failure", async () => {
    const placed = await createPstnCall(callRequest("Say hello."), env, fakeFetch);
    const { id } = await placed.json();
    const providerRequest = requests.at(-1).payload;
    const answerPath = new URL(providerRequest.answer_url).pathname;
    const hangupPath = new URL(providerRequest.hangup_url).pathname;
    expect((await handleVobizCallback(unsignedCallback(answerPath, "StartApp"),
      env, "answer", id, answerPath.split("/").at(-1), fakeFetch)).status).toBe(200);
    const racedEnv = { ...env, DB: {
      prepare(query) {
        const statement = env.DB.prepare(query);
        if (query !== "SELECT * FROM vobiz_pstn_calls WHERE id = ?1") return statement;
        return { bind(...values) {
          const bound = statement.bind(...values);
          return { async first() {
            const stale = await bound.first();
            const failure = await SELF.fetch(
              `https://relay.example/v1/vobiz/bridge/calls/${id}/events`, {
                method: "POST", headers: { authorization: `Bearer ${BRIDGE}`,
                  "content-type": "application/json" },
                body: JSON.stringify({ event: "failed", detail: "Opening speech timed out" }),
              });
            expect(failure.status).toBe(200);
            return stale;
          } };
        } };
      },
    } };
    expect((await handleVobizCallback(unsignedCallback(hangupPath, "Hangup", false,
      { CallStatus: "completed" }), racedEnv, "hangup", id, hangupPath.split("/").at(-1),
    fakeFetch)).status).toBe(200);
    expect((await (await getPstnCall(env, id)).json()).status).toBe("failed");
  });

  it("keeps an ended bridge report successful when Hangup read a stale row", async () => {
    const placed = await createPstnCall(callRequest("Say hello."), env, fakeFetch);
    const { id } = await placed.json();
    const providerRequest = requests.at(-1).payload;
    const answerPath = new URL(providerRequest.answer_url).pathname;
    const hangupPath = new URL(providerRequest.hangup_url).pathname;
    expect((await handleVobizCallback(unsignedCallback(answerPath, "StartApp"), env,
      "answer", id, answerPath.split("/").at(-1), fakeFetch)).status).toBe(200);
    const racedEnv = { ...env, DB: {
      prepare(query) {
        const statement = env.DB.prepare(query);
        if (query !== "SELECT * FROM vobiz_pstn_calls WHERE id = ?1") return statement;
        return { bind(...values) {
          const bound = statement.bind(...values);
          return { async first() {
            const stale = await bound.first();
            const ended = await SELF.fetch(
              `https://relay.example/v1/vobiz/bridge/calls/${id}/events`, {
                method: "POST", headers: { authorization: `Bearer ${BRIDGE}`,
                  "content-type": "application/json" },
                body: JSON.stringify({ event: "ended", summary: "Greeting delivered." }),
              });
            expect(ended.status).toBe(200);
            return stale;
          } };
        } };
      },
    } };
    expect((await handleVobizCallback(unsignedCallback(hangupPath, "Hangup", false,
      { CallStatus: "completed" }), racedEnv, "hangup", id, hangupPath.split("/").at(-1),
    fakeFetch)).status).toBe(200);
    expect(await (await getPstnCall(env, id)).json()).toMatchObject({ status: "completed",
      provider_terminal_outcome: "completed", bridge_terminal_event: "ended" });
  });

  it("does not promote a reported provider media failure after a stale bridge read", async () => {
    const placed = await createPstnCall(callRequest("Say hello."), env, fakeFetch);
    const { id } = await placed.json();
    const providerRequest = requests.at(-1).payload;
    const answerPath = new URL(providerRequest.answer_url).pathname;
    const hangupPath = new URL(providerRequest.hangup_url).pathname;
    expect((await handleVobizCallback(unsignedCallback(answerPath, "StartApp"), env,
      "answer", id, answerPath.split("/").at(-1), fakeFetch)).status).toBe(200);
    const racedEnv = { ...env, DB: {
      prepare(query) {
        const statement = env.DB.prepare(query);
        if (query !== "SELECT * FROM vobiz_pstn_calls WHERE id = ?1") return statement;
        return { bind(...values) {
          const bound = statement.bind(...values);
          return { async first() {
            const stale = await bound.first();
            const hungup = await handleVobizCallback(unsignedCallback(hangupPath, "Hangup", false,
              { CallStatus: "completed", HangupCause: "MEDIA_TIMEOUT" }), env, "hangup", id,
            hangupPath.split("/").at(-1), fakeFetch);
            expect(hungup.status).toBe(200);
            return stale;
          } };
        } };
      },
    } };
    const report = await bridgeCallEvent(new Request(
      `https://relay.example/v1/vobiz/bridge/calls/${id}/events`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ event: "ended", summary: "A partial greeting played." }),
      }), racedEnv, id);
    expect(report.status).toBe(200);
    expect(await (await getPstnCall(env, id)).json()).toMatchObject({ status: "failed",
      provider_status: "completed:MEDIA_TIMEOUT", provider_terminal_outcome: "failed",
      bridge_terminal_event: "ended" });
  });

  it("expires interrupted preparation and blocks its suspended request from dialing", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const startedAt = Date.now();
    const key = crypto.randomUUID();
    const seen = [];
    let callID;
    const fetcher = async (input) => {
      const url = new URL(input);
      seen.push(url.pathname);
      if (url.pathname === "/health") return Response.json({ ok: true, codex_ready: true });
      if (url.pathname.startsWith("/prepare/")) {
        callID = url.pathname.split("/").at(-1);
        vi.setSystemTime(startedAt + 61_000);
        const expired = await getPstnCall(env, callID, fetcher);
        expect(await expired.json()).toMatchObject({ id: callID, status: "failed",
          provider_status: "prepare_interrupted" });
        return Response.json({ ok: true, prepared: true });
      }
      if (url.pathname.startsWith("/cancel/")) return Response.json({ ok: true, cancelled: true });
      throw new Error("an interrupted preparation must not reach Vobiz");
    };
    const result = await createPstnCall(callRequest("Greet me.", key), env, fetcher);
    expect(result.status).toBe(409);
    expect(await result.json()).toMatchObject({ error: "dispatch_not_permitted",
      call: { id: callID, status: "failed", provider_status: "prepare_interrupted" } });
    expect(seen).toEqual(["/health", `/prepare/${callID}`, `/cancel/${callID}`,
      `/cancel/${callID}`]);
    const retry = await createPstnCall(callRequest("Greet me.", key), env, fetcher);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ id: callID, status: "failed",
      provider_status: "prepare_interrupted" });
    expect(seen).toHaveLength(4);
  });

  it("refuses to dial when a preparation itself resumes after its age limit", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const startedAt = Date.now();
    const seen = [];
    let callID;
    const fetcher = async (input) => {
      const url = new URL(input);
      seen.push(url.pathname);
      if (url.pathname === "/health") return Response.json({ ok: true, codex_ready: true });
      if (url.pathname.startsWith("/prepare/")) {
        callID = url.pathname.split("/").at(-1);
        vi.setSystemTime(startedAt + 61_000);
        return Response.json({ ok: true, prepared: true });
      }
      if (url.pathname.startsWith("/cancel/")) return Response.json({ ok: true, cancelled: true });
      throw new Error("expired preparation must not reach Vobiz");
    };
    const result = await createPstnCall(callRequest("Greet me."), env, fetcher);
    expect(result.status).toBe(409);
    expect(await result.json()).toMatchObject({ error: "dispatch_not_permitted",
      call: { id: callID, status: "failed", provider_status: "prepare_interrupted" } });
    expect(seen).toEqual(["/health", `/prepare/${callID}`, `/cancel/${callID}`,
      `/cancel/${callID}`]);
  });

  it("cleans a stale preparation before admitting a different call", async () => {
    const staleID = crypto.randomUUID();
    const createdAt = Date.now() - 61_000;
    await env.DB.prepare(
      `INSERT INTO vobiz_pstn_calls
        (id, direction, from_number, to_number, instructions, opening_speech,
         callback_token_hash, status, provider_status, idempotency_key, request_hash,
         created_at, updated_at)
       VALUES (?1, 'outbound', ?2, ?3, 'old brief', 'Old AI greeting',
         ?4, 'dispatching', 'preparing_voice', ?5, ?6, ?7, ?7)`,
    ).bind(staleID, DID, DESTINATION, "a".repeat(64), crypto.randomUUID(),
      "b".repeat(64), createdAt).run();
    const seen = [];
    let occupied = true;
    const fetcher = async (input) => {
      const url = new URL(input);
      seen.push(url.pathname);
      if (url.pathname === `/cancel/${staleID}`) {
        occupied = false;
        return Response.json({ ok: true, cancelled: true });
      }
      if (url.pathname === "/health") return Response.json({ ok: true, codex_ready: !occupied });
      if (url.pathname.startsWith("/prepare/")) return Response.json({ ok: true, prepared: true });
      if (url.origin === "https://api.vobiz.ai") return Response.json({ request_uuid: PROVIDER_ID });
      throw new Error(`unexpected fetch: ${url.pathname}`);
    };
    const newCall = await createPstnCall(callRequest("Greet me."), env, fetcher);
    expect(newCall.status).toBe(201);
    expect(seen[0]).toBe(`/cancel/${staleID}`);
    expect(seen[1]).toBe("/health");
    expect((await env.DB.prepare(
      "SELECT status, provider_status, ended_at FROM vobiz_pstn_calls WHERE id = ?1",
    ).bind(staleID).first())).toMatchObject({ status: "failed",
      provider_status: "prepare_interrupted", ended_at: expect.any(Number) });
    expect(seen.filter((path) => path === "/api/v1/Account/test-auth/Call/")).toHaveLength(1);
  });

  it("reads only the queued, live, or CDR state for an existing local call", async () => {
    const placed = await createPstnCall(callRequest("Say hello."), env, fakeFetch);
    const { id } = await placed.json();
    const endpoint = `https://relay.example/v1/pstn-calls/${id}/provider-status`;
    expect((await SELF.fetch(endpoint)).status).toBe(401);
    expect((await SELF.fetch(endpoint, { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
    expect((await SELF.fetch(`${endpoint}?status=live`, {
      headers: { authorization: `Bearer ${AGENT}` },
    })).status).toBe(400);
    expect((await SELF.fetch(`https://relay.example/v1/pstn-calls/${crypto.randomUUID()}/provider-status`, {
      headers: { authorization: `Bearer ${AGENT}` },
    })).status).toBe(404);

    const before = await env.DB.prepare(
      "SELECT status, provider_status, updated_at, ended_at FROM vobiz_pstn_calls WHERE id = ?1",
    ).bind(id).first();
    const probed = [];
    const providerFetch = (answers) => async (input, init) => {
      const url = new URL(input);
      probed.push(url.toString());
      expect(init.method).toBe("GET");
      expect(init.redirect).toBe("manual");
      expect(init.headers["x-auth-id"]).toBe(env.VOBIZ_AUTH_ID);
      expect(init.headers["x-auth-token"]).toBe(env.VOBIZ_AUTH_TOKEN);
      expect(url.origin).toBe("https://api.vobiz.ai");
      expect(url.pathname).toContain(PROVIDER_ID);
      return answers.shift();
    };
    const queued = await getPstnProviderStatus(env, id, providerFetch([
      Response.json({ call_uuid: PROVIDER_ID, call_status: "queued", from: DID, to: DESTINATION }),
    ]));
    expect(await queued.json()).toEqual({ call_id: id, provider: { source: "queued", state: "queued" } });
    expect(probed.at(-1)).toContain("?status=queued");

    probed.length = 0;
    const live = await getPstnProviderStatus(env, id, providerFetch([
      new Response(null, { status: 404 }),
      Response.json({ call_uuid: PROVIDER_ID, call_status: "in-progress", from: DID, to: DESTINATION }),
    ]));
    expect(await live.json()).toEqual({ call_id: id, provider: { source: "live", state: "in-progress" } });
    expect(probed.map((url) => new URL(url).search)).toEqual(["?status=queued", "?status=live"]);

    probed.length = 0;
    const cdr = await getPstnProviderStatus(env, id, providerFetch([
      new Response(null, { status: 404 }), new Response(null, { status: 404 }),
      Response.json({ data: { uuid: PROVIDER_ID, hangup_cause: "NO_ANSWER",
        hangup_cause_code: 6010, failure_code: "NO_ANSWER",
        ring_time: 0, answer_time: null, duration: 6, billsec: 0,
        hangup_source: "Caller", hangup_disposition: "send_bye",
        failure_reason: "Subscriber private text", start_time: "2026-09-29T15:00:00Z",
        caller_id_number: DID, destination_number: DESTINATION } }),
    ]));
    expect(await cdr.json()).toEqual({ call_id: id, provider: { source: "cdr", state: "ended",
      hangup_cause: "NO_ANSWER", hangup_cause_code: "6010", failure_code: "NO_ANSWER",
      ring_time_seconds: 0, answer_time_present: false, duration: 6, billsec: 0,
      hangup_source: "Caller", hangup_disposition: "send_bye" } });
    expect(probed.map((url) => new URL(url).pathname.includes("/Call/") ? "Call" : "cdr"))
      .toEqual(["Call", "Call", "cdr"]);
    expect(await env.DB.prepare(
      "SELECT status, provider_status, updated_at, ended_at FROM vobiz_pstn_calls WHERE id = ?1",
    ).bind(id).first()).toEqual(before);

    const answered = await getPstnProviderStatus(env, id, providerFetch([
      new Response(null, { status: 404 }), new Response(null, { status: 404 }),
      Response.json({ uuid: PROVIDER_ID, ring_time: 5, answer_time: "2026-09-29T15:00:05Z",
        duration: 12, billsec: 7, hangup_cause: "NORMAL_CLEARING",
        codec: "PCMU", mos: 4.2, jitter: 18.5, packet_loss: 0.5,
        hangup_source: "Callee", hangup_disposition: "recv_bye",
        caller_id_number: DID, destination_number: DESTINATION }),
    ]));
    expect(await answered.json()).toEqual({ call_id: id, provider: { source: "cdr", state: "ended",
      hangup_cause: "NORMAL_CLEARING", hangup_cause_code: null, failure_code: null,
      ring_time_seconds: 5, answer_time_present: true, duration: 12, billsec: 7,
      codec: "PCMU", mos: 4.2, jitter_ms: 18.5, packet_loss_percent: 0.5,
      hangup_source: "Callee", hangup_disposition: "recv_bye" } });
  });

  it("keeps provider errors, oversized bodies, and mismatched UUIDs opaque", async () => {
    const placed = await createPstnCall(callRequest("Say hello."), env, fakeFetch);
    const { id } = await placed.json();
    const failed = await getPstnProviderStatus(env, id, async () =>
      new Response("private provider failure with a phone number", { status: 403 }));
    expect(await failed.json()).toEqual({ error: "provider_lookup_failed", provider_http_status: 403 });
    const mismatched = await getPstnProviderStatus(env, id, async () =>
      Response.json({ call_uuid: crypto.randomUUID(), call_status: "queued", to: DESTINATION }));
    expect(await mismatched.json()).toEqual({ error: "provider_response_invalid" });
    const invalidMetrics = await getPstnProviderStatus(env, id, async (input) =>
      new URL(input).search ? new Response(null, { status: 404 }) :
        Response.json({ uuid: PROVIDER_ID, hangup_cause: "NORMAL_CLEARING",
          ring_time: null, answer_time: "", duration: -1, billsec: 100_000,
          codec: "private codec value with spaces", mos: "4.5", jitter: -2, packet_loss: 101,
          hangup_source: "free-form private text", hangup_disposition: "unexpected" }));
    expect(await invalidMetrics.json()).toEqual({ call_id: id, provider: { source: "cdr", state: "ended",
      hangup_cause: "NORMAL_CLEARING", hangup_cause_code: null, failure_code: null,
      answer_time_present: false,
      hangup_source: null, hangup_disposition: null } });
    const oversized = await getPstnProviderStatus(env, id, async () =>
      Response.json({ call_uuid: PROVIDER_ID, call_status: "queued", padding: "x".repeat(17_000) }));
    expect(await oversized.json()).toEqual({ error: "provider_lookup_unavailable" });
    const notFound = await getPstnProviderStatus(env, id, async () => new Response(null, { status: 404 }));
    expect(await notFound.json()).toEqual({ error: "provider_record_not_found" });
    await env.DB.prepare("UPDATE vobiz_pstn_calls SET vobiz_call_uuid = NULL WHERE id = ?1").bind(id).run();
    const noUUID = await getPstnProviderStatus(env, id, async () => {
      throw new Error("provider must not be queried without a stored UUID");
    });
    expect(await noUUID.json()).toEqual({ error: "provider_call_id_unavailable" });
  });

  it("reconciles only a final CDR and is idempotent", async () => {
    const placed = await createPstnCall(callRequest("Say hello."), env, fakeFetch);
    const { id } = await placed.json();
    const endpoint = `https://relay.example/v1/pstn-calls/${id}/reconcile`;
    expect((await SELF.fetch(endpoint, { method: "POST" })).status).toBe(401);
    expect((await SELF.fetch(`${endpoint}?force=true`, { method: "POST",
      headers: { authorization: `Bearer ${AGENT}` } })).status).toBe(400);
    expect((await SELF.fetch(`https://relay.example/v1/pstn-calls/${crypto.randomUUID()}/reconcile`, {
      method: "POST", headers: { authorization: `Bearer ${AGENT}` },
    })).status).toBe(404);

    const before = await env.DB.prepare(
      "SELECT status, provider_status, updated_at, ended_at FROM vobiz_pstn_calls WHERE id = ?1",
    ).bind(id).first();
    const providerFetch = (source) => async (input) => {
      const url = new URL(input);
      if (url.searchParams.get("status") === "queued") {
        return source === "queued"
          ? Response.json({ call_uuid: PROVIDER_ID, call_status: "queued" })
          : new Response(null, { status: 404 });
      }
      if (url.searchParams.get("status") === "live") {
        return source === "live"
          ? Response.json({ call_uuid: PROVIDER_ID, call_status: "in-progress" })
          : new Response(null, { status: 404 });
      }
      return Response.json({ uuid: PROVIDER_ID, hangup_cause: "NORMAL_CLEARING",
        ring_time: 0, answer_time: null, duration: 2, billsec: 0,
        destination_number: DESTINATION });
    };
    for (const source of ["queued", "live"]) {
      const response = await reconcilePstnCall(env, id, providerFetch(source));
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: "provider_call_not_final",
        provider: { source }, call: { id, status: "queued" } });
      expect(await env.DB.prepare(
        "SELECT status, provider_status, updated_at, ended_at FROM vobiz_pstn_calls WHERE id = ?1",
      ).bind(id).first()).toEqual(before);
    }

    const completed = await reconcilePstnCall(env, id, providerFetch("cdr"));
    expect(completed.status).toBe(200);
    expect(await completed.json()).toMatchObject({ id, status: "failed",
      provider_status: "provider_ended_without_callback" });
    const after = await env.DB.prepare(
      "SELECT status, provider_status, updated_at, ended_at FROM vobiz_pstn_calls WHERE id = ?1",
    ).bind(id).first();
    expect(after.ended_at).toEqual(expect.any(Number));
    const repeated = await reconcilePstnCall(env, id, async () => {
      throw new Error("a reconciled call must not be probed again");
    });
    expect(await repeated.json()).toMatchObject({ id, status: "failed",
      provider_status: "provider_ended_without_callback" });
    expect(await env.DB.prepare(
      "SELECT status, provider_status, updated_at, ended_at FROM vobiz_pstn_calls WHERE id = ?1",
    ).bind(id).first()).toEqual(after);
    expect((await SELF.fetch(endpoint, { method: "POST",
      headers: { authorization: `Bearer ${AGENT}` },
    })).status).toBe(200);
  });

  it.each([
    ["connected callback", "UPDATE vobiz_pstn_calls SET status = 'connected' WHERE id = ?1", "connected"],
    ["bridge claim", "UPDATE vobiz_pstn_calls SET bridge_claimed_at = 123 WHERE id = ?1", "queued"],
    ["terminal callback", "UPDATE vobiz_pstn_calls SET status = 'failed', ended_at = 123 WHERE id = ?1", "failed"],
  ])("preserves a %s racing with CDR reconciliation", async (_, update, expectedStatus) => {
    const placed = await createPstnCall(callRequest("Say hello."), env, fakeFetch);
    const { id } = await placed.json();
    const response = await reconcilePstnCall(env, id, async (input) => {
      const url = new URL(input);
      if (url.search) return new Response(null, { status: 404 });
      await env.DB.prepare(update).bind(id).run();
      return Response.json({ uuid: PROVIDER_ID, hangup_cause: "NORMAL_CLEARING", billsec: 0 });
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id, status: expectedStatus,
      provider_status: "accepted" });
    const row = await env.DB.prepare(
      "SELECT status, provider_status, bridge_claimed_at, ended_at FROM vobiz_pstn_calls WHERE id = ?1",
    ).bind(id).first();
    expect(row.status).toBe(expectedStatus);
    expect(row.provider_status).toBe("accepted");
    if (expectedStatus === "queued") expect(row.bridge_claimed_at).toBe(123);
    if (expectedStatus === "failed") expect(row.ended_at).toBe(123);
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
