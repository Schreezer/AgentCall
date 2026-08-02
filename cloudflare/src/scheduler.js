import { DurableObject } from "cloudflare:workers";
import { APNsClient } from "./apns.js";
import { audioObjectKey } from "./core.js";

const DUE_BATCH_SIZE = 100;
const CLEANUP_BATCH_SIZE = 100;
const DELIVERY_RECOVERY_MS = 60_000;

export class RelayScheduler extends DurableObject {
  /**
   * @param {DurableObjectState} ctx
   * @param {Env} env
   */
  constructor(ctx, env) {
    super(ctx, env);
    this.apns = new APNsClient(this.env);
  }

  async drain() {
    const installationID = this.installationID();
    await this.deliverDue(installationID);
    await this.deliverApprovals(installationID);
    await this.scheduleNextAlarm(installationID);
  }

  async schedule() {
    await this.scheduleNextAlarm(this.installationID());
  }

  async maintenance() {
    const installationID = this.installationID();
    await this.deliverDue(installationID);
    await this.deliverApprovals(installationID);
    await this.cleanupExpiredAudio(installationID);
    await this.scheduleNextAlarm(installationID);
  }

  async cancel() {
    await this.ctx.storage.deleteAlarm();
  }

  async approval() {
    const installationID = this.installationID();
    await this.deliverApprovals(installationID);
    await this.scheduleNextAlarm(installationID);
  }

  async alarm() {
    await this.maintenance();
  }

  installationID() {
    const installationID = this.ctx.id.name;
    if (!installationID) throw new Error("scheduler_requires_named_instance");
    return installationID;
  }

  async deliverDue(installationID, now = Date.now()) {
    const due = await this.env.DB.prepare(
      `SELECT id, status
         FROM calls
        WHERE installation_id = ?1
          AND status IN ('scheduled', 'delivering')
          AND scheduled_at <= ?2
        ORDER BY scheduled_at
        LIMIT ?3`,
    )
      .bind(installationID, now, DUE_BATCH_SIZE)
      .all();

    for (const candidate of due.results) {
      const receiptKey = `apns-receipt:${candidate.id}`;
      /** @type {{ apnsID: string | null, deliveredAt: number } | undefined} */
      const receipt = await this.ctx.storage.get(receiptKey);
      if (receipt) {
        await this.recordDelivered(candidate.id, receipt.deliveredAt);
        await this.ctx.storage.delete(receiptKey);
        continue;
      }
      if (candidate.status === "delivering") {
        await this.markFailed(candidate.id, ["Delivery interrupted before APNs receipt"]);
        continue;
      }

      const claimed = await this.env.DB.prepare(
          `UPDATE calls
              SET status = 'delivering'
            WHERE id = ?1 AND status = 'scheduled'
            RETURNING *`,
        )
          .bind(candidate.id)
          .first();
      if (!claimed) continue;

      await this.ctx.storage.setAlarm(Date.now() + DELIVERY_RECOVERY_MS);
      const device = await this.env.DB.prepare(
        `SELECT device_token, environment
           FROM installations
          WHERE id = ?1`,
      )
        .bind(claimed.installation_id)
        .first();

      if (!device) {
        await this.markFailed(claimed.id, ["No registered devices"]);
        continue;
      }

      let result;
      try {
        result = await this.apns.sendVoIP(device, claimed);
      } catch (error) {
        await this.markFailed(claimed.id, [error?.message ?? String(error)]);
        continue;
      }
      const deliveryReceipt = {
        apnsID: result.apnsID,
        deliveredAt: Date.now(),
      };
      await this.ctx.storage.put(receiptKey, deliveryReceipt);
      await this.recordDelivered(claimed.id, deliveryReceipt.deliveredAt);
      await this.ctx.storage.delete(receiptKey);
    }

    if (due.results.length === DUE_BATCH_SIZE) {
      await this.deliverDue(installationID, now);
    }
  }

  async markFailed(callID, errors) {
    await this.env.DB.prepare(
      `UPDATE calls
          SET status = 'failed', delivered_at = NULL, delivery_errors = ?2
        WHERE id = ?1`,
    )
      .bind(callID, JSON.stringify(errors))
      .run();
  }

  async recordDelivered(callID, deliveredAt) {
    await this.env.DB.prepare(
      `UPDATE calls
          SET status = 'delivered', delivered_at = ?2, delivery_errors = '[]'
        WHERE id = ?1`,
    )
      .bind(callID, deliveredAt)
      .run();
  }

  async cleanupExpiredAudio(installationID, now = Date.now()) {
    const expired = await this.env.DB.prepare(
      `SELECT id, installation_id
         FROM audio
        WHERE installation_id = ?1 AND expires_at <= ?2
        ORDER BY expires_at
        LIMIT ?3`,
    )
      .bind(installationID, now, CLEANUP_BATCH_SIZE)
      .all();

    for (const audio of expired.results) {
      await this.env.AUDIO.delete(audioObjectKey(audio.installation_id, audio.id));
      await this.env.DB.prepare("DELETE FROM audio WHERE id = ?1").bind(audio.id).run();
    }
    if (expired.results.length === CLEANUP_BATCH_SIZE) {
      await this.cleanupExpiredAudio(installationID, now);
    }
  }

  async deliverApprovals(installationID) {
    const rows = await this.env.DB.prepare(
      `SELECT * FROM approval_outbox
        WHERE installation_id = ?1 AND status = 'pending'
        ORDER BY created_at LIMIT 20`,
    ).bind(installationID).all();
    if (!rows.results.length) return;
    const device = await this.env.DB.prepare(
      `SELECT alert_device_token, environment FROM installations WHERE id = ?1`,
    ).bind(installationID).first();
    for (const row of rows.results) {
      const claimed = await this.env.DB.prepare(
        `UPDATE approval_outbox
            SET status = 'delivering', attempts = attempts + 1
          WHERE notification_id = ?1 AND status = 'pending'
          RETURNING *`,
      ).bind(row.notification_id).first();
      if (!claimed) continue;
      const approval = await this.env.DB.prepare(
        `SELECT expires_at FROM hermes_approvals WHERE operation_id = ?1`,
      ).bind(claimed.operation_id).first();
      if (!device?.alert_device_token || !approval || Number(approval.expires_at) <= Date.now()) {
        await this.env.DB.prepare(
          `UPDATE approval_outbox SET status = 'failed', last_error = ?2 WHERE notification_id = ?1`,
        ).bind(claimed.notification_id, "No standard APNs token or approval expired").run();
        continue;
      }
      try {
        await this.apns.sendBackground(device, {
          callID: (await this.env.DB.prepare("SELECT call_id FROM hermes_operations WHERE id = ?1").bind(claimed.operation_id).first())?.call_id,
          operationID: claimed.operation_id,
          notificationID: claimed.notification_id,
          expiresAt: Number(approval.expires_at),
        });
        await this.env.DB.prepare(
          `UPDATE approval_outbox SET status = 'delivered', delivered_at = ?2, last_error = NULL
            WHERE notification_id = ?1`,
        ).bind(claimed.notification_id, Date.now()).run();
      } catch (error) {
        const terminal = Number(claimed.attempts) >= 3;
        await this.env.DB.prepare(
          `UPDATE approval_outbox SET status = ?2, last_error = ?3 WHERE notification_id = ?1`,
        ).bind(claimed.notification_id, terminal ? "failed" : "pending", error?.message ?? String(error)).run();
        if (!terminal) await this.ctx.storage.setAlarm(Date.now() + 30_000);
      }
    }
  }

  async scheduleNextAlarm(installationID) {
    const next = await this.env.DB.prepare(
      `SELECT MIN(due_at) AS due_at
         FROM (
           SELECT MIN(scheduled_at) AS due_at
             FROM calls
            WHERE installation_id = ?1 AND status = 'scheduled'
           UNION ALL
           SELECT MIN(expires_at) AS due_at
             FROM audio
            WHERE installation_id = ?1
           UNION ALL
           SELECT MIN(created_at + 30000) AS due_at
             FROM approval_outbox
            WHERE installation_id = ?1 AND status = 'pending'
         )
        WHERE due_at IS NOT NULL`,
    )
      .bind(installationID)
      .first();

    if (!next?.due_at) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.setAlarm(Math.max(Number(next.due_at), Date.now() + 100));
  }
}
