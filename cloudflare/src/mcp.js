import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
import { bearerToken, hashCredential } from "./core.js";

export async function handleMcp(request, env, context) {
  const scope = await authorizeMcp(request, env);
  if (!scope) return mcpError(401, null, -32001, "Invalid or expired MCP credential");
  const parsed = await parsedBody(request);
  const requestID = parsed && (typeof parsed.id === "string" || typeof parsed.id === "number")
    ? String(parsed.id)
    : "notification";
  const handler = createMcpHandler(
    () => createHermesMcpServer(env, scope, requestID),
    { route: "/mcp", corsOptions: false, legacy: "stateless" },
  );
  return handler(request, env, context);
}

function createHermesMcpServer(env, scope, requestID) {
  const server = new McpServer({ name: "caller-hermes", version: "1.0.0" });
  server.registerTool(
    "ask_hermes",
    {
      title: "Ask Hermes",
      description:
        "Consult Hermes for memory, research, or reasoning. Use origin for this call's briefing or " +
        "originating work. Use independent with a stable independent_context for unrelated work, and " +
        "reuse that key for follow-ups. The request queues immediately; results arrive as " +
        "caller_hermes_event. Keep internal sessions private.",
      inputSchema: {
        request: z.string().trim().min(1).max(8_000).describe("A complete standalone request for Hermes."),
        context_scope: z.enum(["origin", "independent"]).describe(
          "origin when the request depends on the call's briefing or originating work; independent for an unrelated topic or task.",
        ),
        independent_context: z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{0,79}$/).optional().describe(
          "Required with independent. A stable topic key reused only for follow-ups to that same independent task, for example weather_trip or app_bug.",
        ),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async (args) => mcpToolResult(await executeHermesTool(env, scope, requestID, "ask_hermes", args)),
  );
  server.registerTool(
    "check_hermes_task",
    {
      title: "Check Hermes task",
      description:
        "Check an operation from this voice session only when the caller asks for status or Caller reports event delivery failed.",
      inputSchema: {
        operation_id: z.string().regex(/^voiceop_[0-9a-f]{32}$/),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async (args) => mcpToolResult(await executeHermesTool(env, scope, requestID, "check_hermes_task", args)),
  );
  return server;
}

export async function authorizeMcp(request, env) {
  const token = bearerToken(request);
  if (!token) return null;
  const hash = await hashCredential(token);
  return env.DB.prepare(
    `SELECT * FROM voice_sessions
      WHERE mcp_token_hash = ?1 AND revoked_at IS NULL AND expires_at > ?2`,
  )
    .bind(hash, Date.now())
    .first();
}

export async function executeHermesTool(env, scope, requestID, name, args) {
  const hosted = await installationIsHosted(env, scope.installation_id);
  if (name === "ask_hermes") {
    const error = validateAskHermes(args);
    if (error) return { ok: false, error };
    const replayKey = await hashCredential(`${scope.id}:ask_hermes:${requestID}`);
    const requestHash = await hashCredential(stableStringify(args));
    if (hosted) {
      try {
        const accepted = await env.HOSTED_AGENT.getByName(scope.installation_id).acceptVoiceAsk({
          installationID: scope.installation_id,
          callID: scope.call_id,
          voiceSessionID: scope.id,
          replayKey,
          requestHash,
          request: args.request,
        });
        return { ok: true, value: accepted };
      } catch (error) {
        return { ok: false, error: error?.message ?? String(error) };
      }
    }
    const coordinator = env.HERMES_COORDINATOR.getByName(scope.installation_id);
    try {
      const accepted = await coordinator.acceptOperation({
        installationID: scope.installation_id,
        callID: scope.call_id,
        voiceSessionID: scope.id,
        replayKey,
        requestHash,
        request: args.request,
        sessionMode: args.context_scope === "independent" ? "independent" : "active",
        sessionID: null,
        contextKey: args.independent_context ?? null,
        originHermesSessionID: scope.origin_hermes_session_id,
        activeHermesSessionID: scope.origin_hermes_session_id,
        enabledToolsets: configuredVoiceToolsets(env),
      });
      return { ok: true, value: { ...accepted, completion_delivery: "caller_events" } };
    } catch (error) {
      return { ok: false, error: error?.message ?? String(error) };
    }
  }

  if (name === "check_hermes_task") {
    const operationID = args?.operation_id;
    if (
      !args ||
      typeof args !== "object" ||
      Object.keys(args).some((key) => key !== "operation_id") ||
      typeof operationID !== "string" ||
      !/^voiceop_[0-9a-f]{32}$/.test(operationID)
    ) {
      return { ok: false, error: "invalid_operation_id" };
    }
    const operation = await env.DB.prepare(
      `SELECT voice_session_id FROM hermes_operations
        WHERE id = ?1 AND installation_id = ?2`,
    ).bind(operationID, scope.installation_id).first();
    const grants = parseStringArray(scope.granted_operation_ids_json);
    const allowed = operation && (operation.voice_session_id === scope.id || grants.includes(operationID));
    if (!allowed) return { ok: false, error: "hermes_operation_not_allowed" };
    try {
      const value = hosted
        ? await env.HOSTED_AGENT.getByName(scope.installation_id).voiceOperationStatus(operationID)
        : await env.HERMES_COORDINATOR
          .getByName(scope.installation_id)
          .operationStatus(operationID);
      return { ok: true, value };
    } catch (error) {
      return { ok: false, error: error?.message ?? String(error) };
    }
  }

  return { ok: false, error: "unsupported_tool" };
}

async function installationIsHosted(env, installationID) {
  const row = await env.DB.prepare("SELECT agent_mode FROM installations WHERE id = ?1")
    .bind(installationID)
    .first();
  return row?.agent_mode === "hosted";
}

function validateAskHermes(args) {
  if (!args || typeof args !== "object") return "invalid_arguments";
  if (Object.keys(args).some(
    (key) => !["request", "context_scope", "independent_context"].includes(key),
  )) return "unknown_argument";
  if (typeof args.request !== "string" || !args.request.trim() || args.request.length > 8_000) {
    return "invalid_request";
  }
  if (!["origin", "independent"].includes(args.context_scope)) return "invalid_context_scope";
  if (args.context_scope === "independent" && !args.independent_context) {
    return "independent_context_required";
  }
  if (args.context_scope === "origin" && args.independent_context) {
    return "independent_context_not_allowed_for_origin";
  }
  if (args.independent_context && !/^[a-z0-9][a-z0-9_-]{0,79}$/.test(args.independent_context)) {
    return "invalid_independent_context";
  }
  return null;
}

async function parsedBody(request) {
  if (request.method !== "POST") return null;
  try {
    return await request.clone().json();
  } catch {
    return null;
  }
}

function configuredVoiceToolsets(env) {
  const values = String(env.HERMES_VOICE_TOOLSETS || "web,session_search,clarify")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return [...new Set(values)];
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function parseStringArray(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : [];
  } catch {
    return [];
  }
}

/** @returns {any} */
function toolResult(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

/** @returns {any} */
function toolError(message) {
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ error: message }) }],
  };
}

function mcpToolResult(result) {
  return result.ok ? toolResult(result.value) : toolError(result.error);
}

function mcpError(status, id, code, message) {
  return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id }), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
