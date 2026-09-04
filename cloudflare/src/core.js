export const SUPPORTED_AUDIO_TYPES = new Set([
  "audio/aac",
  "audio/aiff",
  "audio/mpeg",
  "audio/mp4",
  "audio/wav",
  "audio/x-aiff",
  "audio/x-caf",
  "audio/x-m4a",
  "audio/x-wav",
]);

const TOKEN_BYTES = 32;
const PAIRING_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function normalizeAudioContentType(value) {
  return String(value ?? "").split(";", 1)[0].trim().toLowerCase();
}

export function validIdempotencyKey(value) {
  return typeof value === "string" && value.length >= 8 && value.length <= 200;
}

export function validateDevice(body) {
  if (!body || typeof body !== "object") return "body_required";
  if (!/^[0-9a-f]{32,}$/i.test(body.token ?? "")) return "invalid_device_token";
  if (body.alert_token != null && !/^[0-9a-f]{32,}$/i.test(body.alert_token)) {
    return "invalid_alert_device_token";
  }
  if (body.device_identity != null && !/^[0-9a-f]{64}$/i.test(body.device_identity)) {
    return "invalid_device_identity";
  }
  if (body.platform !== "ios") return "unsupported_platform";
  if (!["sandbox", "production"].includes(body.environment)) return "invalid_environment";
  if (
    body.device_name &&
    (typeof body.device_name !== "string" || body.device_name.length > 120)
  ) {
    return "invalid_device_name";
  }
  return null;
}

export function validateCall(body, now = Date.now()) {
  if (!body || typeof body !== "object") return { error: "body_required" };
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message || message.length > 500) {
    return { error: "message_must_be_1_to_500_characters" };
  }
  const callerName =
    typeof body.caller_name === "string" ? body.caller_name.trim() : "Hermes";
  if (!callerName || callerName.length > 80) return { error: "invalid_caller_name" };
  if (body.audio_id != null) {
    return { error: "audio_delivery_is_not_supported" };
  }
  const audioID = null;
  const requestedAt = body.scheduled_at ?? new Date(now).toISOString();
  const timestamp = Date.parse(requestedAt);
  if (!Number.isFinite(timestamp)) return { error: "scheduled_at_must_be_iso_8601" };
  if (timestamp > now + 366 * 24 * 60 * 60 * 1000) {
    return { error: "scheduled_at_too_far_in_future" };
  }
  const mode = body.mode ?? "message";
  if (!["message", "live_voice"].includes(mode)) return { error: "invalid_call_mode" };
  let callContext = null;
  let originHermesSessionID = null;
  if (mode === "live_voice") {
    if (!body.call_context || typeof body.call_context !== "object") {
      return { error: "live_voice_call_context_required" };
    }
    const fields = ["reason", "relevant_context", "desired_outcome", "urgency", "opening_question"];
    callContext = {};
    for (const field of fields) {
      const value = body.call_context[field];
      if (typeof value !== "string" || !value.trim() || value.length > 2_000) {
        return { error: `invalid_call_context_${field}` };
      }
      callContext[field] = value.trim();
    }
    originHermesSessionID = String(body.origin_hermes_session_id ?? "").trim();
    if (
      !originHermesSessionID ||
      originHermesSessionID.length > 240 ||
      /[\r\n\0]/.test(originHermesSessionID)
    ) {
      return { error: "invalid_origin_hermes_session_id" };
    }
  }
  return {
    value: {
      message,
      callerName,
      audioID,
      scheduledAt: Math.max(timestamp, now),
      mode,
      callContext,
      originHermesSessionID,
    },
  };
}

export function isUUID(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value ?? "",
  );
}

export function safeFilename(value) {
  const raw = String(value ?? "speech").split(/[\\/]/).at(-1) || "speech";
  return raw.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 180) || "speech";
}

export function randomToken() {
  return base64url(crypto.getRandomValues(new Uint8Array(TOKEN_BYTES)));
}

export function randomPairingCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const characters = Array.from(bytes, (byte) => PAIRING_ALPHABET[byte % PAIRING_ALPHABET.length]);
  return `${characters.slice(0, 4).join("")}-${characters.slice(4).join("")}`;
}

export async function hashCredential(value) {
  const bytes = new TextEncoder().encode(String(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return bytesToHex(new Uint8Array(digest));
}

export function json(status, body, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      ...extraHeaders,
    },
  });
}

export function bearerToken(request) {
  return request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1] ?? null;
}

export function publicInstallation(row, installationSecret) {
  return {
    installation_id: row.id,
    ...(installationSecret ? { installation_secret: installationSecret } : {}),
    paired: Boolean(row.agent_token_hash),
    pairing_code: row.pairing_code,
    pairing_expires_at: row.pairing_expires_at
      ? new Date(row.pairing_expires_at).toISOString()
      : null,
  };
}

export function publicCall(row) {
  return {
    id: row.id,
    status: row.status,
    caller_name: row.caller_name,
    message: row.message,
    audio_id: row.audio_id,
    has_audio: Boolean(row.audio_id),
    scheduled_at: new Date(row.scheduled_at).toISOString(),
    delivered_at: row.delivered_at ? new Date(row.delivered_at).toISOString() : null,
    delivery_errors: parseErrors(row.delivery_errors),
    mode: row.mode ?? "message",
  };
}

export function publicAudio(row) {
  return {
    audio_id: row.id,
    content_type: row.content_type,
    filename: row.filename,
    size_bytes: row.size_bytes,
    created_at: new Date(row.created_at).toISOString(),
    expires_at: new Date(row.expires_at).toISOString(),
  };
}

export function audioObjectKey(installationID, audioID) {
  return `${installationID}/${audioID}`;
}

function parseErrors(value) {
  if (!value) return [];
  try {
    const result = JSON.parse(value);
    return Array.isArray(result) ? result : [];
  } catch {
    return [];
  }
}

function base64url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function bytesToHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
