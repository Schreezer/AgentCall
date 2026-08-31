import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export const TESTED_CODEX_VERSION = "0.149.1";

export class CodexAppServerClient {
  constructor(child) {
    this.child = child;
    this.nextID = 1;
    this.pending = new Map();
    this.notificationWaiters = new Set();
    this.requestHandler = null;
    this.closedError = null;

    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => this.#receive(line));
    child.stderr.on("data", (chunk) => {
      const message = String(chunk).trim();
      if (message) console.error(`[codex app-server] ${message}`);
    });
    child.once("exit", (code, signal) => {
      this.#close(new Error(`codex app-server exited (${signal ?? code ?? "unknown"})`));
    });
    child.once("error", (error) => this.#close(error));
  }

  static async launch({ command = "codex", expectedVersion = TESTED_CODEX_VERSION } = {}) {
    await assertCodexVersion(command, expectedVersion);
    const child = spawn(
      command,
      ["app-server", "--enable", "realtime_conversation", "--listen", "stdio://"],
      { stdio: ["pipe", "pipe", "pipe"], shell: false },
    );
    const client = new CodexAppServerClient(child);
    await client.request("initialize", {
      clientInfo: {
        name: "agentcaller_codex_voice_broker",
        title: "AgentCaller Codex Voice Broker",
        version: "0.1.0",
      },
      capabilities: { experimentalApi: true },
    });
    client.notify("initialized", {});
    return client;
  }

  setRequestHandler(handler) {
    this.requestHandler = handler;
  }

  request(method, params = {}, { timeoutMs = 30_000 } = {}) {
    if (this.closedError) return Promise.reject(this.closedError);
    const id = this.nextID++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.#send({ method, id, params });
    });
  }

  notify(method, params = {}) {
    this.#send({ method, params });
  }

  waitForNotification(method, predicate = () => true, { timeoutMs = 30_000 } = {}) {
    return new Promise((resolve, reject) => {
      const waiter = { method, predicate, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        this.notificationWaiters.delete(waiter);
        reject(new Error(`${method} notification timed out`));
      }, timeoutMs);
      this.notificationWaiters.add(waiter);
    });
  }

  close() {
    if (!this.child.killed) this.child.kill("SIGTERM");
  }

  #send(message) {
    if (this.closedError) throw this.closedError;
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #receive(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      console.error("codex app-server emitted invalid JSON");
      return;
    }
    if (message.id !== undefined && ("result" in message || "error" in message)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message ?? "codex app-server request failed"));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (message.id !== undefined && message.method) {
      void this.#handleServerRequest(message);
      return;
    }
    if (!message.method) return;
    for (const waiter of this.notificationWaiters) {
      if (waiter.method !== message.method || !waiter.predicate(message.params)) continue;
      clearTimeout(waiter.timer);
      this.notificationWaiters.delete(waiter);
      waiter.resolve(message.params);
    }
  }

  async #handleServerRequest(message) {
    try {
      if (!this.requestHandler) throw new Error(`unsupported server request: ${message.method}`);
      const result = await this.requestHandler(message.method, message.params);
      this.#send({ id: message.id, result });
    } catch (error) {
      this.#send({
        id: message.id,
        error: { code: -32000, message: error?.message ?? String(error) },
      });
    }
  }

  #close(error) {
    if (this.closedError) return;
    this.closedError = error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const waiter of this.notificationWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.notificationWaiters.clear();
  }
}

export async function assertCodexVersion(command, expectedVersion = TESTED_CODEX_VERSION) {
  const child = spawn(command, ["--version"], { stdio: ["ignore", "pipe", "pipe"], shell: false });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  if (code !== 0) throw new Error(`could not run codex --version: ${stderr.trim()}`);
  const found = stdout.match(/codex-cli\s+([^\s]+)/)?.[1];
  if (found !== expectedVersion) {
    throw new Error(`Codex CLI ${expectedVersion} is required; found ${found ?? "unknown"}`);
  }
}
