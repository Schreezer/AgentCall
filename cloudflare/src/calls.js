import { hashCredential, validateCall } from "./core.js";

/**
 * Create (or idempotently re-read) a call row for an installation and wake its scheduler.
 * Shared by the agent-facing `POST /v1/calls` route and the hosted agent's tools.
 *
 * @param {Env} env
 * @param {{ id: string }} installation
 * @param {Record<string, unknown>} body Raw call body in the public API shape.
 * @param {string} idempotencyKey
 * @returns {Promise<{ ok: true, created: boolean, call: any } | { ok: false, status: number, error: string }>}
 */
export async function createCallRecord(env, installation, body, idempotencyKey) {
  const parsed = validateCall(body);
  if (parsed.error) return { ok: false, status: 400, error: parsed.error };
  const input = parsed.value;
  if (input.audioID) {
    const audio = await env.DB.prepare(
      "SELECT * FROM audio WHERE id = ?1 AND installation_id = ?2 AND expires_at > ?3",
    )
      .bind(input.audioID, installation.id, Date.now())
      .first();
    if (!audio) return { ok: false, status: 400, error: "invalid_or_expired_audio_id" };
    if (input.scheduledAt >= Number(audio.expires_at)) {
      return { ok: false, status: 400, error: "audio_will_expire_before_scheduled_call" };
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
    return { ok: false, status: 409, error: "idempotency_key_reused_with_different_call" };
  }

  await notifyScheduler(env, installation.id, input.scheduledAt <= Date.now() ? "drain" : "schedule");
  call = (await env.DB.prepare("SELECT * FROM calls WHERE id = ?1").bind(call.id).first()) ?? call;
  return { ok: true, created, call };
}

/**
 * @param {Env} env
 * @param {string} installationID
 * @param {"drain" | "schedule" | "maintenance" | "cancel"} operation
 */
export async function notifyScheduler(env, installationID, operation) {
  const scheduler = env.SCHEDULER.getByName(installationID);
  if (operation === "drain") return scheduler.drain();
  if (operation === "schedule") return scheduler.schedule();
  if (operation === "maintenance") return scheduler.maintenance();
  if (operation === "cancel") return scheduler.cancel();
  throw new Error("invalid_scheduler_operation");
}
