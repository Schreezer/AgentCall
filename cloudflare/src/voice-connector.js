import { DurableObject } from "cloudflare:workers";

const CONNECTOR_PROTOCOL = 1;
const CONNECTOR_TIMEOUT_MS = 40_000;
const MAX_CONNECTOR_MESSAGE_BYTES = 180_000;
const CONNECTOR_REAUTH_MS = 15 * 60_000;

export class VoiceConnector extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.pending = new Map();
  }

  async fetch(request) {
    try {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/connect") {
        return this.#connect(request);
      }
      if (request.method === "GET" && url.pathname === "/status") {
        return Response.json(await this.status(), { headers: { "cache-control": "no-store" } });
      }
      if (request.method === "POST" && url.pathname === "/request") {
        const body = await readBoundedJSON(request, MAX_CONNECTOR_MESSAGE_BYTES);
        return Response.json(await this.request(body), {
          headers: { "cache-control": "no-store" },
        });
      }
      return Response.json({ error: "not_found" }, { status: 404 });
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 500;
      return Response.json(
        { error: status === 500 ? "hermes_voice_connector_failed" : error.message },
        { status, headers: { "cache-control": "no-store" } },
      );
    }
  }

  async status() {
    const sockets = this.ctx.getWebSockets();
    /** @type {any} */
    const ready = (await this.ctx.storage.get("ready")) ?? {};
    return {
      online: sockets.length > 0,
      protocol: CONNECTOR_PROTOCOL,
      providers: sanitizeProviders(ready.providers),
      preferred_provider: safeProvider(ready.preferred_provider),
      codex_version: safeText(ready.codex_version, 64),
      updated_at: Number.isFinite(ready.updated_at) ? ready.updated_at : null,
    };
  }

  async request(message) {
    if (!message || typeof message !== "object") throw connectorError("invalid_connector_request", 400);
    const type = String(message.type ?? "");
    if (!["voice.session.prepare", "voice.session.start", "voice.session.answer", "voice.session.stop"].includes(type)) {
      throw connectorError("unsupported_connector_request", 400);
    }
    const socket = this.ctx.getWebSockets()[0];
    if (!socket) throw connectorError("hermes_voice_connector_offline", 503);
    const requestID = crypto.randomUUID();
    const outbound = JSON.stringify({ ...message, protocol: CONNECTOR_PROTOCOL, request_id: requestID });
    if (byteLength(outbound) > MAX_CONNECTOR_MESSAGE_BYTES) {
      throw connectorError("connector_request_too_large", 413);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestID);
        reject(connectorError("hermes_voice_connector_timeout", 504));
      }, CONNECTOR_TIMEOUT_MS);
      this.pending.set(requestID, { resolve, reject, timer });
      try {
        socket.send(outbound);
      } catch {
        clearTimeout(timer);
        this.pending.delete(requestID);
        reject(connectorError("hermes_voice_connector_offline", 503));
      }
    });
  }

  async webSocketMessage(socket, message) {
    if (typeof message !== "string" || byteLength(message) > MAX_CONNECTOR_MESSAGE_BYTES) return;
    let payload;
    try {
      payload = JSON.parse(message);
    } catch {
      return;
    }
    if (payload?.type === "connector.ready" && payload.protocol === CONNECTOR_PROTOCOL) {
      const attachment = socket.deserializeAttachment();
      if (!Number.isFinite(attachment?.connected_at) || Date.now() - attachment.connected_at > CONNECTOR_REAUTH_MS) {
        socket.close(4001, "reauthenticate");
        return;
      }
      await this.ctx.storage.put("ready", {
        providers: sanitizeProviders(payload.providers),
        preferred_provider: safeProvider(payload.preferred_provider),
        codex_version: safeText(payload.codex_version, 64),
        updated_at: Date.now(),
      });
      return;
    }
    const pending = this.pending.get(payload?.request_id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(payload.request_id);
    if (payload?.ok === true) {
      pending.resolve(payload);
    } else {
      pending.resolve({
        ok: false,
        error: safeError(payload?.error),
        diagnostic: sanitizeDiagnostic(payload?.diagnostic),
      });
    }
  }

  async webSocketClose() {
    await this.#markOffline();
  }

  async webSocketError() {
    await this.#markOffline();
  }

  async #connect(request) {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return Response.json({ error: "websocket_upgrade_required" }, { status: 426 });
    }
    for (const existing of this.ctx.getWebSockets()) {
      existing.close(1000, "replaced");
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ connected_at: Date.now() });
    server.send(JSON.stringify({ type: "connector.hello", protocol: CONNECTOR_PROTOCOL }));
    return new Response(null, { status: 101, webSocket: client });
  }

  async #markOffline() {
    /** @type {any} */
    const prior = (await this.ctx.storage.get("ready")) ?? {};
    await this.ctx.storage.put("ready", { ...prior, updated_at: Date.now() });
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(connectorError("hermes_voice_connector_offline", 503));
      this.pending.delete(id);
    }
  }
}

function sanitizeProviders(value) {
  return {
    codex: value?.codex === true,
    xai: value?.xai === true,
  };
}

function safeProvider(value) {
  return ["codex", "xai"].includes(value) ? value : null;
}

function safeText(value, max) {
  return typeof value === "string" && /^[A-Za-z0-9._+-]+$/.test(value) ? value.slice(0, max) : null;
}

function safeError(value) {
  const allowed = new Set([
    "no_voice_provider_available",
    "codex_not_authenticated",
    "codex_app_server_unavailable",
    "codex_realtime_failed",
    "xai_not_configured",
    "xai_client_secret_failed",
    "voice_session_not_found",
    "invalid_connector_request",
  ]);
  return allowed.has(value) ? value : "hermes_voice_connector_failed";
}

function sanitizeDiagnostic(value) {
  if (!value || typeof value !== "object") return undefined;
  const output = {};
  for (const key of ["reason", "provider", "upstream_status", "codex_version"]) {
    const item = value[key];
    if ((typeof item === "string" && /^[A-Za-z0-9._:/+-]{1,160}$/.test(item)) || Number.isInteger(item)) {
      output[key] = item;
    }
  }
  return Object.keys(output).length ? output : undefined;
}

function connectorError(message, status) {
  /** @type {Error & { status?: number }} */
  const error = new Error(message);
  error.status = status;
  return error;
}

function byteLength(value) {
  return new TextEncoder().encode(value).byteLength;
}

async function readBoundedJSON(request, maxBytes) {
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > maxBytes) throw connectorError("connector_request_too_large", 413);
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw connectorError("invalid_connector_request", 400);
  }
}
