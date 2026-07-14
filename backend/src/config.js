import fs from "node:fs";

export function loadConfig(env = process.env) {
  const config = {
    port: parseInteger(env.PORT ?? "8788", "PORT"),
    publicBaseURL: env.PUBLIC_BASE_URL ?? `http://127.0.0.1:${env.PORT ?? 8788}`,
    dataFile: env.DATA_FILE ?? "./data/relay-state.json",
    pairingTTLSeconds: parseInteger(env.PAIRING_TTL_SECONDS ?? "900", "PAIRING_TTL_SECONDS"),
    apns: {
      teamID: env.APNS_TEAM_ID,
      keyID: env.APNS_KEY_ID,
      privateKeyPath: env.APNS_PRIVATE_KEY_PATH,
      bundleID: env.APNS_BUNDLE_ID ?? "com.chirag.agentcaller",
    },
  };
  new URL(config.publicBaseURL);
  return config;
}

export function readAPNsPrivateKey(config) {
  if (!config.apns.privateKeyPath) return null;
  return fs.readFileSync(config.apns.privateKeyPath, "utf8");
}

function parseInteger(value, name) {
  const result = Number.parseInt(value, 10);
  if (!Number.isInteger(result) || result <= 0) throw new Error(`${name} must be a positive integer`);
  return result;
}
