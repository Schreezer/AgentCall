# AgentCall Cloudflare relay

This is the durable deployment target for AgentCall. In addition to the message/audio API compatible with `../backend`, it hosts the authenticated Remote MCP endpoint used by xAI Speech-to-Speech and privately orchestrates durable Hermes runs.

## Bindings

| Binding | Purpose |
| --- | --- |
| `DB` | D1 installation, call, audio-metadata, rate-limit, and idempotency state |
| `AUDIO` | R2 audio objects |
| `SCHEDULER` | Per-installation Durable Object alarm for due calls and audio cleanup |
| `HERMES_COORDINATOR` | Per-installation ordering, session grants, operation projection, and reconciliation |
| `HERMES_OPERATION_WORKFLOW` | Durable Hermes submission, polling, approval wait, and completion handling |
| `HERMES_PRIVATE` | Workers VPC Service bound through Cloudflare Tunnel to Hermes on `localhost:8642` |

`APNS_TEAM_ID`, `APNS_KEY_ID`, `APNS_PRIVATE_KEY`, `XAI_API_KEY`, and `HERMES_API_KEY` must be Worker secrets. Permanent xAI and Hermes credentials must never be shipped in the iOS app. `APNS_BUNDLE_ID` is a non-secret variable in `wrangler.jsonc`.

## Local verification

```bash
npm install
npm run db:migrate:local
npm test
npm run check
npm run dev
```

`npm run smoke:live-mcp` performs an authenticated production smoke with a disposable Caller installation: it mints an xAI ephemeral token, initializes `/mcp`, discovers the two tools, starts a fresh Hermes session, and polls it to a terminal answer. Run it only with the explicit smoke-test environment values documented by the script; it deletes its Caller-side fixtures in `finally`.

Copy `.dev.vars.example` to `.dev.vars` only when you have local APNs credentials to test. The API can run without them, but `/health` reports `apnsReady: false` and immediate calls finish as `failed`. Do not use a production device token against the APNs sandbox endpoint or vice versa.

## Deployment

See the root `README.md` for resource creation, secret setup, migration, and deployment commands.

For message calls, require the relay status to reach `delivered`; that proves APNs accepted the request, not that the phone rang or the user answered. For live voice, separately prove Remote MCP with the smoke script and then perform one physical-iPhone conversation. Automated MCP proof is not audio proof.
