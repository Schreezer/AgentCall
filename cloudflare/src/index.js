import {
  SUPPORTED_AUDIO_TYPES,
  audioObjectKey,
  bearerToken,
  hashCredential,
  isUUID,
  json,
  normalizeAudioContentType,
  publicAudio,
  publicCall,
  publicInstallation,
  randomPairingCode,
  randomToken,
  safeFilename,
  validIdempotencyKey,
  validateCall,
  validateDevice,
} from "./core.js";
import { RelayScheduler } from "./scheduler.js";

export { RelayScheduler };

const JSON_BODY_LIMIT = 16_384;
const DEFAULT_AUDIO_MAX_BYTES = 5_000_000;
const DEFAULT_AUDIO_TTL_SECONDS = 3_600;
const DEFAULT_PAIRING_TTL_SECONDS = 900;

/** @type {ExportedHandler<Env>} */
const worker = {
  async fetch(request, env) {
    try {
      return await route(request, env);
    } catch (error) {
      console.error(
        JSON.stringify({
          message: "Relay request failed",
          method: request.method,
          path: new URL(request.url).pathname,
          error: error?.message ?? String(error),
        }),
      );
      const status = errorStatus(error);
      return json(status, { error: status === 500 ? "internal_error" : error.message });
    }
  },
  async scheduled(_controller, env, context) {
    context.waitUntil(runMaintenance(env));
  },
};

export default worker;

async function route(request, env) {
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/health") {
    await env.DB.prepare("SELECT 1 AS ready").first();
    return json(200, {
      ok: true,
      service: "caller-push-relay",
      storageReady: true,
      apnsReady: Boolean(
        env.APNS_TEAM_ID &&
          env.APNS_KEY_ID &&
          env.APNS_PRIVATE_KEY &&
          env.APNS_BUNDLE_ID,
      ),
    });
  }

  if (request.method === "POST" && url.pathname === "/v1/installations") {
    if (!(await allowRate(env, `install:${clientIP(request)}`, 20))) return rateLimited();
    const body = await readJSON(request);
    const validationError = validateDevice(body);
    if (validationError) return json(400, { error: validationError });
    return createInstallation(env, body);
  }

  const deviceMatch = url.pathname.match(/^\/v1\/installations\/([0-9a-f-]+)\/device$/i);
  if (request.method === "PUT" && deviceMatch) {
    const installation = await authorizeInstallation(env, deviceMatch[1], bearerToken(request));
    if (!installation) return json(401, { error: "invalid_installation_credential" });
    const body = await readJSON(request);
    const validationError = validateDevice(body);
    if (validationError) return json(400, { error: validationError });
    const now = Date.now();
    await env.DB.prepare(
      `UPDATE installations
          SET device_token = ?2, environment = ?3, device_name = ?4, updated_at = ?5
        WHERE id = ?1`,
    )
      .bind(installation.id, body.token, body.environment, body.device_name ?? null, now)
      .run();
    return json(200, publicInstallation({ ...installation, ...body, updated_at: now }));
  }

  const audioDownloadMatch = url.pathname.match(
    /^\/v1\/installations\/([0-9a-f-]+)\/audio\/([0-9a-f-]+)$/i,
  );
  if (request.method === "GET" && audioDownloadMatch) {
    const installation = await authorizeInstallation(
      env,
      audioDownloadMatch[1],
      bearerToken(request),
    );
    if (!installation) return json(401, { error: "invalid_installation_credential" });
    return downloadAudio(env, installation.id, audioDownloadMatch[2]);
  }

  const installationMatch = url.pathname.match(/^\/v1\/installations\/([0-9a-f-]+)$/i);
  if (request.method === "GET" && installationMatch) {
    const installation = await authorizeInstallation(
      env,
      installationMatch[1],
      bearerToken(request),
    );
    return installation
      ? json(200, publicInstallation(installation))
      : json(401, { error: "invalid_installation_credential" });
  }
  if (request.method === "DELETE" && installationMatch) {
    const installation = await authorizeInstallation(
      env,
      installationMatch[1],
      bearerToken(request),
    );
    if (!installation) return json(401, { error: "invalid_installation_credential" });
    await deleteInstallation(env, installation.id);
    await notifyScheduler(env, installation.id, "cancel");
    return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  }

  const pairingCodeMatch = url.pathname.match(
    /^\/v1\/installations\/([0-9a-f-]+)\/pairing-code$/i,
  );
  if (request.method === "POST" && pairingCodeMatch) {
    if (!(await allowRate(env, `pair:${clientIP(request)}`, 20))) return rateLimited();
    const installation = await authorizeInstallation(
      env,
      pairingCodeMatch[1],
      bearerToken(request),
    );
    if (!installation) return json(401, { error: "invalid_installation_credential" });
    const pairing = await assignPairingCode(env, installation.id);
    return json(200, publicInstallation({ ...installation, ...pairing }));
  }

  if (request.method === "POST" && url.pathname === "/v1/pairings/claim") {
    if (!(await allowRate(env, `claim:${clientIP(request)}`, 20))) return rateLimited();
    const body = await readJSON(request);
    const result = await claimPairingCode(env, body.pairing_code);
    return result
      ? json(200, {
          installation_id: result.installationID,
          agent_token: result.agentToken,
          relay_url: publicBaseURL(request, env),
        })
      : json(404, { error: "invalid_or_expired_pairing_code" });
  }

  const installation = await authorizeAgent(env, bearerToken(request));
  if (!installation) return json(401, { error: "invalid_agent_credential" });

  if (request.method === "POST" && url.pathname === "/v1/audio") {
    if (!(await allowRate(env, `audio:${installation.id}`, 10))) return rateLimited();
    return uploadAudio(request, env, installation);
  }

  if (request.method === "POST" && url.pathname === "/v1/calls") {
    if (!(await allowRate(env, `call:${installation.id}`, 10))) return rateLimited();
    return createCall(request, env, installation);
  }

  const callMatch = url.pathname.match(/^\/v1\/calls\/([0-9a-f-]+)$/i);
  if (request.method === "GET" && callMatch) {
    const call = await env.DB.prepare(
      "SELECT * FROM calls WHERE id = ?1 AND installation_id = ?2",
    )
      .bind(callMatch[1], installation.id)
      .first();
    return call ? json(200, publicCall(call)) : json(404, { error: "call_not_found" });
  }

  return json(404, { error: "not_found" });
}

async function createInstallation(env, device) {
  const id = crypto.randomUUID();
  const secret = randomToken();
  const now = Date.now();
  const row = {
    id,
    installation_secret_hash: await hashCredential(secret),
    agent_token_hash: null,
    pairing_code: null,
    pairing_expires_at: null,
  };
  await env.DB.prepare(
    `INSERT INTO installations (
       id, installation_secret_hash, device_token, environment, device_name, created_at, updated_at
     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)`,
  )
    .bind(
      id,
      row.installation_secret_hash,
      device.token,
      device.environment,
      device.device_name ?? null,
      now,
    )
    .run();
  const pairing = await assignPairingCode(env, id);
  return json(201, publicInstallation({ ...row, ...pairing }, secret));
}

async function assignPairingCode(env, installationID) {
  const expiresAt =
    Date.now() + integerSetting(env.PAIRING_TTL_SECONDS, DEFAULT_PAIRING_TTL_SECONDS) * 1000;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const pairingCode = randomPairingCode();
    try {
      await env.DB.prepare(
        `UPDATE installations
            SET pairing_code = ?2, pairing_expires_at = ?3, updated_at = ?4
          WHERE id = ?1`,
      )
        .bind(installationID, pairingCode, expiresAt, Date.now())
        .run();
      return { pairing_code: pairingCode, pairing_expires_at: expiresAt };
    } catch (error) {
      if (!String(error?.message).includes("UNIQUE")) throw error;
    }
  }
  throw new Error("could_not_allocate_pairing_code");
}

async function claimPairingCode(env, value) {
  const code = String(value ?? "").trim().toUpperCase();
  if (!/^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(code)) return null;
  const agentToken = randomToken();
  const tokenHash = await hashCredential(agentToken);
  const row = await env.DB.prepare(
    `UPDATE installations
        SET agent_token_hash = ?2,
            pairing_code = NULL,
            pairing_expires_at = NULL,
            paired_at = ?3,
            updated_at = ?3
      WHERE pairing_code = ?1 AND pairing_expires_at > ?3
      RETURNING id`,
  )
    .bind(code, tokenHash, Date.now())
    .first();
  return row ? { installationID: row.id, agentToken } : null;
}

async function uploadAudio(request, env, installation) {
  const idempotencyKey = request.headers.get("idempotency-key");
  if (!validIdempotencyKey(idempotencyKey)) {
    return json(400, { error: "valid_idempotency_key_required" });
  }
  const contentType = normalizeAudioContentType(request.headers.get("content-type"));
  if (!SUPPORTED_AUDIO_TYPES.has(contentType)) {
    return json(415, { error: "unsupported_audio_type" });
  }
  const maxBytes = integerSetting(env.AUDIO_MAX_BYTES, DEFAULT_AUDIO_MAX_BYTES);
  const statedLength = Number.parseInt(request.headers.get("content-length") ?? "0", 10);
  if (Number.isFinite(statedLength) && statedLength > maxBytes) {
    return json(413, { error: "audio_file_too_large" });
  }

  const existing = await findCurrentAudio(env, installation.id, idempotencyKey);
  if (existing) return json(200, publicAudio(existing));

  const data = await readBoundedBytes(
    request,
    maxBytes,
    "audio_file_too_large",
  );
  if (data.byteLength === 0) return json(400, { error: "audio_file_required" });
  if (data.byteLength > maxBytes) return json(413, { error: "audio_file_too_large" });

  const now = Date.now();
  const row = {
    id: crypto.randomUUID(),
    installation_id: installation.id,
    content_type: contentType,
    filename: safeFilename(request.headers.get("x-audio-filename")),
    size_bytes: data.byteLength,
    idempotency_key: idempotencyKey,
    created_at: now,
    expires_at:
      now + integerSetting(env.AUDIO_TTL_SECONDS, DEFAULT_AUDIO_TTL_SECONDS) * 1000,
  };
  const objectKey = audioObjectKey(row.installation_id, row.id);
  await env.AUDIO.put(objectKey, data, {
    httpMetadata: { contentType },
    customMetadata: { expiresAt: String(row.expires_at) },
  });

  try {
    await env.DB.prepare(
      `INSERT INTO audio (
         id, installation_id, content_type, filename, size_bytes,
         idempotency_key, created_at, expires_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    )
      .bind(
        row.id,
        row.installation_id,
        row.content_type,
        row.filename,
        row.size_bytes,
        row.idempotency_key,
        row.created_at,
        row.expires_at,
      )
      .run();
  } catch (error) {
    await env.AUDIO.delete(objectKey);
    const raced = await findCurrentAudio(env, installation.id, idempotencyKey);
    if (raced) return json(200, publicAudio(raced));
    throw error;
  }
  await notifyScheduler(env, installation.id, "schedule");
  return json(201, publicAudio(row));
}

async function findCurrentAudio(env, installationID, idempotencyKey) {
  const row = await env.DB.prepare(
    `SELECT *
       FROM audio
      WHERE installation_id = ?1 AND idempotency_key = ?2`,
  )
    .bind(installationID, idempotencyKey)
    .first();
  if (!row) return null;
  if (row.expires_at > Date.now()) return row;
  await env.AUDIO.delete(audioObjectKey(installationID, row.id));
  await env.DB.prepare("DELETE FROM audio WHERE id = ?1").bind(row.id).run();
  return null;
}

async function downloadAudio(env, installationID, audioID) {
  if (!isUUID(audioID)) return json(404, { error: "audio_not_found_or_expired" });
  const row = await env.DB.prepare(
    "SELECT * FROM audio WHERE id = ?1 AND installation_id = ?2",
  )
    .bind(audioID, installationID)
    .first();
  if (!row || row.expires_at <= Date.now()) {
    if (row) {
      await env.AUDIO.delete(audioObjectKey(installationID, audioID));
      await env.DB.prepare("DELETE FROM audio WHERE id = ?1").bind(audioID).run();
    }
    return json(404, { error: "audio_not_found_or_expired" });
  }
  const object = await env.AUDIO.get(audioObjectKey(installationID, audioID));
  if (!object) return json(404, { error: "audio_not_found_or_expired" });
  return new Response(object.body, {
    headers: {
      "cache-control": "no-store",
      "content-length": String(row.size_bytes),
      "content-type": row.content_type,
      "x-content-type-options": "nosniff",
    },
  });
}

async function createCall(request, env, installation) {
  const idempotencyKey = request.headers.get("idempotency-key");
  if (!validIdempotencyKey(idempotencyKey)) {
    return json(400, { error: "valid_idempotency_key_required" });
  }
  const parsed = validateCall(await readJSON(request));
  if (parsed.error) return json(400, { error: parsed.error });
  const input = parsed.value;
  if (input.audioID) {
    const audio = await env.DB.prepare(
      "SELECT * FROM audio WHERE id = ?1 AND installation_id = ?2 AND expires_at > ?3",
    )
      .bind(input.audioID, installation.id, Date.now())
      .first();
    if (!audio) return json(400, { error: "invalid_or_expired_audio_id" });
    if (input.scheduledAt >= audio.expires_at) {
      return json(400, { error: "audio_will_expire_before_scheduled_call" });
    }
  }

  const id = crypto.randomUUID();
  const now = Date.now();
  const inserted = await env.DB.prepare(
    `INSERT OR IGNORE INTO calls (
       id, installation_id, caller_name, message, audio_id, scheduled_at,
       status, idempotency_key, created_at, delivery_errors
     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'scheduled', ?7, ?8, '[]')`,
  )
    .bind(
      id,
      installation.id,
      input.callerName,
      input.message,
      input.audioID,
      input.scheduledAt,
      idempotencyKey,
      now,
    )
    .run();
  const created = inserted.meta.changes > 0;
  let call = await env.DB.prepare(
    "SELECT * FROM calls WHERE installation_id = ?1 AND idempotency_key = ?2",
  )
    .bind(installation.id, idempotencyKey)
    .first();

  await notifyScheduler(
    env,
    installation.id,
    input.scheduledAt <= Date.now() ? "drain" : "schedule",
  );
  call = (await env.DB.prepare("SELECT * FROM calls WHERE id = ?1").bind(call.id).first()) ?? call;
  return json(created ? 202 : 200, publicCall(call));
}

async function deleteInstallation(env, installationID) {
  const audio = await env.DB.prepare("SELECT id FROM audio WHERE installation_id = ?1")
    .bind(installationID)
    .all();
  await Promise.all(
    audio.results.map((item) => env.AUDIO.delete(audioObjectKey(installationID, item.id))),
  );
  await env.DB.batch([
    env.DB.prepare("DELETE FROM calls WHERE installation_id = ?1").bind(installationID),
    env.DB.prepare("DELETE FROM audio WHERE installation_id = ?1").bind(installationID),
    env.DB.prepare("DELETE FROM installations WHERE id = ?1").bind(installationID),
  ]);
}

async function authorizeInstallation(env, installationID, secret) {
  if (!isUUID(installationID) || !secret) return null;
  const hash = await hashCredential(secret);
  return env.DB.prepare(
    "SELECT * FROM installations WHERE id = ?1 AND installation_secret_hash = ?2",
  )
    .bind(installationID, hash)
    .first();
}

async function authorizeAgent(env, token) {
  if (!token) return null;
  const hash = await hashCredential(token);
  return env.DB.prepare("SELECT * FROM installations WHERE agent_token_hash = ?1")
    .bind(hash)
    .first();
}

async function allowRate(env, key, limit, windowMs = 60_000) {
  const windowStart = Math.floor(Date.now() / windowMs) * windowMs;
  const row = await env.DB.prepare(
    `INSERT INTO rate_limits (key, window_start, count)
     VALUES (?1, ?2, 1)
     ON CONFLICT(key) DO UPDATE SET
       count = CASE
         WHEN rate_limits.window_start = excluded.window_start THEN rate_limits.count + 1
         ELSE 1
       END,
       window_start = excluded.window_start
     RETURNING count`,
  )
    .bind(key, windowStart)
    .first();
  return row.count <= limit;
}

async function notifyScheduler(env, installationID, operation) {
  const scheduler = env.SCHEDULER.getByName(installationID);
  if (operation === "drain") return scheduler.drain();
  if (operation === "schedule") return scheduler.schedule();
  if (operation === "maintenance") return scheduler.maintenance();
  if (operation === "cancel") return scheduler.cancel();
  throw new Error("invalid_scheduler_operation");
}

async function runMaintenance(env) {
  await env.DB.prepare("DELETE FROM rate_limits WHERE window_start < ?1")
    .bind(Date.now() - 5 * 60_000)
    .run();
  const candidates = await env.DB.prepare(
    `SELECT DISTINCT installation_id
       FROM (
         SELECT installation_id
           FROM calls
          WHERE status = 'scheduled' AND scheduled_at <= ?1
         UNION
         SELECT installation_id
           FROM audio
          WHERE expires_at <= ?1
       )
      LIMIT 500`,
  )
    .bind(Date.now())
    .all();
  await Promise.all(
    candidates.results.map((row) =>
      notifyScheduler(env, row.installation_id, "maintenance"),
    ),
  );
}

async function readJSON(request) {
  const contentLength = Number.parseInt(request.headers.get("content-length") ?? "0", 10);
  if (Number.isFinite(contentLength) && contentLength > JSON_BODY_LIMIT) {
    throw codedError("body_too_large", 413);
  }
  const bytes = await readBoundedBytes(request, JSON_BODY_LIMIT, "body_too_large");
  const text = new TextDecoder().decode(bytes);
  try {
    return JSON.parse(text || "{}");
  } catch {
    throw codedError("invalid_json", 400);
  }
}

async function readBoundedBytes(request, maxBytes, tooLargeError) {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw codedError(tooLargeError, 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function integerSetting(value, fallback) {
  const parsed = Number.parseInt(value ?? String(fallback), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function publicBaseURL(request, env) {
  return env.PUBLIC_BASE_URL || new URL(request.url).origin;
}

function clientIP(request) {
  return request.headers.get("cf-connecting-ip") || "unknown";
}

function rateLimited() {
  return json(429, { error: "rate_limited" }, { "retry-after": "60" });
}

function codedError(message, status) {
  return Object.assign(new Error(message), { status });
}

function errorStatus(error) {
  if (error?.status) return error.status;
  const message = String(error?.message ?? "");
  if (message.includes("audio_file_too_large") || message.includes("body_too_large")) return 413;
  return 500;
}
