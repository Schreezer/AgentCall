# Vobiz outbound pilot

This is a separate Cloudflare Worker for Hermes-initiated outbound calls. It does not deploy the existing Caller relay, link the purchased DID to a Voice Application, or configure Jio forwarding.

## Routes

| Route | Authentication | Purpose |
| --- | --- | --- |
| `GET /health` | Public | Confirms Worker and D1 are reachable. |
| `POST /v1/pstn-calls` | `Bearer HERMES_PSTN_TOKEN` | Place one call with `Idempotency-Key: <UUID>` and JSON `{ "to": "+91...", "briefing": "...", "opening_speech": "Hi, this is an AI assistant..." }`. `opening_speech` is optional. |
| `GET /v1/pstn-calls/{id}` | `Bearer HERMES_PSTN_TOKEN` | Read status and any available summary. |
| `POST /v1/vobiz/{answer,ring,hangup}/{id}/{token}` | Per-call 256-bit callback token, plus Vobiz V2/V3 HMAC when present | Answer XML and provider call state. |
| `GET /v1/vobiz/bridge/calls/{id}` | `Bearer VOBIZ_BRIDGE_RELAY_TOKEN` | Give the media bridge its bounded call brief and Vobiz call UUID. |
| `POST /v1/vobiz/bridge/calls/{id}/claim` | `Bearer VOBIZ_BRIDGE_RELAY_TOKEN` | Atomically claim the call once before opening a Codex session. |
| `POST /v1/vobiz/bridge/calls/{id}/events` | `Bearer VOBIZ_BRIDGE_RELAY_TOKEN` | Report connected, ended, or failed; optionally include summary or bounded transcript. |

The Worker accepts canonical Indian `+91` destinations on the `VOBIZ_ALLOWED_DESTINATIONS` allowlist only. It checks the Codex bridge's `/health` for `codex_ready: true` before calling Vobiz, enforces a rolling 1000 ms gap before provider dispatch and three attempts per minute, and permits only one active call at a time. It uses a 30-second ringing limit and 3-minute call cap. It does not use an OpenAI API key or an alternate voice provider. Vobiz callback comparison accepts exact Indian 10-digit national numbers as well as `+91` numbers. A `queued` response means Vobiz accepted the request, not that the recipient answered. `dispatch_unknown` means the provider may have accepted a request that timed out; never redial that idempotency key automatically.

The optional opening speech is limited to 320 characters, strips extra horizontal or line whitespace, rejects control characters, and must explicitly say `AI` or `artificial intelligence`. Its normalized text is part of the idempotency hash and is passed to the bridge as `opening_speech`. Without it, the Worker uses a generic AI-disclosed greeting.

Vobiz's [Make Call API](https://www.vobiz.ai/docs/call/make-call) documents `answer_url`, `ring_url`, `hangup_url`, and `hangup_on_ring`. Its [callback validation guide](https://www.vobiz.ai/docs/concepts/validating-callbacks) says HMAC headers may be absent unless callback URL credentials are configured. Every URL therefore also carries a unique random token whose hash is stored in D1. When V2/V3 signature headers are present, the Worker validates them and rejects invalid ones. It requires the stored Vobiz `CallUUID` and compares caller ID and destination when Vobiz supplies them.

Automatic Cloudflare observability logs and traces are disabled for the pilot because callback URLs contain per-call tokens. Nonce records store only a hash of the callback path. Application error logging omits the request URL and bridge failure details.

Ring and Hangup callbacks return HTTP 200 as [Vobiz requires](https://www.vobiz.ai/docs/concepts/callbacks). Hangup uses documented `CallStatus` and `HangupCause`, plus whether the call reached the answer or bridge stage. It preserves a recorded bridge failure even if Hangup arrives afterward. If the bridge becomes unavailable at answer time, the Worker records a failed call and returns `<Hangup/>` with HTTP 200. Turning `VOBIZ_OUTBOUND_ENABLED` off blocks new calls while existing callbacks and bridge status reports continue.

## Configuration

Dedicated D1: `caller-vobiz-outbound` (`6a478995-5ebf-4d77-a7e5-3a7d700e4a91`, APAC). Run `npm run check`, then apply the initial migration to that database before deploying. Keep all required values in Wrangler secrets, not source:

| Secret | Value |
| --- | --- |
| `HERMES_PSTN_TOKEN` | Separate random bearer shared with Hermes as `HERMES_PSTN_TOKEN`. |
| `VOBIZ_BRIDGE_RELAY_TOKEN` | Separate random bearer shared with the bridge as `VOBIZ_RELAY_TOKEN`. |
| `VOBIZ_BRIDGE_SECRET` | Random HMAC key shared with the bridge for short-lived WebSocket tokens. |
| `VOBIZ_AUTH_ID`, `VOBIZ_AUTH_TOKEN` | Vobiz account credentials from its console. |
| `VOBIZ_NUMBER` | Owned Vobiz caller ID in E.164 form. |
| `VOBIZ_PUBLIC_BASE_URL` | Exact deployed Worker HTTPS origin, with no path or trailing query. |
| `VOBIZ_BRIDGE_WSS_URL` | Public WSS bridge endpoint including its `/vobiz` path. |
| `VOBIZ_ALLOWED_DESTINATIONS` | Comma-separated canonical `+91` numbers permitted for outbound calls. For the pilot, set only the user's own self-test number. |
| `VOBIZ_OUTBOUND_ENABLED` | Set to `false` first. Set to `true` only for the controlled outbound pilot. |

The bridge should set `VOBIZ_RELAY_URL` to this Worker's public origin. Hermes should set `HERMES_PSTN_RELAY_URL` to the same origin. Their bearer tokens are distinct. No inbound number linkage is needed for outbound calls.

The short-lived WebSocket token contains only the Worker call ID, direction, and expiry. The bridge must compare the Vobiz `start.callId` with the `vobiz_call_id` in the authenticated context, call `/claim` once, and fail closed if Codex cannot start. The Worker does not send the call brief or account secrets in the stream URL.

## Local validation

`npm run check` runs generated binding checks, TypeScript, Worker tests, and a dry-run bundle. The test runner overrides its compatibility date to match the latest `@cloudflare/vitest-pool-workers` runtime while production uses the current compatibility date from `wrangler.jsonc`.
