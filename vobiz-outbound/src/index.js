const E164_INDIA = /^\+91[1-9]\d{9}$/;
const CALLBACK_BYTES = 16_384;
const MAX_CALL_MS = 3 * 60_000;
const MAX_OPENING_SPEECH_CHARS = 320;
const OUTBOUND_OPENING = "Hello, I'm Chirag's AI assistant, calling on his behalf. Is this a good time?";

function callbackConfigured(env) {
  return Boolean(
    env.VOBIZ_AUTH_ID && env.VOBIZ_AUTH_TOKEN && env.VOBIZ_NUMBER &&
    env.VOBIZ_PUBLIC_BASE_URL &&
    env.VOBIZ_BRIDGE_WSS_URL && env.VOBIZ_BRIDGE_SECRET &&
    env.VOBIZ_BRIDGE_RELAY_TOKEN,
  );
}

function outboundConfigured(env) {
  return env.VOBIZ_OUTBOUND_ENABLED === "true" && callbackConfigured(env) &&
    Boolean(env.HERMES_PSTN_TOKEN && env.VOBIZ_ALLOWED_DESTINATIONS);
}

function json(status, body) {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

function isUUID(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value || "");
}

function validIdempotencyKey(value) {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

async function hashCredential(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function validBearer(request, secret) {
  const supplied = request.headers.get("authorization")?.match(/^Bearer\s+([^\s]+)$/i)?.[1];
  return secretEqual(supplied, secret);
}

async function secretEqual(supplied, secret) {
  if (!supplied || !secret) return false;
  const challenge = new TextEncoder().encode("caller-vobiz-bearer-v1");
  const [expected, candidate] = await Promise.all([
    crypto.subtle.importKey("raw", new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" }, false, ["verify"]),
    crypto.subtle.importKey("raw", new TextEncoder().encode(supplied),
      { name: "HMAC", hash: "SHA-256" }, false, ["sign"]),
  ]);
  const signature = await crypto.subtle.sign("HMAC", candidate, challenge);
  return crypto.subtle.verify("HMAC", expected, signature, challenge);
}

function normalizedNumber(value) {
  if (typeof value !== "string") return null;
  const number = value.trim();
  return E164_INDIA.test(number) ? number : null;
}

function normalizedCallbackNumber(value) {
  if (typeof value !== "string") return null;
  const number = value.trim().replace(/[ ()-]/g, "");
  if (/^[1-9]\d{9}$/.test(number)) return normalizedNumber(`+91${number}`);
  if (/^91[1-9]\d{9}$/.test(number)) return normalizedNumber(`+${number}`);
  return normalizedNumber(number);
}

function normalizedOpeningSpeech(value) {
  if (typeof value !== "string") return null;
  const speech = value.normalize("NFC").replace(/[\t\r\n ]+/g, " ").trim();
  if (!speech || speech.length > MAX_OPENING_SPEECH_CHARS ||
      /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(speech)) return null;
  return speech;
}

function baseURL(env) {
  try {
    const url = new URL(env.VOBIZ_PUBLIC_BASE_URL);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") return null;
    return url.origin;
  } catch {
    return null;
  }
}

function bridgeURL(env) {
  try {
    const url = new URL(env.VOBIZ_BRIDGE_WSS_URL);
    if (url.protocol !== "wss:" || url.username || url.password || url.search || url.hash) return null;
    return url;
  } catch {
    return null;
  }
}

function publicCall(row) {
  return {
    id: row.id,
    direction: row.direction,
    status: row.status,
    from_number: row.from_number,
    to_number: row.to_number,
    summary: row.summary,
    created_at: row.created_at,
    ended_at: row.ended_at,
  };
}

function xmlResponse(xml, status = 200) {
  return new Response(xml, {
    status,
    headers: { "cache-control": "no-store", "content-type": "application/xml; charset=utf-8" },
  });
}

function callbackAcknowledged() {
  return json(200, { status: "received" });
}

function base64url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function hmac(keyValue, message) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(keyValue), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)));
}

export async function bridgeToken(secret, call, now = Date.now()) {
  const payload = base64url(new TextEncoder().encode(JSON.stringify({
    v: 1, id: call.id, exp: Math.floor(now / 1000) + 180, direction: call.direction,
  })));
  return `${payload}.${base64url(await hmac(secret, payload))}`;
}

function streamXML(url) {
  const escaped = url.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Stream bidirectional="true" keepCallAlive="true" contentType="audio/x-l16;rate=16000">${escaped}</Stream></Response>`;
}

async function bridgeReady(env, fetcher = fetch) {
  const url = bridgeURL(env);
  if (!url) return false;
  url.protocol = "https:";
  url.pathname = url.pathname.replace(/\/[^/]*$/, "/health");
  try {
    const response = await fetcher(url.toString(), { signal: AbortSignal.timeout(2_000) });
    if (!response.ok) return false;
    const state = await response.json();
    return state?.ok === true && state?.codex_ready === true;
  } catch (error) {
    console.error(JSON.stringify({ message: "Vobiz Codex bridge health unavailable", error: String(error) }));
    return false;
  }
}

export async function createPstnCall(request, env, fetcher = fetch) {
  if (!outboundConfigured(env) || !baseURL(env) || !bridgeURL(env)) {
    return json(503, { error: "vobiz_outbound_not_configured" });
  }
  const idempotencyKey = request.headers.get("idempotency-key");
  if (!validIdempotencyKey(idempotencyKey)) return json(400, { error: "valid_idempotency_key_required" });
  let body;
  try {
    body = JSON.parse(await boundedText(request, CALLBACK_BYTES));
  } catch {
    return json(400, { error: "invalid_request_body" });
  }
  const to = normalizedNumber(body?.to);
  const briefing = typeof body?.briefing === "string" ? body.briefing.trim() : "";
  if (!to || !briefing || briefing.length > 2_000 || /[\u0000-\u001f]/.test(briefing)) {
    return json(400, { error: "invalid_destination_or_briefing" });
  }
  const openingSpeech = body?.opening_speech === undefined
    ? OUTBOUND_OPENING : normalizedOpeningSpeech(body.opening_speech);
  if (!openingSpeech) return json(400, { error: "invalid_opening_speech" });
  if (!/\b(?:AI|artificial intelligence)\b/i.test(openingSpeech)) {
    return json(400, { error: "opening_speech_must_disclose_ai" });
  }
  const allowedDestinations = String(env.VOBIZ_ALLOWED_DESTINATIONS).split(",").map((value) => value.trim());
  if (!allowedDestinations.includes(to)) return json(403, { error: "destination_not_allowlisted" });
  const from = normalizedNumber(env.VOBIZ_NUMBER);
  if (!from) return json(503, { error: "invalid_vobiz_number_configuration" });
  const requestHash = await hashCredential(JSON.stringify({ to, briefing, openingSpeech }));
  const prior = await env.DB.prepare(
    "SELECT * FROM vobiz_pstn_calls WHERE idempotency_key = ?1",
  ).bind(idempotencyKey).first();
  if (prior) {
    return prior.request_hash === requestHash
      ? json(200, publicCall(prior))
      : json(409, { error: "idempotency_key_conflict" });
  }
  const activeAfter = Date.now() - MAX_CALL_MS - 60_000;
  const active = await env.DB.prepare(
    `SELECT id FROM vobiz_pstn_calls WHERE ended_at IS NULL
       AND status IN ('dispatching', 'queued', 'ringing', 'connected', 'dispatch_unknown')
       AND created_at > ?1 LIMIT 1`,
  ).bind(activeAfter).first();
  if (active) {
    const raced = await env.DB.prepare(
      "SELECT * FROM vobiz_pstn_calls WHERE idempotency_key = ?1",
    ).bind(idempotencyKey).first();
    if (raced) return raced.request_hash === requestHash
      ? json(200, publicCall(raced))
      : json(409, { error: "idempotency_key_conflict" });
    return json(409, { error: "another_call_active" });
  }
  if (!(await bridgeReady(env, fetcher))) return json(503, { error: "codex_bridge_unavailable" });
  const now = Date.now();
  const id = crypto.randomUUID();
  const callbackToken = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const inserted = await env.DB.prepare(
    `INSERT INTO vobiz_pstn_calls
      (id, direction, from_number, to_number, instructions, opening_speech, callback_token_hash,
       status, idempotency_key, request_hash, created_at, updated_at)
     SELECT ?1, 'outbound', ?2, ?3, ?4, ?5, ?6, 'dispatching', ?7, ?8, ?9, ?9
       WHERE NOT EXISTS (
         SELECT 1 FROM vobiz_pstn_calls WHERE ended_at IS NULL
           AND status IN ('dispatching', 'queued', 'ringing', 'connected', 'dispatch_unknown')
           AND created_at > ?10
       )
     ON CONFLICT(idempotency_key) DO NOTHING`,
  ).bind(id, from, to, briefing, openingSpeech,
    await hashCredential(callbackToken), idempotencyKey, requestHash, now, activeAfter).run();
  if (!inserted.meta.changes) {
    const raced = await env.DB.prepare(
      "SELECT * FROM vobiz_pstn_calls WHERE idempotency_key = ?1",
    ).bind(idempotencyKey).first();
    if (raced) return raced.request_hash === requestHash
      ? json(200, publicCall(raced))
      : json(409, { error: "idempotency_key_conflict" });
    return json(409, { error: "another_call_active" });
  }

  const origin = baseURL(env);
  const callback = (kind) => `${origin}/v1/vobiz/${kind}/${id}/${callbackToken}`;
  const payload = {
    from, to,
    answer_url: callback("answer"), answer_method: "POST",
    ring_url: callback("ring"), ring_method: "POST",
    hangup_url: callback("hangup"), hangup_method: "POST",
    time_limit: Math.floor(MAX_CALL_MS / 1000), hangup_on_ring: 30,
  };
  // Reserve the rolling dispatch interval immediately before the provider request.
  if (!(await allowOutbound(env))) {
    const stoppedAt = Date.now();
    await env.DB.prepare(
      `UPDATE vobiz_pstn_calls SET status = 'failed', provider_status = 'rate_limited',
          updated_at = ?2, ended_at = ?2 WHERE id = ?1 AND status = 'dispatching'`,
    ).bind(id, stoppedAt).run();
    return json(429, { error: "rate_limited", id });
  }
  let status = "dispatch_unknown";
  let providerStatus = "transport_failure";
  let providerUUID = null;
  try {
    const response = await fetcher(`https://api.vobiz.ai/api/v1/Account/${encodeURIComponent(env.VOBIZ_AUTH_ID)}/Call/`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-auth-id": env.VOBIZ_AUTH_ID,
        "x-auth-token": env.VOBIZ_AUTH_TOKEN,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      status = response.status >= 500 ? "dispatch_unknown" : "failed";
      providerStatus = `http_${response.status}`;
    } else {
      const result = await response.json();
      providerUUID = isUUID(result?.request_uuid) ? result.request_uuid.toLowerCase() : null;
      status = providerUUID ? "queued" : "dispatch_unknown";
      providerStatus = providerUUID ? "accepted" : "missing_request_uuid";
    }
  } catch {
    // A timeout may occur after Vobiz accepted the request. Never issue a second call automatically.
  }
  await env.DB.prepare(
    `UPDATE vobiz_pstn_calls
        SET status = CASE WHEN status = 'dispatching' THEN ?2 ELSE status END,
            provider_status = ?3, vobiz_call_uuid = COALESCE(vobiz_call_uuid, ?4), updated_at = ?5,
            ended_at = CASE WHEN ?2 = 'failed' THEN ?5 ELSE ended_at END
      WHERE id = ?1`,
  ).bind(id, status, providerStatus, providerUUID, Date.now()).run();
  const call = await env.DB.prepare("SELECT * FROM vobiz_pstn_calls WHERE id = ?1").bind(id).first();
  return json(status === "failed" ? 502 : 201, publicCall(call));
}

export async function getPstnCall(env, callID) {
  if (!isUUID(callID)) return json(404, { error: "call_not_found" });
  const row = await env.DB.prepare(
    "SELECT * FROM vobiz_pstn_calls WHERE id = ?1",
  ).bind(callID.toLowerCase()).first();
  return row ? json(200, publicCall(row)) : json(404, { error: "call_not_found" });
}

async function boundedText(request, limit) {
  const header = request.headers.get("content-length");
  if (header && Number(header) > limit) throw new Error("body_too_large");
  if (!request.body) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let total = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) throw new Error("body_too_large");
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

async function verifiedCallback(request, env) {
  const origin = baseURL(env);
  const url = new URL(request.url);
  if (!origin || url.origin !== origin || url.search || url.hash) return null;
  // Legacy V1 and MA-only headers do not imply a standard V2/V3 signature is present.
  const hasSignatureHeader = request.headers.has("x-vobiz-signature-v3") ||
    request.headers.has("x-vobiz-signature-v2");
  let nonce = null;
  if (hasSignatureHeader) {
    const version = request.headers.has("x-vobiz-signature-v3") ? "v3" : "v2";
    const signature = request.headers.get(`x-vobiz-signature-${version}`);
    nonce = request.headers.get(`x-vobiz-signature-${version}-nonce`);
    if (!signature || !/^\d{20}$/.test(nonce || "")) return null;
    let signatureBytes;
    try {
      signatureBytes = Uint8Array.from(atob(signature), (character) => character.charCodeAt(0));
    } catch {
      return null;
    }
    if (signatureBytes.byteLength !== 32) return null;
    const key = await crypto.subtle.importKey(
      "raw", new TextEncoder().encode(env.VOBIZ_AUTH_TOKEN),
      { name: "HMAC", hash: "SHA-256" }, false, ["verify"],
    );
    const message = `${origin}${url.pathname}${version === "v3" ? "." : ""}${nonce}`;
    if (!(await crypto.subtle.verify("HMAC", key, signatureBytes, new TextEncoder().encode(message)))) return null;
  }
  let raw;
  try {
    raw = await boundedText(request, CALLBACK_BYTES);
  } catch {
    return null;
  }
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/x-www-form-urlencoded")) return null;
  const params = new URLSearchParams(raw);
  if (params.get("auth_id") !== env.VOBIZ_AUTH_ID || !isUUID(params.get("CallUUID"))) return null;
  if (nonce) {
    const bodyHash = await hashCredential(raw);
    const pathHash = await hashCredential(url.pathname);
    const reserved = await env.DB.prepare(
      `INSERT INTO vobiz_callback_nonces (nonce, path_hash, body_hash, received_at)
       VALUES (?1, ?2, ?3, ?4) ON CONFLICT(nonce) DO NOTHING`,
    ).bind(nonce, pathHash, bodyHash, Date.now()).run();
    if (!reserved.meta.changes) {
      const prior = await env.DB.prepare(
        "SELECT path_hash, body_hash FROM vobiz_callback_nonces WHERE nonce = ?1",
      ).bind(nonce).first();
      if (prior?.path_hash !== pathHash || prior?.body_hash !== bodyHash) return null;
    }
    // Nonces need only outlive Vobiz's callback retry window. Keep this bounded without a cron trigger.
    try {
      await env.DB.prepare("DELETE FROM vobiz_callback_nonces WHERE received_at < ?1")
        .bind(Date.now() - 24 * 60 * 60_000).run();
    } catch {
      console.error(JSON.stringify({ message: "Vobiz callback nonce cleanup failed" }));
    }
  }
  return params;
}

export async function handleVobizCallback(request, env, kind, callID, callbackToken, fetcher = fetch) {
  if (!["answer", "ring", "hangup"].includes(kind)) return json(404, { error: "not_found" });
  if (!callbackConfigured(env) || !baseURL(env) || !bridgeURL(env)) {
    return json(503, { error: "vobiz_not_configured" });
  }
  if (!isUUID(callID)) return json(404, { error: "call_not_found" });
  const row = await env.DB.prepare("SELECT * FROM vobiz_pstn_calls WHERE id = ?1")
    .bind(callID.toLowerCase()).first();
  if (!row || !(await secretEqual(await hashCredential(callbackToken || ""), row.callback_token_hash))) {
    return json(403, { error: "invalid_vobiz_callback_token" });
  }
  const params = await verifiedCallback(request, env);
  if (!params) return json(403, { error: "invalid_vobiz_callback" });
  const event = params.get("Event");
  const eventExpected = { answer: "StartApp", ring: "Ring", hangup: "Hangup" };
  if (event !== eventExpected[kind]) return json(400, { error: "unexpected_vobiz_event" });
  const providerUUID = params.get("CallUUID").toLowerCase();
  const from = normalizedCallbackNumber(params.get("From"));
  const to = normalizedCallbackNumber(params.get("To"));
  if (row.direction !== "outbound" ||
    (params.has("To") && row.to_number !== to) ||
    (params.has("From") && row.from_number !== from) ||
    (row.vobiz_call_uuid && row.vobiz_call_uuid !== providerUUID)) {
    return json(403, { error: "vobiz_call_mismatch" });
  }
  if (row.ended_at && kind !== "hangup") return xmlResponse("<?xml version=\"1.0\"?><Response><Hangup/></Response>");
  if (kind === "answer") {
    if (!(await bridgeReady(env, fetcher))) {
      const now = Date.now();
      await env.DB.prepare(
        `UPDATE vobiz_pstn_calls SET status = 'failed', provider_status = 'codex_bridge_unavailable',
            vobiz_call_uuid = COALESCE(vobiz_call_uuid, ?2), updated_at = ?3, ended_at = ?3
          WHERE id = ?1 AND ended_at IS NULL`,
      ).bind(row.id, providerUUID, now).run();
      return xmlResponse("<?xml version=\"1.0\"?><Response><Hangup/></Response>");
    }
    await env.DB.prepare(
      `UPDATE vobiz_pstn_calls SET status = 'connected', vobiz_call_uuid = ?2, updated_at = ?3
       WHERE id = ?1 AND ended_at IS NULL`,
    ).bind(row.id, providerUUID, Date.now()).run();
    row.vobiz_call_uuid = providerUUID;
    row.status = "connected";
    const stream = bridgeURL(env);
    stream.searchParams.set("token", await bridgeToken(env.VOBIZ_BRIDGE_SECRET, row));
    return xmlResponse(streamXML(stream.toString()));
  }
  if (kind === "ring") {
    await env.DB.prepare(
      `UPDATE vobiz_pstn_calls SET status = 'ringing', vobiz_call_uuid = COALESCE(vobiz_call_uuid, ?2), updated_at = ?3
       WHERE id = ?1 AND ended_at IS NULL AND status IN ('dispatching', 'queued', 'ringing', 'dispatch_unknown')`,
    ).bind(row.id, providerUUID, Date.now()).run();
    return callbackAcknowledged();
  }
  const callStatus = String(params.get("CallStatus") || "").trim().toLowerCase();
  const hangupCause = String(params.get("HangupCause") || "").trim().toUpperCase();
  const providerStatus = [callStatus, hangupCause].filter(Boolean).join(":").slice(0, 80) || "hangup";
  const terminalFailure = row.status === "failed" || row.status === "canceled";
  const answered = row.status === "connected" || row.status === "completed" || Boolean(row.bridge_claimed_at);
  const canceled = !answered && (["canceled", "cancelled"].includes(callStatus) ||
    ["1000", "ORIGINATOR_CANCEL", "CANCELED", "CANCELLED"].includes(hangupCause));
  const failed = ["busy", "failed", "timeout", "no-answer"].includes(callStatus) ||
    ["3000", "3010", "6010", "6020", "USER_BUSY", "NO_ANSWER", "CALL_REJECTED",
      "REJECTED", "MEDIA_TIMEOUT", "SERVICE_UNAVAILABLE"].includes(hangupCause);
  const status = terminalFailure ? row.status : failed ? "failed" : canceled ? "canceled" :
    answered || callStatus === "completed" ? "completed" : "failed";
  const now = Date.now();
  await env.DB.prepare(
    `UPDATE vobiz_pstn_calls
        SET status = ?2, provider_status = ?3, vobiz_call_uuid = COALESCE(vobiz_call_uuid, ?4),
            updated_at = ?5, ended_at = COALESCE(ended_at, ?5)
      WHERE id = ?1`,
  ).bind(row.id, status, providerStatus, providerUUID, now).run();
  return callbackAcknowledged();
}

export async function getBridgeCall(env, callID) {
  if (!isUUID(callID)) return json(404, { error: "call_not_found" });
  const row = await env.DB.prepare(
    "SELECT * FROM vobiz_pstn_calls WHERE id = ?1",
  ).bind(callID.toLowerCase()).first();
  if (!row || row.ended_at || Date.now() - row.created_at > MAX_CALL_MS + 60_000) {
    return json(404, { error: "call_not_available" });
  }
  return json(200, {
    id: row.id, direction: row.direction,
    caller_number: row.from_number, destination_number: row.to_number,
    instructions: row.instructions, opening_speech: row.opening_speech,
    vobiz_call_id: row.vobiz_call_uuid,
  });
}

export async function claimBridgeCall(env, callID) {
  if (!isUUID(callID)) return json(404, { error: "call_not_found" });
  const claimed = await env.DB.prepare(
    `UPDATE vobiz_pstn_calls SET bridge_claimed_at = ?2, updated_at = ?2
      WHERE id = ?1 AND bridge_claimed_at IS NULL AND ended_at IS NULL
        AND status = 'connected' AND vobiz_call_uuid IS NOT NULL`,
  ).bind(callID.toLowerCase(), Date.now()).run();
  return claimed.meta.changes
    ? json(200, { ok: true })
    : json(409, { error: "call_already_claimed_or_unavailable" });
}

function cleanSummary(value) {
  const cleaned = String(value || "").replace(/(?<!\d)\d{4,8}(?!\d)/g, "[code omitted]").trim();
  return cleaned.slice(0, 1_000) || null;
}

export async function bridgeCallEvent(request, env, callID) {
  if (!isUUID(callID)) return json(404, { error: "call_not_found" });
  const row = await env.DB.prepare(
    "SELECT * FROM vobiz_pstn_calls WHERE id = ?1",
  ).bind(callID.toLowerCase()).first();
  if (!row) return json(404, { error: "call_not_found" });
  let body;
  try {
    body = JSON.parse(await boundedText(request, CALLBACK_BYTES));
  } catch {
    return json(400, { error: "invalid_event_body" });
  }
  if (!["connected", "ended", "failed"].includes(body?.event)) {
    return json(400, { error: "invalid_event" });
  }
  let summary = cleanSummary(body.summary);
  if (!summary && Array.isArray(body.transcript)) {
    const turns = body.transcript.slice(0, 20);
    if (turns.every((turn) => ["user", "assistant"].includes(turn?.role) &&
      typeof turn?.text === "string" && turn.text.length <= 400)) {
      summary = cleanSummary(turns.filter((turn) => turn.role === "user")
        .map((turn) => turn.text).join(" "));
    }
  }
  if (body.event === "failed" && typeof body.detail === "string") {
    console.error(JSON.stringify({ message: "Vobiz bridge call failed", call_id: row.id }));
  }
  const status = body.event === "connected" ? "connected" : body.event === "ended" ? "completed" : "failed";
  const now = Date.now();
  await env.DB.prepare(
    `UPDATE vobiz_pstn_calls
        SET status = CASE WHEN ended_at IS NULL THEN ?2 ELSE status END,
            summary = COALESCE(?3, summary),
            updated_at = ?4,
            ended_at = CASE WHEN ?2 IN ('completed', 'failed') THEN COALESCE(ended_at, ?4) ELSE ended_at END
      WHERE id = ?1`,
  ).bind(row.id, status, summary, now).run();
  return json(200, { ok: true });
}

async function allowOutbound(env) {
  const now = Date.now();
  const minuteWindow = Math.floor(now / 60_000) * 60_000;
  const minute = await env.DB.prepare(
    `INSERT INTO request_rates (name, window_start, count) VALUES ('outbound_minute', ?1, 1)
     ON CONFLICT(name) DO UPDATE SET
       count = CASE WHEN request_rates.window_start = excluded.window_start
         THEN request_rates.count + 1 ELSE 1 END,
       window_start = excluded.window_start
     RETURNING count`,
  ).bind(minuteWindow).first();
  if (minute.count > 3) return false;
  const dispatch = await env.DB.prepare(
    `INSERT INTO request_rates (name, window_start, count)
       VALUES ('outbound_last_dispatch', ?1, 1)
     ON CONFLICT(name) DO UPDATE SET window_start = excluded.window_start
       WHERE request_rates.window_start <= excluded.window_start - 1000
     RETURNING window_start`,
  ).bind(Date.now()).first();
  return Boolean(dispatch);
}

/** @type {ExportedHandler<Env>} */
const worker = {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (request.method === "GET" && url.pathname === "/health") {
        await env.DB.prepare("SELECT id FROM vobiz_pstn_calls LIMIT 1").first();
        return json(200, { ok: true, service: "caller-vobiz-outbound", storage_ready: true });
      }

      const callback = url.pathname.match(/^\/v1\/vobiz\/(answer|ring|hangup)\/([0-9a-f-]+)\/([A-Za-z0-9_-]{43})$/i);
      if (request.method === "POST" && callback) {
        return await handleVobizCallback(request, env, callback[1], callback[2], callback[3]);
      }

      if (url.pathname === "/v1/pstn-calls" && request.method === "POST") {
        if (!(await validBearer(request, env.HERMES_PSTN_TOKEN))) return json(401, { error: "invalid_agent_credential" });
        return await createPstnCall(request, env);
      }
      const call = url.pathname.match(/^\/v1\/pstn-calls\/([0-9a-f-]+)$/i);
      if (request.method === "GET" && call) {
        if (!(await validBearer(request, env.HERMES_PSTN_TOKEN))) return json(401, { error: "invalid_agent_credential" });
        return await getPstnCall(env, call[1]);
      }

      const bridge = url.pathname.match(/^\/v1\/vobiz\/bridge\/calls\/([0-9a-f-]+)(?:\/(events|claim))?$/i);
      if (bridge && ((request.method === "GET" && !bridge[2]) ||
          (request.method === "POST" && ["events", "claim"].includes(bridge[2])))) {
        if (!(await validBearer(request, env.VOBIZ_BRIDGE_RELAY_TOKEN))) {
          return json(401, { error: "invalid_bridge_credential" });
        }
        if (request.method === "GET") return await getBridgeCall(env, bridge[1]);
        if (bridge[2] === "claim") return await claimBridgeCall(env, bridge[1]);
        return await bridgeCallEvent(request, env, bridge[1]);
      }
      return json(404, { error: "not_found" });
    } catch (error) {
      console.error(JSON.stringify({ message: "Vobiz outbound Worker request failed",
        method: request.method, error_type: error?.name || "Error" }));
      return json(500, { error: "internal_error" });
    }
  },
};

export default worker;
