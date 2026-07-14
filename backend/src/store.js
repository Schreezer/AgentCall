import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const EMPTY_STATE = { installations: [], calls: [] };

export class Store {
  constructor(file, { pairingTTLSeconds = 900 } = {}) {
    this.file = file;
    this.pairingTTLSeconds = pairingTTLSeconds;
    this.state = this.#load();
  }

  createInstallation(registration) {
    const now = new Date();
    const installationSecret = randomToken();
    const pairingCode = this.#newPairingCode();
    const installation = {
      id: crypto.randomUUID(),
      installationSecretHash: hash(installationSecret),
      agentTokenHash: null,
      pairingCode,
      pairingExpiresAt: new Date(now.getTime() + this.pairingTTLSeconds * 1000).toISOString(),
      pairedAt: null,
      device: registration,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    this.state.installations.push(installation);
    this.#save();
    return { installation: publicInstallation(installation), installationSecret };
  }

  updateDevice(id, installationSecret, registration) {
    const installation = this.#authorizedInstallation(id, installationSecret, "installationSecretHash");
    if (!installation) return null;
    installation.device = registration;
    installation.updatedAt = new Date().toISOString();
    this.#save();
    return publicInstallation(installation);
  }

  createPairingCode(id, installationSecret) {
    const installation = this.#authorizedInstallation(id, installationSecret, "installationSecretHash");
    if (!installation) return null;
    installation.pairingCode = this.#newPairingCode();
    installation.pairingExpiresAt = new Date(Date.now() + this.pairingTTLSeconds * 1000).toISOString();
    installation.updatedAt = new Date().toISOString();
    this.#save();
    return publicInstallation(installation);
  }

  getInstallation(id, installationSecret) {
    const installation = this.#authorizedInstallation(id, installationSecret, "installationSecretHash");
    return installation ? publicInstallation(installation) : null;
  }

  deleteInstallation(id, installationSecret) {
    const installation = this.#authorizedInstallation(id, installationSecret, "installationSecretHash");
    if (!installation) return false;
    this.state.installations = this.state.installations.filter((candidate) => candidate.id !== id);
    this.state.calls = this.state.calls.filter((call) => call.installationID !== id);
    this.#save();
    return true;
  }

  claimPairingCode(code) {
    const normalized = normalizePairingCode(code);
    const installation = this.state.installations.find((candidate) =>
      candidate.pairingCode === normalized && Date.parse(candidate.pairingExpiresAt) > Date.now()
    );
    if (!installation) return null;
    const agentToken = randomToken();
    installation.agentTokenHash = hash(agentToken);
    installation.pairingCode = null;
    installation.pairingExpiresAt = null;
    installation.pairedAt = new Date().toISOString();
    installation.updatedAt = installation.pairedAt;
    this.#save();
    return { installationID: installation.id, agentToken };
  }

  findInstallationByAgentToken(agentToken) {
    if (!agentToken) return null;
    const tokenHash = hash(agentToken);
    const installation = this.state.installations.find((candidate) =>
      candidate.agentTokenHash && safeEqual(candidate.agentTokenHash, tokenHash)
    );
    return installation ? publicInstallation(installation) : null;
  }

  createCall(installationID, input, idempotencyKey) {
    if (idempotencyKey) {
      const existing = this.state.calls.find((call) =>
        call.installationID === installationID && call.idempotencyKey === idempotencyKey
      );
      if (existing) return { call: structuredClone(existing), created: false };
    }
    const call = {
      id: crypto.randomUUID(),
      installationID,
      callerName: input.callerName,
      message: input.message,
      audioID: input.audioID ?? null,
      scheduledAt: input.scheduledAt,
      status: "scheduled",
      idempotencyKey: idempotencyKey ?? null,
      createdAt: new Date().toISOString(),
      deliveredAt: null,
      deliveryErrors: [],
    };
    this.state.calls.push(call);
    this.#save();
    return { call: structuredClone(call), created: true };
  }

  dueCalls(now = new Date()) {
    return this.state.calls
      .filter((call) => call.status === "scheduled" && new Date(call.scheduledAt) <= now)
      .map((call) => structuredClone(call));
  }

  updateCall(id, patch) {
    const call = this.state.calls.find((candidate) => candidate.id === id);
    if (!call) return null;
    Object.assign(call, patch);
    this.#save();
    return structuredClone(call);
  }

  getCall(id, installationID) {
    const call = this.state.calls.find((candidate) =>
      candidate.id === id && (!installationID || candidate.installationID === installationID)
    );
    return call ? structuredClone(call) : null;
  }

  getDevicesForInstallation(installationID) {
    const installation = this.state.installations.find((candidate) => candidate.id === installationID);
    return installation?.device ? [{ id: installation.id, ...structuredClone(installation.device) }] : [];
  }

  #authorizedInstallation(id, token, hashField) {
    if (!token) return null;
    const installation = this.state.installations.find((candidate) => candidate.id === id);
    if (!installation || !safeEqual(installation[hashField], hash(token))) return null;
    return installation;
  }

  #newPairingCode() {
    let code;
    do {
      const raw = crypto.randomBytes(6).toString("base64url").toUpperCase().replace(/[-_]/g, "A");
      code = `${raw.slice(0, 4)}-${raw.slice(4, 8)}`;
    } while (this.state.installations.some((installation) => installation.pairingCode === code));
    return code;
  }

  #load() {
    try {
      const state = JSON.parse(fs.readFileSync(this.file, "utf8"));
      return { installations: state.installations ?? [], calls: state.calls ?? [] };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      return structuredClone(EMPTY_STATE);
    }
  }

  #save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, this.file);
  }
}

function publicInstallation(installation) {
  return {
    id: installation.id,
    paired: Boolean(installation.agentTokenHash),
    pairingCode: installation.pairingCode,
    pairingExpiresAt: installation.pairingExpiresAt,
    device: structuredClone(installation.device),
  };
}

function randomToken() {
  return crypto.randomBytes(32).toString("base64url");
}

function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function safeEqual(left, right) {
  if (!left || !right || left.length !== right.length) return false;
  return crypto.timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

function normalizePairingCode(code) {
  return String(code ?? "").trim().toUpperCase();
}
