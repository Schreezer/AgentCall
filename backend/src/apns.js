import crypto from "node:crypto";
import http2 from "node:http2";

export class APNsClient {
  constructor({ teamID, keyID, privateKey, bundleID, connect = http2.connect, now = Date.now }) {
    this.teamID = teamID;
    this.keyID = keyID;
    this.privateKey = privateKey;
    this.bundleID = bundleID;
    this.connect = connect;
    this.now = now;
    this.cachedProviderToken = null;
    this.providerTokenIssuedAt = 0;
  }

  get configured() {
    return Boolean(this.teamID && this.keyID && this.privateKey && this.bundleID);
  }

  async sendVoIP(device, call) {
    if (!this.configured) throw new Error("APNs credentials are not configured");
    const host = device.environment === "production"
      ? "https://api.push.apple.com"
      : "https://api.sandbox.push.apple.com";
    const payload = JSON.stringify({
      call_id: call.id,
      caller_name: call.callerName,
      message: call.message,
    });

    return new Promise((resolve, reject) => {
      // Some hosts advertise APNs IPv6 addresses even when their network has no
      // working IPv6 route. Node's HTTP/2 connection can then time out before it
      // reaches a healthy IPv4 address. APNs supports IPv4, so prefer it for this
      // short-lived provider connection.
      const client = this.connect(host, { family: 4 });
      client.once("error", reject);
      const request = client.request({
        ":method": "POST",
        ":path": `/3/device/${device.token}`,
        authorization: `bearer ${this.#providerToken()}`,
        "apns-topic": `${this.bundleID}.voip`,
        "apns-push-type": "voip",
        "apns-priority": "10",
        "apns-expiration": "0",
      });
      let status;
      let body = "";
      request.setEncoding("utf8");
      request.on("response", (headers) => { status = headers[":status"]; });
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        client.close();
        if (status === 200) resolve({ status });
        else reject(new Error(`APNs ${status}: ${body || "unknown error"}`));
      });
      request.on("error", (error) => {
        client.close();
        reject(error);
      });
      request.end(payload);
    });
  }

  #providerToken() {
    const now = Math.floor(this.now() / 1000);
    if (this.cachedProviderToken && now - this.providerTokenIssuedAt < 50 * 60) {
      return this.cachedProviderToken;
    }
    const header = base64url(JSON.stringify({ alg: "ES256", kid: this.keyID }));
    const claims = base64url(JSON.stringify({ iss: this.teamID, iat: now }));
    const input = `${header}.${claims}`;
    const signature = crypto.sign("sha256", Buffer.from(input), {
      key: this.privateKey,
      dsaEncoding: "ieee-p1363",
    });
    this.cachedProviderToken = `${input}.${base64url(signature)}`;
    this.providerTokenIssuedAt = now;
    return this.cachedProviderToken;
  }
}

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}
