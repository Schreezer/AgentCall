import http from "node:http";
import { fileURLToPath } from "node:url";
import { APNsClient } from "./apns.js";
import { AudioStore, normalizeAudioContentType, SUPPORTED_AUDIO_TYPES } from "./audio-store.js";
import { loadConfig, readAPNsPrivateKey } from "./config.js";
import { Store } from "./store.js";
import { CallWorker } from "./worker.js";

export function createServer({ config, store, worker, audioStore }) {
  const pairingLimiter = new RateLimiter({ limit: 20, windowMs: 60_000 });
  const callLimiter = new RateLimiter({ limit: 10, windowMs: 60_000 });
  const audioLimiter = new RateLimiter({ limit: 10, windowMs: 60_000 });

  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, config.publicBaseURL);
      const clientID = request.socket.remoteAddress ?? "unknown";

      if (request.method === "GET" && url.pathname === "/health") {
        return json(response, 200, {
          ok: true,
          service: "caller-push-relay",
          storageReady: true,
          apnsReady: worker.apns.configured,
        });
      }

      if (request.method === "POST" && url.pathname === "/v1/installations") {
        if (!pairingLimiter.allow(clientID)) return json(response, 429, { error: "rate_limited" });
        const body = await readJSON(request);
        const error = validateDevice(body);
        if (error) return json(response, 400, { error });
        const result = store.createInstallation(body);
        return json(response, 201, installationResponse(result.installation, result.installationSecret));
      }

      const deviceMatch = url.pathname.match(/^\/v1\/installations\/([0-9a-f-]+)\/device$/i);
      if (request.method === "PUT" && deviceMatch) {
        const body = await readJSON(request);
        const error = validateDevice(body);
        if (error) return json(response, 400, { error });
        const installation = store.updateDevice(deviceMatch[1], bearerToken(request), body);
        return installation
          ? json(response, 200, installationResponse(installation))
          : json(response, 401, { error: "invalid_installation_credential" });
      }

      const audioDownloadMatch = url.pathname.match(
        /^\/v1\/installations\/([0-9a-f-]+)\/audio\/([0-9a-f-]+)$/i,
      );
      if (request.method === "GET" && audioDownloadMatch) {
        const installation = store.getInstallation(audioDownloadMatch[1], bearerToken(request));
        if (!installation) return json(response, 401, { error: "invalid_installation_credential" });
        const audio = audioStore.read(audioDownloadMatch[2], installation.id);
        if (!audio) return json(response, 404, { error: "audio_not_found_or_expired" });
        response.writeHead(200, {
          "cache-control": "no-store",
          "content-length": audio.data.length,
          "content-type": audio.contentType,
          "x-content-type-options": "nosniff",
        });
        return response.end(audio.data);
      }

      const installationMatch = url.pathname.match(/^\/v1\/installations\/([0-9a-f-]+)$/i);
      if (request.method === "GET" && installationMatch) {
        const installation = store.getInstallation(installationMatch[1], bearerToken(request));
        return installation
          ? json(response, 200, installationResponse(installation))
          : json(response, 401, { error: "invalid_installation_credential" });
      }
      if (request.method === "DELETE" && installationMatch) {
        const deleted = store.deleteInstallation(installationMatch[1], bearerToken(request));
        if (!deleted) return json(response, 401, { error: "invalid_installation_credential" });
        audioStore.deleteForInstallation(installationMatch[1]);
        response.writeHead(204, { "cache-control": "no-store" });
        return response.end();
      }

      const pairingCodeMatch = url.pathname.match(/^\/v1\/installations\/([0-9a-f-]+)\/pairing-code$/i);
      if (request.method === "POST" && pairingCodeMatch) {
        if (!pairingLimiter.allow(clientID)) return json(response, 429, { error: "rate_limited" });
        const installation = store.createPairingCode(pairingCodeMatch[1], bearerToken(request));
        return installation
          ? json(response, 200, installationResponse(installation))
          : json(response, 401, { error: "invalid_installation_credential" });
      }

      if (request.method === "POST" && url.pathname === "/v1/pairings/claim") {
        if (!pairingLimiter.allow(clientID)) return json(response, 429, { error: "rate_limited" });
        const body = await readJSON(request);
        const result = store.claimPairingCode(body.pairing_code);
        return result
          ? json(response, 200, {
              installation_id: result.installationID,
              agent_token: result.agentToken,
              relay_url: config.publicBaseURL,
            })
          : json(response, 404, { error: "invalid_or_expired_pairing_code" });
      }

      const installation = store.findInstallationByAgentToken(bearerToken(request));
      if (!installation) return json(response, 401, { error: "invalid_agent_credential" });

      if (request.method === "POST" && url.pathname === "/v1/audio") {
        if (!audioLimiter.allow(installation.id)) return json(response, 429, { error: "rate_limited" });
        const idempotencyKey = request.headers["idempotency-key"];
        if (!validIdempotencyKey(idempotencyKey)) {
          return json(response, 400, { error: "valid_idempotency_key_required" });
        }
        const contentType = normalizeAudioContentType(request.headers["content-type"]);
        if (!SUPPORTED_AUDIO_TYPES.has(contentType)) {
          return json(response, 415, { error: "unsupported_audio_type" });
        }
        const result = audioStore.save(installation.id, {
          data: await readBinary(request, audioStore.maxBytes),
          contentType,
          filename: request.headers["x-audio-filename"],
          idempotencyKey,
        });
        return json(response, result.created ? 201 : 200, publicAudio(result.audio));
      }

      if (request.method === "POST" && url.pathname === "/v1/calls") {
        if (!callLimiter.allow(installation.id)) return json(response, 429, { error: "rate_limited" });
        const idempotencyKey = request.headers["idempotency-key"];
        if (!validIdempotencyKey(idempotencyKey)) {
          return json(response, 400, { error: "valid_idempotency_key_required" });
        }
        const parsed = validateCall(await readJSON(request));
        if (parsed.error) return json(response, 400, { error: parsed.error });
        const audio = parsed.value.audioID
          ? audioStore.metadata(parsed.value.audioID, installation.id)
          : null;
        if (parsed.value.audioID && !audio) {
          return json(response, 400, { error: "invalid_or_expired_audio_id" });
        }
        if (audio && Date.parse(parsed.value.scheduledAt) >= Date.parse(audio.expiresAt)) {
          return json(response, 400, { error: "audio_will_expire_before_scheduled_call" });
        }
        const result = store.createCall(installation.id, parsed.value, idempotencyKey);
        // Give immediate calls one delivery attempt before answering so simple
        // agent clients usually receive the terminal APNs result instead of a
        // fleeting `scheduled` snapshot. Scheduled future calls remain queued.
        await worker.tick();
        const currentCall = store.getCall(result.call.id, installation.id) ?? result.call;
        return json(response, result.created ? 202 : 200, publicCall(currentCall));
      }

      const callMatch = url.pathname.match(/^\/v1\/calls\/([0-9a-f-]+)$/i);
      if (request.method === "GET" && callMatch) {
        const call = store.getCall(callMatch[1], installation.id);
        return call ? json(response, 200, publicCall(call)) : json(response, 404, { error: "call_not_found" });
      }

      return json(response, 404, { error: "not_found" });
    } catch (error) {
      const status = errorStatus(error);
      return json(response, status, { error: status === 500 ? "internal_error" : error.message });
    }
  });
}

function validateDevice(body) {
  if (!body || typeof body !== "object") return "body_required";
  if (!/^[0-9a-f]{32,}$/i.test(body.token ?? "")) return "invalid_device_token";
  if (body.platform !== "ios") return "unsupported_platform";
  if (!["sandbox", "production"].includes(body.environment)) return "invalid_environment";
  if (body.device_name && (typeof body.device_name !== "string" || body.device_name.length > 120)) return "invalid_device_name";
  return null;
}

function validateCall(body) {
  if (!body || typeof body !== "object") return { error: "body_required" };
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message || message.length > 500) return { error: "message_must_be_1_to_500_characters" };
  const callerName = typeof body.caller_name === "string" ? body.caller_name.trim() : "Hermes";
  if (!callerName || callerName.length > 80) return { error: "invalid_caller_name" };
  const audioID = body.audio_id ?? null;
  if (audioID !== null && !/^[0-9a-f-]{36}$/i.test(audioID)) return { error: "invalid_audio_id" };
  const scheduledAt = body.scheduled_at ?? new Date().toISOString();
  const timestamp = Date.parse(scheduledAt);
  if (!Number.isFinite(timestamp)) return { error: "scheduled_at_must_be_iso_8601" };
  if (timestamp > Date.now() + 366 * 24 * 60 * 60 * 1000) return { error: "scheduled_at_too_far_in_future" };
  return {
    value: {
      message,
      callerName,
      audioID,
      scheduledAt: new Date(Math.max(timestamp, Date.now())).toISOString(),
    },
  };
}

async function readJSON(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 16_384) throw Object.assign(new Error("body_too_large"), { code: "BODY_TOO_LARGE" });
  }
  try {
    return JSON.parse(body || "{}");
  } catch {
    throw Object.assign(new Error("invalid_json"), { code: "INVALID_JSON" });
  }
}

async function readBinary(request, maxBytes) {
  const contentLength = Number.parseInt(request.headers["content-length"] ?? "0", 10);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw Object.assign(new Error("audio_file_too_large"), { code: "BODY_TOO_LARGE" });
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > maxBytes) {
      throw Object.assign(new Error("audio_file_too_large"), { code: "BODY_TOO_LARGE" });
    }
    chunks.push(chunk);
  }
  if (total === 0) throw Object.assign(new Error("audio_file_required"), { code: "AUDIO_FILE_REQUIRED" });
  return Buffer.concat(chunks, total);
}

function bearerToken(request) {
  const match = String(request.headers.authorization ?? "").match(/^Bearer\s+(.+)$/i);
  return match?.[1] ?? null;
}

function installationResponse(installation, installationSecret) {
  return {
    installation_id: installation.id,
    installation_secret: installationSecret,
    paired: installation.paired,
    pairing_code: installation.pairingCode,
    pairing_expires_at: installation.pairingExpiresAt,
  };
}

function publicCall(call) {
  return {
    id: call.id,
    status: call.status,
    caller_name: call.callerName,
    message: call.message,
    audio_id: call.audioID,
    has_audio: Boolean(call.audioID),
    scheduled_at: call.scheduledAt,
    delivered_at: call.deliveredAt,
    delivery_errors: call.deliveryErrors,
  };
}

function publicAudio(audio) {
  return {
    audio_id: audio.id,
    content_type: audio.contentType,
    filename: audio.filename,
    size_bytes: audio.sizeBytes,
    expires_at: audio.expiresAt,
  };
}

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

function validIdempotencyKey(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 200;
}

function errorStatus(error) {
  if (error.code === "BODY_TOO_LARGE") return 413;
  if (error.code === "UNSUPPORTED_AUDIO_TYPE") return 415;
  if (["INVALID_JSON", "AUDIO_FILE_REQUIRED"].includes(error.code)) return 400;
  return 500;
}

class RateLimiter {
  constructor({ limit, windowMs }) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.entries = new Map();
  }

  allow(key) {
    const now = Date.now();
    const entry = this.entries.get(key);
    if (!entry || entry.resetAt <= now) {
      this.entries.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    entry.count += 1;
    return entry.count <= this.limit;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = loadConfig();
  const store = new Store(config.dataFile, { pairingTTLSeconds: config.pairingTTLSeconds });
  const audioStore = new AudioStore(config.audio.directory, config.audio);
  const apns = new APNsClient({ ...config.apns, privateKey: readAPNsPrivateKey(config) });
  const worker = new CallWorker(store, apns);
  const server = createServer({ config, store, worker, audioStore });
  worker.start();
  server.listen(config.port, () => console.log(`Caller push relay listening on :${config.port}`));
}
