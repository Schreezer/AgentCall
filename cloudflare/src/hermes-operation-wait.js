const TERMINAL_HERMES_STATUSES = new Set([
  "answered",
  "failed",
  "cancelled",
  "outcome_unknown",
  "needs_external_approval",
]);

const DEFAULT_WAIT_MS = 45_000;
const MAX_WAIT_MS = 90_000;

export function configuredHermesWaitMs(value) {
  const parsed = Number(value ?? DEFAULT_WAIT_MS);
  if (!Number.isFinite(parsed)) return DEFAULT_WAIT_MS;
  return Math.max(0, Math.min(MAX_WAIT_MS, Math.trunc(parsed)));
}

export function isTerminalHermesStatus(status) {
  return TERMINAL_HERMES_STATUSES.has(status);
}

/**
 * Keep a Remote MCP tool call open while its durable Workflow runs. xAI injects
 * the returned MCP result into Grok automatically, so returning only after a
 * terminal state avoids making the voice model manually poll ordinary work.
 *
 * @param {{ operationStatus(operationID: string): Promise<any> }} coordinator
 * @param {any} initial
 * @param {number} waitMs
 * @param {{ sleep?: (delayMs: number) => Promise<void>, initialDelayMs?: number, maxDelayMs?: number }} options
 */
export async function awaitHermesOperation(
  coordinator,
  initial,
  waitMs,
  { sleep = defaultSleep, initialDelayMs = 250, maxDelayMs = 1_500 } = {},
) {
  let operation = initial;
  const boundedWaitMs = configuredHermesWaitMs(waitMs);
  const deadline = Date.now() + boundedWaitMs;
  let delayMs = Math.max(0, initialDelayMs);

  while (!isTerminalHermesStatus(operation.status) && Date.now() < deadline) {
    const remainingMs = deadline - Date.now();
    await sleep(Math.min(delayMs, remainingMs));
    operation = await coordinator.operationStatus(initial.operation_id);
    delayMs = Math.min(maxDelayMs, Math.max(delayMs + 250, 250));
  }

  if (isTerminalHermesStatus(operation.status)) {
    return { ...operation, completion_delivery: "automatic" };
  }
  return {
    ...operation,
    completion_delivery: "manual_fallback",
    summary:
      operation.summary ||
      "Hermes is still working beyond the automatic voice wait window. Check this task again with check_hermes_task.",
  };
}

function defaultSleep(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}
