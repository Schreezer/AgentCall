# Vobiz PSTN relay pilot

This is a separate Cloudflare Worker for Hermes-initiated outbound calls and a staged inbound answer path. The inbound path is disabled in `wrangler.jsonc`. This repository does not link the purchased DID to a Voice Application or configure Jio forwarding.

## Routes

| Route | Authentication | Purpose |
| --- | --- | --- |
| `GET /health` | Public | Confirms Worker and D1 are reachable. |
| `POST /v1/pstn-calls` | `Bearer HERMES_PSTN_TOKEN` | Place one call with `Idempotency-Key: <UUID>` and JSON `{ "to": "+91...", "briefing": "...", "opening_speech": "Hi, this is an AI assistant..." }`. `opening_speech` is optional. |
| `GET /v1/pstn-calls/{id}` | `Bearer HERMES_PSTN_TOKEN` | Read status and any available summary. |
| `GET /v1/inbound-calls` | `Bearer HERMES_PSTN_TOKEN` | Read the 20 most recent inbound calls and bounded summaries, newest first. No full transcript or detailed `inbound_report` is included. |
| `GET /v1/inbound-calls/{id}` | `Bearer HERMES_PSTN_TOKEN` | Read one inbound call, including a bounded, code-redacted `inbound_report` if the bridge supplied one. |
| `POST /v1/vobiz/{answer,ring,hangup}/{id}/{token}` | Per-call 256-bit callback token, plus Vobiz V2/V3 HMAC when present | Answer XML and provider call state. |
| `POST /v1/vobiz/inbound/answer` | Required Vobiz V2/V3 HMAC | Receive `Event=StartApp` from the Voice Application Answer URL. |
| `POST /v1/vobiz/inbound/hangup` | Required Vobiz V2/V3 HMAC | Receive `Event=Hangup` from the Voice Application Hangup URL. |
| `GET /v1/vobiz/bridge/calls/{id}` | `Bearer VOBIZ_BRIDGE_RELAY_TOKEN` | Give the media bridge its bounded call brief and Vobiz call UUID. |
| `POST /v1/vobiz/bridge/calls/{id}/claim` | `Bearer VOBIZ_BRIDGE_RELAY_TOKEN` | Atomically claim the call once before opening a Codex session. |
| `POST /v1/vobiz/bridge/calls/{id}/events` | `Bearer VOBIZ_BRIDGE_RELAY_TOKEN` | Report connected, ended, or failed; optionally include summary or bounded transcript. |
| `POST /v1/vobiz/bridge/notifications/claim` | `Bearer VOBIZ_BRIDGE_RELAY_TOKEN` | Claim one due Caller alert from the durable outbox. Returns `{ "notification": null }` when none is due. |
| `POST /v1/vobiz/bridge/notifications/{call-id}/ack` | `Bearer VOBIZ_BRIDGE_RELAY_TOKEN` | Mark an alert sent after the paired Caller relay accepted it. Repeated acknowledgements are safe. |
| `POST /v1/vobiz/bridge/notifications/{call-id}/reject` | `Bearer VOBIZ_BRIDGE_RELAY_TOKEN` | Quarantine a claimed alert after a permanent delivery failure. JSON `reason` is only `invalid_claim`, `caller_relay_rejected`, or `caller_relay_conflict`. Repeated rejection is safe. |

The Worker accepts canonical Indian `+91` destinations on the `VOBIZ_ALLOWED_DESTINATIONS` allowlist only. It checks the Codex bridge's `/health` for `codex_ready: true` before calling Vobiz, enforces a rolling 1000 ms gap before provider dispatch and three attempts per minute, and permits only one active call at a time. It uses a 30-second ringing limit and 3-minute call cap. It does not use an OpenAI API key or an alternate voice provider. Vobiz callback comparison accepts exact Indian 10-digit national numbers as well as `+91` numbers. A `queued` response means Vobiz accepted the request, not that the recipient answered. `dispatch_unknown` means the provider may have accepted a request that timed out; never redial that idempotency key automatically.

The optional opening speech is limited to 320 characters, strips extra horizontal or line whitespace, rejects control characters, and must explicitly say `AI` or `artificial intelligence`. Its normalized text is part of the idempotency hash and is passed to the bridge as `opening_speech`. Without it, the Worker uses a generic AI-disclosed greeting.

Vobiz's [Make Call API](https://www.vobiz.ai/docs/call/make-call) documents `answer_url`, `ring_url`, `hangup_url`, and `hangup_on_ring`. Its [callback validation guide](https://www.vobiz.ai/docs/concepts/validating-callbacks) says HMAC headers may be absent unless callback URL credentials are configured. Every URL therefore also carries a unique random token whose hash is stored in D1. When V2/V3 signature headers are present, the Worker validates them and rejects invalid ones. It requires the stored Vobiz `CallUUID` and compares caller ID and destination when Vobiz supplies them.

Automatic Cloudflare observability logs and traces are disabled for the pilot because callback URLs contain per-call tokens. Nonce records store only a hash of the callback path. Application error logging omits the request URL and bridge failure details.

Ring and Hangup callbacks return HTTP 200 as [Vobiz requires](https://www.vobiz.ai/docs/concepts/callbacks). Hangup uses documented `CallStatus` and `HangupCause`, plus whether the call reached the answer or bridge stage. It preserves a recorded bridge failure even if Hangup arrives afterward. If the bridge becomes unavailable at answer time, the Worker records a failed call and returns `<Hangup/>` with HTTP 200. Turning `VOBIZ_OUTBOUND_ENABLED` off blocks new calls while existing callbacks and bridge status reports continue.

## Inbound staging

The inbound Answer and Hangup URLs are fixed Voice Application URLs. Unlike outbound callbacks, they have no per-call URL token, so the Worker **requires** a valid Vobiz V2 or V3 HMAC signature and a 20-digit nonce. It validates `auth_id`, `Direction=inbound`, `CallUUID`, `Event`, and `To` matching the owned `VOBIZ_NUMBER`. It rejects an unsigned callback, an altered form body reusing a nonce, or a callback for another DID. Exact retries of the same signed URL and body are idempotent. Signed inbound nonces are retained in D1 because Vobiz signs the URL and nonce, not the form body. See [Vobiz callback validation](https://www.vobiz.ai/docs/concepts/validating-callbacks) and [callback events](https://www.vobiz.ai/docs/concepts/callbacks).

With `VOBIZ_INBOUND_ENABLED=false`, a valid signed Answer returns HTTP 200 with `<Hangup/>`; Hangup returns HTTP 200. The Worker records one minimal `blocked_disabled` row per Vobiz `CallUUID` with no caller number, report, bridge token, or Codex session. This lets an owner check whether Vobiz actually sends signed callbacks before any AI answers a real call. Read it through the authenticated inbound list/status routes. The public `/health` confirms Worker and D1 only; it does not mean the inbound agent is enabled.

With `VOBIZ_INBOUND_ENABLED=true`, Answer checks the bridge's `/health` within 1.2 seconds and requires both `codex_ready:true` and `inbound_enabled:true`. Only then does it create one inbound record and return a bidirectional `<Stream>` to the bridge, with a short-lived, signed, direction-scoped token. The bridge must match `start.callId` to the stored Vobiz UUID and atomically claim the call; repeated Answer callbacks do not create a second record or second claim. This personal pilot allows one active call across inbound and outbound routes. A second inbound caller receives `<Hangup/>` and a `failed`/`another_call_active` record; a concurrent outbound request gets HTTP 409. If the bridge is unavailable, the Worker records `failed` and returns `<Hangup/>`. `From` may be absent, withheld, foreign, or spoofed. `caller_number` is unverified metadata, and `source_type` remains `unknown`; this path cannot tell whether the caller dialed the DID or reached it by carrier forwarding.

The bridge uses a fixed inbound message-taking policy and an AI-disclosed greeting. The Worker stores only a bounded report and summary from the bridge, not the full transcript. Before storage, it removes controls and bidirectional formatting and redacts code and phone-like digit sequences, including separated and non-ASCII digits. `completed` means the phone/media lifecycle ended after the bridge connected; it does not prove a caller left a message or acknowledged anything. Public status fields `delivery_status` and `acknowledgement_status` therefore remain `unknown` unless supported by separate evidence. A Hangup before bridge media connects is recorded as `failed`.

A completed inbound bridge event also inserts one durable, idempotent outbox item. If the saved report quotes caller speech, its alert begins `Caller said (unverified):` and contains at most 180 Unicode characters total. The Worker removes controls, bidirectional formatting, and digits, and never reads the call summary, caller number, Hermes context, or a transcript to build the alert. If there is no captured caller message, it stores the existing generic alert. The alert is a short excerpt of unverified caller speech, not a verified account of why the person called. The first terminal event freezes the saved report and alert; later event retries cannot change them.

The bridge claims due items and sends that stored alert to the already paired Caller relay using `vobiz-inbound-{call-id}` as the relay idempotency key. It acknowledges the outbox only after the relay accepts or queues the request. A crash after send and before acknowledgement may resend the request, but the stable key and unchanged message let Caller return the existing call instead of scheduling a duplicate. Existing pending rows keep the generic alert during an upgrade for the same reason. Transient delivery failure remains `pending` and becomes due again after 30 seconds. For an invalid claim or permanent Caller relay 400/409/422 response, the bridge can reject the claimed alert with a fixed reason code; the Worker quarantines it so later alerts can proceed. A quarantined alert is retained for investigation and is not retried automatically. `owner_notification_status` on authenticated inbound list/detail responses is `pending`, `sent`, `failed`, or `null`; `failed` means quarantined and `sent` means the Caller relay accepted the alert, not that APNs or the iPhone displayed it. Without paired Caller credentials the bridge does not claim items, so they remain pending.

This pilot has no automatic record deletion. Inbound caller metadata and bounded reports remain in D1 until deliberately removed; signed inbound nonce hashes are retained to prevent replay of old URL signatures. Decide a retention and export policy before sustained use.

The later activation sequence is: apply `0002_inbound.sql`, `0003_caller_notification_outbox.sql`, `0004_notification_message.sql`, and `0005_notification_quarantine.sql` to the dedicated D1 database; deploy this Worker with inbound still false; make the Codex bridge healthy with its inbound flag; create a [Vobiz Voice Application](https://www.vobiz.ai/docs/applications/create-application) with the exact Answer and Hangup URLs above and POST methods; configure Vobiz callback URL credentials so V2/V3 signatures are actually present; then attach the purchased DID only for a controlled signed-callback test. [Attaching a number](https://www.vobiz.ai/docs/applications/attach-number) immediately changes where its incoming calls go. Confirm a `blocked_disabled` row through `GET /v1/inbound-calls` before enabling the Worker flag and placing an inbound conversation test. Jio forwarding is a separate, later carrier setting.

## Configuration

Dedicated D1: `caller-vobiz-outbound` (`6a478995-5ebf-4d77-a7e5-3a7d700e4a91`, APAC). Run `npm run check`, then apply all pending migrations, including `0005_notification_quarantine.sql`, to that database before deploying. Keep all required values in Wrangler secrets, not source:

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
| `VOBIZ_INBOUND_ENABLED` | Public Wrangler var pinned to `false`. Change to `true` only after signed callback proof, healthy inbound bridge, and a controlled DID routing test. |

The bridge should set `VOBIZ_RELAY_URL` to this Worker's public origin. Hermes should set `HERMES_PSTN_RELAY_URL` to the same origin. Their bearer tokens are distinct. No inbound number linkage is needed for outbound calls.

The short-lived WebSocket token contains only the Worker call ID, direction, and expiry. The bridge must compare the Vobiz `start.callId` with the `vobiz_call_id` in the authenticated context, call `/claim` once, and fail closed if Codex cannot start. The Worker does not send the call brief or account secrets in the stream URL.

## Local validation

`npm run check` runs generated binding checks, TypeScript, Worker tests, and a dry-run bundle. The test runner overrides its compatibility date to match the latest `@cloudflare/vitest-pool-workers` runtime while production uses the current compatibility date from `wrangler.jsonc`.
