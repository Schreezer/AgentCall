# AgentCall Cloudflare relay

This is the durable deployment target for AgentCall. In addition to the message/audio API compatible with `../backend`, it hosts the authenticated Remote MCP endpoint used by xAI Speech-to-Speech and privately orchestrates durable Hermes runs.

## Bindings

| Binding | Purpose |
| --- | --- |
| `DB` | D1 installation, call, audio-metadata, rate-limit, and idempotency state |
| `AUDIO` | R2 audio objects |
| `SCHEDULER` | Per-installation Durable Object alarm for due calls and audio cleanup |
| `HERMES_COORDINATOR` | Per-installation ordering, session grants, operation projection, and reconciliation |
| `VOICE_CONNECTOR` | Installation-scoped outbound WebSocket rendezvous and sanitized provider readiness |
| `HERMES_WORKFLOW` | Durable Hermes submission, polling, approval wait, and completion handling |
| `HERMES_PRIVATE` | Workers VPC Service bound through Cloudflare Tunnel to Hermes on `127.0.0.1:8642` |

`APNS_TEAM_ID`, `APNS_KEY_ID`, `APNS_PRIVATE_KEY`, and `HERMES_API_KEY` must be Worker secrets. Permanent xAI and Codex credentials stay on the paired Hermes host and must never be shipped in the Worker or iOS app. `APNS_BUNDLE_ID` is a non-secret variable in `wrangler.jsonc`.

`LIVE_VOICE_BACKEND=hermes_connector` is the primary path. The signed skill opens `/v1/agent-connect` from the Hermes host, reports only boolean provider readiness, and handles each bootstrap locally. `LIVE_VOICE_PROVIDER=auto` prefers Codex and falls back to xAI when only xAI is configured. Set `LIVE_VOICE_BACKEND=legacy` only for rollback to the older Worker xAI/public Codex broker configuration; no automatic fallback can move a permanent credential into Worker storage.

The Worker also serves the signed `urgent-caller` release. `bootstrap.py` is public but pinned by SHA-256 in the iOS setup prompt; manifests and release files require the installation-scoped agent token. Build artifacts are signed offline with the Ed25519 private key at `.secrets/caller-release-ed25519.pem` or `CALLER_RELEASE_SIGNING_KEY`. Only the public key and signed generated release are committed. Back up the private signing key securely before relying on managed production updates.

For each release, update `integrations/hermes/urgent-caller/release.json` and bump its semantic version. Use `change_class: "compatible"` with `requires_user_approval: false` only for behavior-preserving instruction and client fixes. Any new capability, permission, data source, or tool scope must use a non-compatible change class and `requires_user_approval: true`. Then run `npm run build:skill-release`, review the signed manifest, run the tests/checks, and deploy the Worker. CI can validate the committed signature without access to the private key.

## Local verification

```bash
npm install
npm run db:migrate:local
npm test
npm run check
npm run dev
```

`npm run smoke:live-mcp` performs an authenticated production smoke with a disposable Caller installation: it mints an xAI ephemeral token, initializes `/mcp`, discovers the two tools, starts a fresh Hermes session, requires `ask_hermes` to acknowledge `queued` immediately, and reads the call-scoped event feed until the terminal answer arrives. Run it only with the explicit smoke-test environment values documented by the script; it deletes its Caller-side fixtures in `finally`.

Copy `.dev.vars.example` to `.dev.vars` only when you have local APNs credentials to test. The API can run without them, but `/health` reports `apnsReady: false` and immediate calls finish as `failed`. Do not use a production device token against the APNs sandbox endpoint or vice versa.

## Deployment

See the root `README.md` for resource creation, secret setup, migration, and deployment commands.

For message calls, require the relay status to reach `delivered`; that proves APNs accepted the request, not that the phone rang or the user answered. For live voice, separately prove Remote MCP with the smoke script and then perform one physical-iPhone conversation. Automated MCP proof is not audio proof.
