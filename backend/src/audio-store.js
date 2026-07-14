import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const SUPPORTED_AUDIO_TYPES = new Set([
  "audio/aac",
  "audio/aiff",
  "audio/mpeg",
  "audio/mp4",
  "audio/wav",
  "audio/x-aiff",
  "audio/x-caf",
  "audio/x-m4a",
  "audio/x-wav",
]);

export class AudioStore {
  constructor(directory, { maxBytes = 5_000_000, ttlSeconds = 3600, now = Date.now } = {}) {
    this.directory = directory;
    this.maxBytes = maxBytes;
    this.ttlSeconds = ttlSeconds;
    this.now = now;
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.cleanupExpired();
  }

  save(installationID, { data, contentType, filename, idempotencyKey }) {
    const normalizedType = normalizeAudioContentType(contentType);
    if (!SUPPORTED_AUDIO_TYPES.has(normalizedType)) {
      throw codedError("unsupported_audio_type", "UNSUPPORTED_AUDIO_TYPE");
    }
    if (!Buffer.isBuffer(data) || data.length === 0) {
      throw codedError("audio_file_required", "AUDIO_FILE_REQUIRED");
    }
    if (data.length > this.maxBytes) {
      throw codedError("audio_file_too_large", "BODY_TOO_LARGE");
    }

    this.cleanupExpired();
    const existing = idempotencyKey && this.#findByIdempotencyKey(installationID, idempotencyKey);
    if (existing) return { audio: publicAudio(existing), created: false };

    const now = new Date(this.now());
    const audio = {
      id: crypto.randomUUID(),
      installationID,
      contentType: normalizedType,
      filename: safeFilename(filename),
      sizeBytes: data.length,
      idempotencyKey: idempotencyKey ?? null,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.ttlSeconds * 1000).toISOString(),
    };
    const contentPath = this.#contentPath(audio.id);
    const metadataPath = this.#metadataPath(audio.id);
    const temporaryContentPath = `${contentPath}.${crypto.randomUUID()}.tmp`;
    const temporaryMetadataPath = `${metadataPath}.${crypto.randomUUID()}.tmp`;

    try {
      fs.writeFileSync(temporaryContentPath, data, { mode: 0o600 });
      fs.writeFileSync(temporaryMetadataPath, JSON.stringify(audio), { mode: 0o600 });
      fs.renameSync(temporaryContentPath, contentPath);
      fs.renameSync(temporaryMetadataPath, metadataPath);
    } catch (error) {
      removeIfPresent(temporaryContentPath);
      removeIfPresent(temporaryMetadataPath);
      removeIfPresent(contentPath);
      removeIfPresent(metadataPath);
      throw error;
    }
    return { audio: publicAudio(audio), created: true };
  }

  metadata(id, installationID) {
    const audio = this.#readMetadata(id);
    if (!audio || audio.installationID !== installationID) return null;
    if (Date.parse(audio.expiresAt) <= this.now()) {
      this.delete(id);
      return null;
    }
    return publicAudio(audio);
  }

  read(id, installationID) {
    const audio = this.#readMetadata(id);
    if (!audio || audio.installationID !== installationID) return null;
    if (Date.parse(audio.expiresAt) <= this.now()) {
      this.delete(id);
      return null;
    }
    try {
      return { ...publicAudio(audio), data: fs.readFileSync(this.#contentPath(id)) };
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  delete(id) {
    removeIfPresent(this.#contentPath(id));
    removeIfPresent(this.#metadataPath(id));
  }

  deleteForInstallation(installationID) {
    for (const metadataFile of this.#metadataFiles()) {
      const audio = this.#readMetadataFile(metadataFile);
      if (audio?.installationID === installationID) this.delete(audio.id);
    }
  }

  cleanupExpired() {
    for (const metadataFile of this.#metadataFiles()) {
      const audio = this.#readMetadataFile(metadataFile);
      if (!audio || Date.parse(audio.expiresAt) <= this.now()) {
        const id = path.basename(metadataFile, ".json");
        this.delete(id);
      }
    }
  }

  #findByIdempotencyKey(installationID, idempotencyKey) {
    for (const metadataFile of this.#metadataFiles()) {
      const audio = this.#readMetadataFile(metadataFile);
      if (audio?.installationID === installationID && audio.idempotencyKey === idempotencyKey) {
        if (Date.parse(audio.expiresAt) > this.now()) return audio;
        this.delete(audio.id);
      }
    }
    return null;
  }

  #readMetadata(id) {
    if (!/^[0-9a-f-]{36}$/i.test(id ?? "")) return null;
    return this.#readMetadataFile(this.#metadataPath(id));
  }

  #readMetadataFile(metadataFile) {
    try {
      return JSON.parse(fs.readFileSync(metadataFile, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
      throw error;
    }
  }

  #metadataFiles() {
    try {
      return fs.readdirSync(this.directory)
        .filter((name) => name.endsWith(".json"))
        .map((name) => path.join(this.directory, name));
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  }

  #contentPath(id) {
    return path.join(this.directory, `${id}.audio`);
  }

  #metadataPath(id) {
    return path.join(this.directory, `${id}.json`);
  }
}

export function normalizeAudioContentType(value) {
  return String(value ?? "").split(";", 1)[0].trim().toLowerCase();
}

function publicAudio(audio) {
  return {
    id: audio.id,
    contentType: audio.contentType,
    filename: audio.filename,
    sizeBytes: audio.sizeBytes,
    createdAt: audio.createdAt,
    expiresAt: audio.expiresAt,
  };
}

function safeFilename(value) {
  const filename = path.basename(String(value ?? "speech"));
  return filename.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 180) || "speech";
}

function removeIfPresent(file) {
  try {
    fs.unlinkSync(file);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function codedError(message, code) {
  return Object.assign(new Error(message), { code });
}
