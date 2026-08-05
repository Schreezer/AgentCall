#!/usr/bin/env node

const baseURL = (process.env.CALLER_RELAY_URL || "https://agentcall-relay.chiragmgg.workers.dev").replace(/\/$/, "");
const terminalStatuses = new Set(["answered", "failed", "cancelled", "outcome_unknown"]);
let installation;
let voiceSessionID;

try {
  installation = await jsonRequest("/v1/installations", {
    method: "POST",
    body: {
      token: "ab".repeat(32),
      alert_token: "cd".repeat(32),
      platform: "ios",
      environment: "sandbox",
      device_name: "Caller live MCP smoke",
    },
  });
  const pairing = await jsonRequest("/v1/pairings/claim", {
    method: "POST",
    body: { pairing_code: installation.pairing_code },
  });
  const call = await jsonRequest("/v1/calls", {
    method: "POST",
    token: pairing.agent_token,
    idempotencyKey: `live-mcp-smoke-${crypto.randomUUID()}`,
    body: {
      mode: "live_voice",
      caller_name: "Hermes MCP smoke",
      message: "Live MCP verification fallback",
      call_context: {
        reason: "Verify the private Hermes Remote MCP integration",
        relevant_context: "This is an automated disposable production smoke test",
        desired_outcome: "Hermes returns the exact verification phrase",
        urgency: "normal",
      },
      origin_hermes_session_id: `caller_smoke_origin_${crypto.randomUUID().replaceAll("-", "")}`,
    },
  });
  const bootstrap = await jsonRequest(
    `/v1/installations/${installation.installation_id}/calls/${call.id}/voice-bootstrap`,
    { method: "POST", token: installation.installation_secret, body: {} },
  );
  voiceSessionID = bootstrap.voice_session_id;
  const mcpAuthorization = bootstrap.session.tools[0]?.authorization;
  if (!mcpAuthorization?.startsWith("Bearer ")) throw new Error("bootstrap_missing_mcp_authorization");

  const initialized = await mcpRequest(mcpAuthorization, 1, "initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "caller-live-smoke", version: "1.0.0" },
  });
  if (initialized.result?.serverInfo?.name !== "caller-hermes") throw new Error("mcp_initialize_failed");
  const listed = await mcpRequest(mcpAuthorization, 2, "tools/list", {});
  const toolNames = listed.result?.tools?.map((tool) => tool.name) || [];
  if (toolNames.join(",") !== "ask_hermes,check_hermes_task") {
    throw new Error(`unexpected_mcp_tools:${toolNames.join(",")}`);
  }

  const accepted = await mcpRequest(mcpAuthorization, 3, "tools/call", {
    name: "ask_hermes",
    arguments: {
      request: "This is a Caller production integration smoke test. Reply with exactly CALLER_MCP_LIVE_OK and nothing else. Do not use tools.",
      context_scope: "independent",
      independent_context: "caller-production-smoke",
    },
  });
  let operation = toolPayload(accepted);
  if (!operation.operation_id) throw new Error(`ask_hermes_not_accepted:${JSON.stringify(operation)}`);

  const deadline = Date.now() + 180_000;
  let requestID = 10;
  while (!terminalStatuses.has(operation.status) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    const checked = await mcpRequest(mcpAuthorization, requestID++, "tools/call", {
      name: "check_hermes_task",
      arguments: { operation_id: operation.operation_id },
    });
    operation = toolPayload(checked);
  }
  if (operation.status !== "answered") {
    throw new Error(`hermes_operation_${operation.status || "timed_out"}:${operation.error || ""}`);
  }
  if (operation.completion_delivery !== "automatic") {
    throw new Error(`hermes_completion_not_automatic:${operation.completion_delivery || "missing"}`);
  }
  if (!String(operation.answer || "").includes("CALLER_MCP_LIVE_OK")) {
    throw new Error(`unexpected_hermes_answer:${operation.answer || "missing"}`);
  }
  console.log(JSON.stringify({
    ok: true,
    worker: "reachable",
    xai_ephemeral_token: "minted",
    mcp_tools: toolNames,
    hermes_status: operation.status,
    completion_delivery: operation.completion_delivery,
    hermes_answer: "CALLER_MCP_LIVE_OK",
    hermes_session_id: operation.hermes_session_id,
  }));
} finally {
  if (installation?.installation_id && installation?.installation_secret) {
    if (voiceSessionID) {
      await fetch(`${baseURL}/v1/installations/${installation.installation_id}/voice-sessions/${voiceSessionID}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${installation.installation_secret}` },
      }).catch(() => {});
    }
    await fetch(`${baseURL}/v1/installations/${installation.installation_id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${installation.installation_secret}` },
    }).catch(() => {});
  }
}

async function jsonRequest(path, { method = "GET", token, idempotencyKey, body } = {}) {
  const headers = new Headers();
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (idempotencyKey) headers.set("idempotency-key", idempotencyKey);
  if (body !== undefined) headers.set("content-type", "application/json");
  const response = await fetch(`${baseURL}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${method} ${path} failed HTTP ${response.status}: ${JSON.stringify(payload)}`);
  return payload;
}

async function mcpRequest(authorization, id, method, params) {
  const response = await fetch(`${baseURL}/mcp`, {
    method: "POST",
    headers: {
      authorization,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  const text = await response.text();
  const jsonText = response.headers.get("content-type")?.includes("text/event-stream")
    ? text.split("\n").find((line) => line.startsWith("data: "))?.slice(6)
    : text;
  const payload = JSON.parse(jsonText || "{}");
  if (!response.ok || payload.error) throw new Error(`MCP ${method} failed: ${JSON.stringify(payload.error || payload)}`);
  return payload;
}

function toolPayload(response) {
  const result = response.result || {};
  if (result.isError) throw new Error(`MCP tool error: ${result.content?.[0]?.text || "unknown"}`);
  if (result.structuredContent) return result.structuredContent;
  return JSON.parse(result.content?.find((item) => item.type === "text")?.text || "{}");
}
