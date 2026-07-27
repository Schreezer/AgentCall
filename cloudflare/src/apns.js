const TOKEN_LIFETIME_MS = 50 * 60 * 1000;

export class APNsClient {
  /**
   * @param {Env} env
   * @param {{ fetcher?: typeof fetch, now?: () => number }} options
   */
  constructor(env, { fetcher = fetch, now = Date.now } = {}) {
    this.env = env;
    this.fetcher = fetcher;
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
    const host =
      device.environment === "production"
        ? "https://api.push.apple.com"
        : "https://api.sandbox.push.apple.com";
    const payload = {
      call_id: call.id,
      caller_name: call.caller_name,
      message: call.message,
      ...(call.audio_id ? { audio_id: call.audio_id } : {}),
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
