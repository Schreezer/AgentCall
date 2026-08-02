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
        "Consult the user's Hermes agent in the exact signed session lineage. " +
        "Use new for independent work, active for the call's origin session, or continue only with a session ID previously returned by this tool. " +
        "The result may be working; never invent completion and use check_hermes_task with its operation_id.",
      inputSchema: {
        request: z.string().trim().min(1).max(8_000).describe("A complete standalone request for Hermes."),
        session_mode: z.enum(["active", "new", "continue"]),
        session_id: z.string().trim().min(1).max(240).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async (args) => {
      if (args.session_mode === "continue" && !args.session_id) {
        return toolError("session_id is required when session_mode is continue");
      }
      if (args.session_mode !== "continue" && args.session_id) {
        return toolError("session_id is accepted only when session_mode is continue");
      }
      const replayKey = await hashCredential(`${scope.id}:ask_hermes:${requestID}`);
      const requestHash = await hashCredential(stableStringify(args));
      const coordinator = env.HERMES_COORDINATOR.getByName(scope.installation_id);
      try {
        const result = await coordinator.acceptOperation({
          installationID: scope.installation_id,
          callID: scope.call_id,
          voiceSessionID: scope.id,
          replayKey,
          requestHash,
          request: args.request,
          sessionMode: args.session_mode,
          sessionID: args.session_id ?? null,
          originHermesSessionID: scope.origin_hermes_session_id,
          activeHermesSessionID: scope.origin_hermes_session_id,
          enabledToolsets: configuredVoiceToolsets(env),
        });
        return toolResult(result);
      } catch (error) {
        return toolError(error?.message ?? String(error));
      }
    },
  );
  server.registerTool(
    "check_hermes_task",
    {
      title: "Check Hermes task",
      description: "Check a previously accepted Hermes operation. Use only an operation_id returned to this voice session.",
      inputSchema: {
        operation_id: z.string().regex(/^voiceop_[0-9a-f]{32}$/),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async ({ operation_id: operationID }) => {
      const operation = await env.DB.prepare(
        `SELECT voice_session_id FROM hermes_operations
          WHERE id = ?1 AND installation_id = ?2`,
      ).bind(operationID, scope.installation_id).first();
      const grants = parseStringArray(scope.granted_operation_ids_json);
      const allowed = operation && (operation.voice_session_id === scope.id || grants.includes(operationID));
      if (!allowed) return toolError("hermes_operation_not_allowed");
      try {
        const result = await env.HERMES_COORDINATOR
          .getByName(scope.installation_id)
          .operationStatus(operationID);
        return toolResult(result);
      } catch (error) {
        return toolError(error?.message ?? String(error));
      }
    },
  );
  return server;
}

async function authorizeMcp(request, env) {
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

function mcpError(status, id, code, message) {
  return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id }), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
