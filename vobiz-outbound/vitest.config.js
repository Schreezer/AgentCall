import path from "node:path";
import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const directory = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [cloudflareTest(async () => ({
    remoteBindings: false,
    wrangler: { configPath: path.join(directory, "wrangler.jsonc") },
    miniflare: {
      compatibilityDate: "2026-08-15",
      bindings: {
        TEST_MIGRATIONS: await readD1Migrations(path.join(directory, "migrations")),
        HERMES_PSTN_TOKEN: "test-hermes-token-32-chars-long-value",
        VOBIZ_BRIDGE_RELAY_TOKEN: "test-bridge-token-32-chars-long-value",
        VOBIZ_BRIDGE_SECRET: "test-bridge-signing-secret-32-chars",
        VOBIZ_AUTH_ID: "test-auth",
        VOBIZ_AUTH_TOKEN: "test-vobiz-auth-token",
        VOBIZ_NUMBER: "+918071580171",
        VOBIZ_PUBLIC_BASE_URL: "https://relay.example",
        VOBIZ_BRIDGE_WSS_URL: "wss://bridge.example/vobiz",
        VOBIZ_OUTBOUND_ENABLED: "true",
        VOBIZ_ALLOWED_DESTINATIONS: "+919876543210",
      },
    },
  }))],
  test: {
    include: ["test/**/*.worker.test.js"],
    setupFiles: ["./test/apply-migrations.js"],
  },
});
