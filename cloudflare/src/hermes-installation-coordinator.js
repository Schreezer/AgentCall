import { DurableObject } from "cloudflare:workers";

const WORKFLOW_RECONCILE_MS = 5_000;
const APPROVAL_TTL_MS = 10 * 60_000;

export class HermesInstallationCoordinator extends DurableObject {
  installationID() {
    const value = this.ctx.id.name;
    if (!value) throw new Error("coordinator_requires_named_installation");
    return value;
  }

  /** @param {any} input */
  async acceptOperation(input) {
    const installationID = this.installationID();
    if (input.installationID !== installationID) throw new Error("installation_scope_mismatch");
    const replayKey = `replay:${input.voiceSessionID}:${input.replayKey}`;
    /** @type {any} */
    const prior = await this.ctx.storage.get(replayKey);
    if (prior) {
      if (prior.requestHash !== input.requestHash) throw new Error("mcp_replay_conflict");
      return this.publicOperation(await this.ctx.storage.get(`operation:${prior.operationID}`));
    }

    await this.registerAllowedSession(input.originHermesSessionID, "origin");
    let hermesSessionID;
    let createSession = false;
    if (input.sessionMode === "independent") {
      if (!input.contextKey) throw new Error("independent_context_required");
      const contextStorageKey = `independent-context:${input.voiceSessionID}:${input.contextKey}`;
      /** @type {{ sessionID?: string } | undefined} */
      const existing = await this.ctx.storage.get(contextStorageKey);
      if (existing?.sessionID) {
        hermesSessionID = existing.sessionID;
      } else {
        hermesSessionID = `caller_${crypto.randomUUID().replaceAll("-", "")}`;
        createSession = true;
        await this.ctx.storage.put(contextStorageKey, {
          sessionID: hermesSessionID,
          contextKey: input.contextKey,
          createdAt: Date.now(),
        });
        await this.registerAllowedSession(hermesSessionID, "independent");
      }
    } else if (input.sessionMode === "continue") {
      hermesSessionID = input.sessionID;
      if (!(await this.ctx.storage.get(`allowed-session:${hermesSessionID}`))) {
        throw new Error("hermes_session_not_allowed");
      }
    } else {
      hermesSessionID = input.activeHermesSessionID || input.originHermesSessionID;
      if (!hermesSessionID || !(await this.ctx.storage.get(`allowed-session:${hermesSessionID}`))) {
        throw new Error("active_hermes_session_unavailable");
      }
    }

    const id = `voiceop_${crypto.randomUUID().replaceAll("-", "")}`;
    const now = Date.now();
    const operation = {
      id,
      installationID,
      callID: input.callID,
      voiceSessionID: input.voiceSessionID,
      replayKey: input.replayKey,
      requestHash: input.requestHash,
      request: input.request,
      sessionMode: input.sessionMode,
      contextKey: input.contextKey ?? null,
      hermesSessionID,
      createSession,
      enabledToolsets: input.enabledToolsets,
      workflowID: id,
      status: "workflow_pending",
      createdAt: now,
      updatedAt: now,
    };
    await this.ctx.storage.put({
      [`operation:${id}`]: operation,
      [replayKey]: { operationID: id, requestHash: input.requestHash },
    });
    await this.project(operation, false);
    await this.ensureWorkflow(operation);
    return this.publicOperation(await this.ctx.storage.get(`operation:${id}`));
  }

  async registerAllowedSession(sessionID, source) {
    if (!sessionID) return;
    const key = `allowed-session:${sessionID}`;
    if (!(await this.ctx.storage.get(key))) {
      await this.ctx.storage.put(key, { sessionID, source, createdAt: Date.now() });
    }
  }

  /** @param {any} operation */
  async ensureWorkflow(operation) {
    try {
      await this.env.HERMES_WORKFLOW.create({ id: operation.workflowID, params: { operationID: operation.id, installationID: operation.installationID } });
      await this.updateOperation(operation.id, { status: "queued", workflowAttachedAt: Date.now() });
    } catch (error) {
      if (!String(error?.message ?? error).toLowerCase().includes("already")) {
        await this.ctx.storage.setAlarm(Date.now() + WORKFLOW_RECONCILE_MS);
        return;
      }
      await this.updateOperation(operation.id, { status: "queued", workflowAttachedAt: Date.now() });
    }
  }

  async alarm() {
    /** @type {Map<string, any>} */
    const pending = await this.ctx.storage.list({ prefix: "operation:" });
    let stillPending = false;
    for (const operation of pending.values()) {
      if (operation.status !== "workflow_pending") continue;
      await this.ensureWorkflow(operation);
      /** @type {any} */
      const current = await this.ctx.storage.get(`operation:${operation.id}`);
      stillPending ||= current?.status === "workflow_pending";
    }
    if (stillPending) await this.ctx.storage.setAlarm(Date.now() + WORKFLOW_RECONCILE_MS);
  }

  async getOperation(operationID) {
    return this.ctx.storage.get(`operation:${operationID}`);
  }

  async operationStatus(operationID) {
    return this.publicOperation(await this.getOperation(operationID));
  }

  /** @param {string} operationID @param {Record<string, any>} fields */
  async updateOperation(operationID, fields) {
    const key = `operation:${operationID}`;
    /** @type {any} */
    const current = await this.ctx.storage.get(key);
    if (!current) throw new Error("hermes_operation_not_found");
    const updated = { ...current, ...fields, updatedAt: Date.now() };
    const statusChanged = current.status !== updated.status;
    await this.ctx.storage.put(key, updated);
    if (updated.hermesSessionID) await this.registerAllowedSession(updated.hermesSessionID, "resolved");
    await this.project(updated, statusChanged);
    return updated;
  }

  async recordApproval(operationID, approval) {
    const operation = await this.updateOperation(operationID, {
      status: "needs_external_approval",
      approval: {
        details: approval.details,
        choices: approval.choices,
        expiresAt: Date.now() + APPROVAL_TTL_MS,
      },
    });
    const notificationID = crypto.randomUUID();
    const now = Date.now();
    await this.env.DB.batch([
      this.env.DB.prepare(
        `INSERT OR REPLACE INTO hermes_approvals
          (operation_id, installation_id, notification_id, details_json, choices_json, status, created_at, expires_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 'pending', ?6, ?7)`,
      ).bind(operationID, operation.installationID, notificationID, JSON.stringify(approval.details), JSON.stringify(approval.choices), now, now + APPROVAL_TTL_MS),
      this.env.DB.prepare(
        `INSERT OR IGNORE INTO approval_outbox
          (notification_id, installation_id, operation_id, status, created_at)
         VALUES (?1, ?2, ?3, 'pending', ?4)`,
      ).bind(notificationID, operation.installationID, operationID, now),
    ]);
    await this.env.SCHEDULER.getByName(operation.installationID).approval();
    return this.publicOperation(operation);
  }

  async project(operation, emitStatusEvent = false) {
    const projection = this.env.DB.prepare(
      `INSERT INTO hermes_operations
        (id, installation_id, call_id, voice_session_id, lineage_id, workflow_id,
         replay_key, request_hash, status, hermes_session_id, hermes_run_id,
         result_json, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
       ON CONFLICT(id) DO UPDATE SET
         status = excluded.status,
         hermes_session_id = excluded.hermes_session_id,
         hermes_run_id = excluded.hermes_run_id,
         result_json = excluded.result_json,
         updated_at = excluded.updated_at`,
    )
      .bind(
        operation.id,
        operation.installationID,
        operation.callID,
        operation.voiceSessionID,
        operation.lineageID ?? operation.hermesSessionID ?? null,
        operation.workflowID,
        operation.replayKey,
        operation.requestHash,
        operation.status,
        operation.hermesSessionID ?? null,
        operation.hermesRunID ?? null,
        operation.result ? JSON.stringify(operation.result) : null,
        operation.createdAt,
        operation.updatedAt,
      );
    if (!emitStatusEvent) {
      await projection.run();
      return;
    }
    await this.env.DB.batch([
      projection,
      this.env.DB.prepare(
        `INSERT INTO hermes_operation_events
          (operation_id, installation_id, voice_session_id, status, result_json, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
      ).bind(
        operation.id,
        operation.installationID,
        operation.voiceSessionID,
        operation.status,
        operation.result ? JSON.stringify(operation.result) : null,
        operation.updatedAt,
      ),
    ]);
  }

  /** @param {any} operation */
  publicOperation(operation) {
    if (!operation) throw new Error("hermes_operation_not_found");
    return {
      status: operation.status === "workflow_pending" ? "queued" : operation.status,
      operation_id: operation.id,
      ...(operation.result?.answer ? { answer: operation.result.answer } : {}),
      ...(operation.result?.summary ? { summary: operation.result.summary } : {}),
      ...(operation.result?.error ? { error: operation.result.error } : {}),
      ...(operation.status === "needs_external_approval"
        ? { user_action: "Confirm or deny the pending action in the Caller app." }
        : {}),
    };
  }
}
