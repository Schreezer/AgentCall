import { WorkflowEntrypoint } from "cloudflare:workers";
import { HermesClient } from "./hermes-client.js";

const MAX_POLLS = 45;

export class HermesOperationWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const { operationID, installationID } = event.payload;
    const coordinator = this.env.HERMES_COORDINATOR.getByName(installationID);
    try {
      return await this.runOperation(operationID, installationID, coordinator, step);
    } catch (error) {
      await coordinator.updateOperation(operationID, {
        status: "failed",
        result: { error: workflowErrorCode(error) },
      }).catch(() => {});
      throw error;
    }
  }

  async runOperation(operationID, installationID, coordinator, step) {
    const hermes = new HermesClient(this.env);
    let operation = await coordinator.getOperation(operationID);
    if (!operation) throw new Error("hermes_operation_not_found");

    if (operation.createSession) {
      await step.do("reserve Hermes session", { retries: { limit: 3, delay: "1 second", backoff: "exponential" }, timeout: "30 seconds" }, async () => {
        const response = await hermes.createSession(operation.hermesSessionID);
        if (response.status === 409) await hermes.resolveSession(operation.hermesSessionID);
      });
    } else {
      const resolved = await step.do("resolve Hermes session", { retries: { limit: 3, delay: "1 second", backoff: "exponential" }, timeout: "30 seconds" }, async () => {
        return hermes.resolveSession(operation.hermesSessionID);
      });
      const canonical = resolved.payload.session_id || operation.hermesSessionID;
      operation = await coordinator.updateOperation(operationID, { hermesSessionID: canonical });
    }

    const submitted = await step.do("create durable Hermes run", { retries: { limit: 3, delay: "1 second", backoff: "exponential" }, timeout: "30 seconds" }, async () => {
      return hermes.createRun(operation);
    });
    const runID = submitted.payload.run_id;
    if (!runID) throw new Error("hermes_run_id_missing");
    await coordinator.updateOperation(operationID, { status: "running", hermesRunID: runID });

    let approvalRecorded = false;
    for (let poll = 0; poll < MAX_POLLS; poll += 1) {
      const response = await step.do(`poll Hermes run ${poll}`, { retries: { limit: 3, delay: "1 second", backoff: "exponential" }, timeout: "30 seconds" }, async () => {
        return hermes.runStatus(runID);
      });
      const status = response.payload.status;
      if (status === "completed") {
        const resolved = await step.do("resolve completed Hermes session", { retries: { limit: 3, delay: "1 second", backoff: "exponential" }, timeout: "30 seconds" }, async () => {
          return hermes.resolveSession(operation.hermesSessionID);
        });
        await coordinator.updateOperation(operationID, {
          status: "answered",
          hermesSessionID: resolved.payload.session_id || operation.hermesSessionID,
          result: { answer: response.payload.output || "Hermes completed without a text response." },
        });
        return { status: "answered", operationID, runID };
      }
      if (status === "waiting_for_approval") {
        if (!approvalRecorded) {
          const pending = response.payload.pending_approval || {};
          await coordinator.recordApproval(operationID, {
            details: {
              message: pending.message || pending.reason || "Hermes needs confirmation before using a tool.",
              tool: pending.tool || pending.tool_name || null,
              command: pending.command || null,
            },
            choices: Array.isArray(pending.choices) ? pending.choices : ["once", "deny"],
          });
          approvalRecorded = true;
        }
      } else if (["failed", "cancelled", "needs_reconciliation"].includes(status)) {
        const mapped = status === "needs_reconciliation" ? "outcome_unknown" : status;
        await coordinator.updateOperation(operationID, {
          status: mapped,
          result: { error: response.payload.error || `Hermes run ${status}` },
        });
        return { status: mapped, operationID, runID };
      }
      await step.sleep(`wait before Hermes poll ${poll}`, hermesPollDelay(poll));
    }

    await coordinator.updateOperation(operationID, {
      status: "working",
      result: { summary: "Hermes is still working; check this operation again later." },
    });
    return { status: "working", operationID, runID };
  }
}

export function hermesPollDelay(poll) {
  if (poll < 10) return "5 seconds";
  if (poll < 20) return "15 seconds";
  return "1 minute";
}

function workflowErrorCode(error) {
  const message = String(error?.message ?? error).toLowerCase();
  if (message.includes("too many subrequests")) return "hermes_workflow_subrequest_limit";
  return "hermes_workflow_failed";
}
