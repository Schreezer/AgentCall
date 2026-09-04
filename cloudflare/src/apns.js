const TOKEN_LIFETIME_MS = 50 * 60 * 1000;

export class APNsClient {
  /**
   * @param {Env} env
   * @param {{ fetcher?: typeof fetch, now?: () => number }} options
   */
  constructor(env, { fetcher = fetch, now = Date.now } = {}) {
    this.env = env;
    this.fetcher = (input, init) => fetcher(input, init);
    this.now = now;
    this.cachedProviderToken = null;
    this.providerTokenIssuedAt = 0;
    this.signingKey = null;
  }

  get configured() {
    return Boolean(
      this.env.APNS_TEAM_ID &&
        this.env.APNS_KEY_ID &&
        this.env.APNS_PRIVATE_KEY &&
        this.env.APNS_BUNDLE_ID,
    );
  }

  async sendVoIP(device, call) {
    if (!this.configured) throw new Error("APNs credentials are not configured");
    if (call.mode !== "live_voice") {
      throw new Error("VoIP delivery requires a live voice call");
    }
    const host =
      device.environment === "production"
        ? "https://api.push.apple.com"
        : "https://api.sandbox.push.apple.com";
    const payload = {
      call_id: call.id,
      caller_name: call.caller_name,
      message: call.message,
      mode: "live_voice",
    };
    const response = await this.fetcher(`${host}/3/device/${device.device_token}`, {
      method: "POST",
      headers: {
        authorization: `bearer ${await this.providerToken()}`,
        "apns-id": call.id,
        "apns-topic": `${this.env.APNS_BUNDLE_ID}.voip`,
        "apns-push-type": "voip",
        "apns-priority": "10",
        "apns-expiration": "0",
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20_000),
    });
    if (response.status !== 200) {
      const body = await response.text();
      throw new Error(`APNs ${response.status}: ${body || "unknown error"}`);
    }
    return { status: response.status, apnsID: response.headers.get("apns-id") };
  }

  async sendAlert(device, call) {
    if (!this.configured) throw new Error("APNs credentials are not configured");
    if (!device.alert_device_token) throw new Error("Standard APNs token is not registered");
    if (call.mode === "live_voice") {
      throw new Error("Live voice calls require VoIP delivery");
    }
    const host =
      device.environment === "production"
        ? "https://api.push.apple.com"
        : "https://api.sandbox.push.apple.com";
    const callerName = String(call.caller_name || "Your agent").trim() || "Your agent";
    const payload = {
      aps: {
        alert: {
          title: `${callerName} - AI agent`,
          body: call.message,
        },
        sound: "default",
        "thread-id": "agentcall-messages",
      },
      event: "agent_message",
      message_id: call.id,
      caller_name: callerName,
    };
    const response = await this.fetcher(`${host}/3/device/${device.alert_device_token}`, {
      method: "POST",
      headers: {
        authorization: `bearer ${await this.providerToken()}`,
        "apns-id": call.id,
        "apns-topic": this.env.APNS_BUNDLE_ID,
        "apns-push-type": "alert",
        "apns-priority": "10",
        "apns-expiration": "0",
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20_000),
    });
    if (response.status !== 200) {
      const body = await response.text();
      throw new Error(`APNs ${response.status}: ${body || "unknown error"}`);
    }
    return { status: response.status, apnsID: response.headers.get("apns-id") };
  }

  async sendBackground(device, event) {
    if (!this.configured) throw new Error("APNs credentials are not configured");
    if (!device.alert_device_token) throw new Error("Standard APNs token is not registered");
    const host =
      device.environment === "production"
        ? "https://api.push.apple.com"
        : "https://api.sandbox.push.apple.com";
    const payload = {
      aps: { "content-available": 1 },
      event: "hermes_approval_required",
      call_id: event.callID,
      operation_id: event.operationID,
      notification_id: event.notificationID,
    };
    const response = await this.fetcher(`${host}/3/device/${device.alert_device_token}`, {
      method: "POST",
      headers: {
        authorization: `bearer ${await this.providerToken()}`,
        "apns-id": event.notificationID,
        "apns-topic": this.env.APNS_BUNDLE_ID,
        "apns-push-type": "background",
        "apns-priority": "5",
        "apns-expiration": String(Math.floor(event.expiresAt / 1000)),
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20_000),
    });
    if (response.status !== 200) {
      const body = await response.text();
      throw new Error(`APNs ${response.status}: ${body || "unknown error"}`);
    }
    return { status: response.status, apnsID: response.headers.get("apns-id") };
  }

  async providerToken() {
    const now = this.now();
    if (
      this.cachedProviderToken &&
      now - this.providerTokenIssuedAt < TOKEN_LIFETIME_MS
    ) {
      return this.cachedProviderToken;
    }
    const issuedAt = Math.floor(now / 1000);
    const header = encodeJSON({ alg: "ES256", kid: this.env.APNS_KEY_ID });
    const claims = encodeJSON({ iss: this.env.APNS_TEAM_ID, iat: issuedAt });
    const input = `${header}.${claims}`;
    const signature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      await this.privateKey(),
      new TextEncoder().encode(input),
    );
    this.cachedProviderToken = `${input}.${base64url(new Uint8Array(signature))}`;
    this.providerTokenIssuedAt = now;
    return this.cachedProviderToken;
  }

  async privateKey() {
    if (!this.signingKey) {
      const der = pemToBytes(this.env.APNS_PRIVATE_KEY);
      this.signingKey = crypto.subtle.importKey(
        "pkcs8",
        der,
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["sign"],
      );
    }
    return this.signingKey;
  }
}

function encodeJSON(value) {
  return base64url(new TextEncoder().encode(JSON.stringify(value)));
}

function pemToBytes(value) {
  const base64 = String(value)
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s+/g, "");
  if (!base64) throw new Error("APNs private key is empty");
  const binary = atob(base64);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function base64url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
