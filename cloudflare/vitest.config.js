import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";
import { MockAgent } from "undici";

const directory = path.dirname(fileURLToPath(import.meta.url));

process.env.APNS_TEAM_ID ??= "TESTTEAMID";
process.env.APNS_KEY_ID ??= "TESTKEYID";
process.env.APNS_PRIVATE_KEY ??= "not-a-real-private-key";
const fetchMock = new MockAgent();
fetchMock.disableNetConnect();
fetchMock
  .get("https://api.x.ai")
  .intercept({ path: "/v1/realtime/client_secrets", method: "POST" })
  .reply(200, { value: "ephemeral-only" })
  .persist();

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: path.join(directory, "wrangler.jsonc") },
      miniflare: {
        fetchMock,
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(
            path.join(directory, "migrations"),
          ),
          APNS_TEAM_ID: process.env.APNS_TEAM_ID,
          APNS_KEY_ID: process.env.APNS_KEY_ID,
          APNS_PRIVATE_KEY: process.env.APNS_PRIVATE_KEY,
          XAI_API_KEY: "test-xai-key",
          LIVE_VOICE_ENABLED: "true",
          LIVE_VOICE_BACKEND: "legacy",
          LIVE_VOICE_PROVIDER: "xai",
        },
      },
    })),
  ],
  test: {
    include: ["test/**/*.worker.test.js"],
    setupFiles: ["./test/apply-migrations.js"],
  },
});
