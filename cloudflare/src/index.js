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
import { HermesInstallationCoordinator } from "./hermes-installation-coordinator.js";
import { HermesOperationWorkflow } from "./hermes-operation-workflow.js";
import { handleMcp } from "./mcp.js";
import { createVoiceBootstrap, revokeVoiceSession } from "./voice-bootstrap.js";
import { HermesClient } from "./hermes-client.js";

export { RelayScheduler, HermesInstallationCoordinator, HermesOperationWorkflow };

const JSON_BODY_LIMIT = 16_384;
const DEFAULT_AUDIO_MAX_BYTES = 5_000_000;
const DEFAULT_AUDIO_TTL_SECONDS = 3_600;
const DEFAULT_PAIRING_TTL_SECONDS = 900;

/** @type {ExportedHandler<Env>} */
const worker = {
  async fetch(request, env, context) {
    try {
      return await route(request, env, context);
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

async function route(request, env, context) {
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

  if (url.pathname === "/mcp") return handleMcp(request, env, context);

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
    const deviceIdentityHash = body.device_identity
      ? await hashCredential(body.device_identity)
      : null;
    await env.DB.prepare(
      `UPDATE installations
          SET device_token = ?2,
              alert_device_token = ?3,
              environment = ?4,
              device_name = ?5,
              updated_at = ?6,
              device_identity_hash = COALESCE(?7, device_identity_hash)
        WHERE id = ?1`,
    )
      .bind(
        installation.id,
        body.token,
        body.alert_token ?? installation.alert_device_token ?? null,
        body.environment,
        body.device_name ?? null,
        now,
        deviceIdentityHash,
      )
      .run();
    return json(200, publicInstallation({
      ...installation,
      ...body,
      device_identity_hash: deviceIdentityHash ?? installation.device_identity_hash,
      updated_at: now,
    }));
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

  const bootstrapMatch = url.pathname.match(
    /^\/v1\/installations\/([0-9a-f-]+)\/calls\/([0-9a-f-]+)\/voice-bootstrap$/i,
  );
  if (request.method === "POST" && bootstrapMatch) {
    const installation = await authorizeInstallation(env, bootstrapMatch[1], bearerToken(request));
    if (!installation) return json(401, { error: "invalid_installation_credential" });
    if (!(await allowRate(env, `voice-bootstrap:${installation.id}`, 10))) return rateLimited();
    return createVoiceBootstrap(request, env, installation, bootstrapMatch[2]);
  }

  const revokeMatch = url.pathname.match(
    /^\/v1\/installations\/([0-9a-f-]+)\/voice-sessions\/([0-9a-f-]+)$/i,
  );
  if (request.method === "DELETE" && revokeMatch) {
    const installation = await authorizeInstallation(env, revokeMatch[1], bearerToken(request));
    if (!installation) return json(401, { error: "invalid_installation_credential" });
    await revokeVoiceSession(env, installation.id, revokeMatch[2]);
    return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  }

  const approvalMatch = url.pathname.match(
    /^\/v1\/installations\/([0-9a-f-]+)\/hermes-operations\/(voiceop_[0-9a-f]{32})\/approval$/i,
  );
  if (approvalMatch && ["GET", "POST"].includes(request.method)) {
    const installation = await authorizeInstallation(env, approvalMatch[1], bearerToken(request));
    if (!installation) return json(401, { error: "invalid_installation_credential" });
    if (request.method === "GET") return getHermesApproval(env, installation.id, approvalMatch[2]);
    return answerHermesApproval(request, env, installation.id, approvalMatch[2]);
  }

  const inboxMatch = url.pathname.match(
    /^\/v1\/installations\/([0-9a-f-]+)\/hermes-approvals$/i,
  );
  if (request.method === "GET" && inboxMatch) {
    const installation = await authorizeInstallation(env, inboxMatch[1], bearerToken(request));
    if (!installation) return json(401, { error: "invalid_installation_credential" });
    return listHermesApprovals(env, installation.id);
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
  const secret = device.device_identity ?? randomToken();
  const deviceIdentityHash = device.device_identity
    ? await hashCredential(device.device_identity)
    : null;
  const now = Date.now();
  const row = {
    id,
    installation_secret_hash: await hashCredential(secret),
    device_identity_hash: deviceIdentityHash,
    agent_token_hash: null,
    pairing_code: null,
    pairing_expires_at: null,
  };
  if (deviceIdentityHash) {
    const recovered = await recoverInstallation(env, device, deviceIdentityHash, now);
    if (recovered) return json(200, publicInstallation(recovered, secret));
  }
  try {
    await env.DB.prepare(
      `INSERT INTO installations (
         id, installation_secret_hash, device_identity_hash, device_token,
         alert_device_token, environment, device_name, created_at, updated_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)`,
    )
      .bind(
        id,
        row.installation_secret_hash,
        deviceIdentityHash,
        device.token,
        device.alert_token ?? null,
        device.environment,
        device.device_name ?? null,
        now,
      )
      .run();
  } catch (error) {
    if (!deviceIdentityHash || !isUniqueConstraintError(error)) throw error;
    const recovered = await recoverInstallation(env, device, deviceIdentityHash, Date.now());
    if (!recovered) throw error;
    return json(200, publicInstallation(recovered, secret));
  }
  const pairing = await assignPairingCode(env, id);
  return json(201, publicInstallation({ ...row, ...pairing }, secret));
}

async function recoverInstallation(env, device, deviceIdentityHash, now) {
  return env.DB.prepare(
    `UPDATE installations
        SET installation_secret_hash = ?2,
            device_token = ?3,
            alert_device_token = COALESCE(?4, alert_device_token),
            environment = ?5,
            device_name = ?6,
            updated_at = ?7
      WHERE device_identity_hash = ?1
      RETURNING *`,
  )
    .bind(
      deviceIdentityHash,
      deviceIdentityHash,
      device.token,
      device.alert_token ?? null,
      device.environment,
      device.device_name ?? null,
      now,
    )
    .first();
}

function isUniqueConstraintError(error) {
  return String(error?.message ?? "").toUpperCase().includes("UNIQUE");
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
  const requestHash = await hashCredential(JSON.stringify(input));
  const inserted = await env.DB.prepare(
    `INSERT OR IGNORE INTO calls (
       id, installation_id, caller_name, message, audio_id, scheduled_at,
       status, idempotency_key, created_at, delivery_errors, mode,
       call_context_json, origin_hermes_session_id, request_hash
     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'scheduled', ?7, ?8, '[]', ?9, ?10, ?11, ?12)`,
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
      input.mode,
      input.callContext ? JSON.stringify(input.callContext) : null,
      input.originHermesSessionID,
      requestHash,
    )
    .run();
  const created = inserted.meta.changes > 0;
  let call = await env.DB.prepare(
    "SELECT * FROM calls WHERE installation_id = ?1 AND idempotency_key = ?2",
  )
    .bind(installation.id, idempotencyKey)
    .first();

  if (!created && call.request_hash && call.request_hash !== requestHash) {
    return json(409, { error: "idempotency_key_reused_with_different_call" });
  }

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

async function getHermesApproval(env, installationID, operationID) {
  const approval = await env.DB.prepare(
    `SELECT operation_id, notification_id, details_json, choices_json, status, created_at, expires_at
       FROM hermes_approvals
      WHERE operation_id = ?1 AND installation_id = ?2`,
  ).bind(operationID, installationID).first();
  if (!approval) return json(404, { error: "approval_not_found" });
  if (approval.status === "pending" && approval.expires_at <= Date.now()) {
    await env.DB.prepare("UPDATE hermes_approvals SET status = 'expired' WHERE operation_id = ?1")
      .bind(operationID).run();
    approval.status = "expired";
  }
  return json(200, publicApproval(approval));
}

async function listHermesApprovals(env, installationID) {
  await env.DB.prepare(
    `UPDATE hermes_approvals SET status = 'expired'
      WHERE installation_id = ?1 AND status = 'pending' AND expires_at <= ?2`,
  ).bind(installationID, Date.now()).run();
  const rows = await env.DB.prepare(
    `SELECT operation_id, notification_id, details_json, choices_json, status, created_at, expires_at
       FROM hermes_approvals
      WHERE installation_id = ?1 AND status = 'pending'
      ORDER BY created_at DESC LIMIT 50`,
  ).bind(installationID).all();
  return json(200, { approvals: rows.results.map(publicApproval) });
}

async function answerHermesApproval(request, env, installationID, operationID) {
  const approval = await env.DB.prepare(
    `SELECT a.*, o.hermes_run_id
       FROM hermes_approvals a
       JOIN hermes_operations o ON o.id = a.operation_id
      WHERE a.operation_id = ?1 AND a.installation_id = ?2`,
  ).bind(operationID, installationID).first();
  if (!approval) return json(404, { error: "approval_not_found" });
  if (approval.status !== "pending") return json(409, { error: `approval_${approval.status}` });
  if (approval.expires_at <= Date.now()) {
    await env.DB.prepare("UPDATE hermes_approvals SET status = 'expired' WHERE operation_id = ?1")
      .bind(operationID).run();
    return json(410, { error: "approval_expired" });
  }
  const body = await readJSON(request);
  const choices = parseJSON(approval.choices_json, []);
  if (typeof body.choice !== "string" || !choices.includes(body.choice)) {
    return json(400, { error: "invalid_approval_choice", choices });
  }
  if (!approval.hermes_run_id) return json(409, { error: "hermes_run_not_ready" });
  await new HermesClient(env).answerApproval(approval.hermes_run_id, body.choice);
  const status = body.choice === "deny" ? "denied" : "approved";
  await env.DB.prepare(
    `UPDATE hermes_approvals SET status = ?2, responded_at = ?3
      WHERE operation_id = ?1 AND status = 'pending'`,
  ).bind(operationID, status, Date.now()).run();
  await env.HERMES_COORDINATOR.getByName(installationID).updateOperation(operationID, {
    status: body.choice === "deny" ? "failed" : "running",
    approvalResolvedAt: Date.now(),
  });
  return json(200, { operation_id: operationID, status, choice: body.choice });
}

function publicApproval(row) {
  return {
    operation_id: row.operation_id,
    notification_id: row.notification_id,
    details: parseJSON(row.details_json, {}),
    choices: parseJSON(row.choices_json, []),
    status: row.status,
    created_at: new Date(row.created_at).toISOString(),
    expires_at: new Date(row.expires_at).toISOString(),
  };
}

function parseJSON(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
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
