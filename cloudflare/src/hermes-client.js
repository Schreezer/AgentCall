const HERMES_ORIGIN = "http://localhost:8642";

export class HermesClient {
  constructor(env) {
    this.env = env;
  }

  async capabilities() {
    return this.request("/v1/capabilities");
  }

  async createSession(sessionID) {
    return this.request("/api/sessions", {
      method: "POST",
      body: { id: sessionID, title: "Caller voice session" },
      accepted: [201, 409],
    });
  }

  async resolveSession(sessionID) {
    return this.request(`/api/sessions/${encodeURIComponent(sessionID)}/messages`);
  }

  async createRun(operation) {
    return this.request("/v1/runs", {
      method: "POST",
      headers: {
        "idempotency-key": operation.id,
        "x-hermes-session-key": `caller:${operation.installationID}`,
      },
      body: {
        input: operation.request,
        session_id: operation.hermesSessionID,
        continue_session: true,
        client_operation_id: operation.id,
        enabled_toolsets: operation.enabledToolsets,
        instructions:
          "This request came from a live voice conversation. Return concise operational truth. " +
          "Never assume approval; pause for the configured approval gate when required.",
      },
      accepted: [202],
    });
  }

  async runStatus(runID) {
    return this.request(`/v1/runs/${encodeURIComponent(runID)}`);
  }

  async answerApproval(runID, choice) {
    return this.request(`/v1/runs/${encodeURIComponent(runID)}/approval`, {
      method: "POST",
      body: { choice },
    });
  }

  async stopRun(runID) {
    return this.request(`/v1/runs/${encodeURIComponent(runID)}/stop`, {
      method: "POST",
    });
  }

  /**
   * @param {string} path
   * @param {{ method?: string, body?: unknown, headers?: Record<string, string>, accepted?: number[] }} options
   */
  async request(path, { method = "GET", body, headers = {}, accepted = [200] } = {}) {
    if (!this.env.HERMES_PRIVATE || !this.env.HERMES_API_KEY) {
      throw new Error("hermes_private_binding_not_configured");
    }
    const response = await this.env.HERMES_PRIVATE.fetch(
      new Request(`${HERMES_ORIGIN}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.env.HERMES_API_KEY}`,
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      }),
    );
    const text = await response.text();
    let payload = {};
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = { error: text.slice(0, 500) };
    }
    if (!accepted.includes(response.status)) {
      const error = Object.assign(new Error(`hermes_http_${response.status}`), {
        status: response.status,
        payload,
      });
      throw error;
    }
    return { status: response.status, payload, headers: response.headers };
  }
}
