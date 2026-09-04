# Caller architecture

## Trust split

```text
User-owned Hermes VPS                   Developer-owned Caller relay
---------------------                  ----------------------------
agent policy                           APNs Team ID / Key ID / .p8
optional scheduling       HTTPS        PushKit device-token mapping
notification scheduling ----------->  scoped authorization + rate limit
urgent-caller skill                   APNs alert + live-only VoIP delivery
```

An App Store build is signed by the Caller developer team. End users cannot safely send APNs pushes for that bundle from their own VPS, so the developer relay is the smallest unavoidable shared component. It contains no agent runtime.

## Pairing

1. Caller obtains a PushKit token.
2. Caller sends it to `POST /v1/installations` and receives an installation secret plus a short-lived pairing code.
3. The installation secret is stored in the iOS Keychain and is used only to refresh the device token or generate a new pairing code.
4. The app copies a self-contained setup prompt containing the relay URL and pairing code.
5. Hermes claims the code through `POST /v1/pairings/claim`.
6. The relay consumes the code and returns a random agent token scoped to that installation.
7. Hermes stores `CALLER_RELAY_URL` and `CALLER_AGENT_TOKEN` in its supervised environment.
8. The signed skill verifies Hermes's existing Codex pool and xAI key, then starts one supervised outbound connector. Caller does not receive a provider login or API key.

The relay stores hashes of installation and agent credentials, not their plaintext values.

## Call flow

1. Hermes invokes the `urgent-caller` skill with a message, optional time, and stable idempotency key.
2. The skill sends an authenticated `POST /v1/calls` request to the relay.
3. The relay resolves the scoped installation, persists the request, and returns its ID.
4. For a one-way message, the worker sends a standard APNs alert to the installation's notification token.
5. For `live_voice`, the worker sends a VoIP push to the PushKit token. iOS immediately reports that genuine two-way call through CallKit.

## Relay API

- `GET /health`: non-secret service and APNs readiness.
- `POST /v1/installations`: create an app installation and pairing code.
- `PUT /v1/installations/:id/device`: refresh a token using the installation secret.
- `POST /v1/installations/:id/pairing-code`: rotate the one-time code.
- `POST /v1/pairings/claim`: exchange a code for an installation-scoped agent token.
- `POST /v1/calls`: create a call using `Authorization: Bearer <agent-token>` and `Idempotency-Key`.
- `GET /v1/calls/:id`: inspect a call owned by the authenticated installation.
- `GET /v1/agent-connect`: authenticated WebSocket rendezvous for the paired Hermes voice connector.
- `POST /v1/agent-diagnostics/live-voice`: sanitized connector/provider readiness; never token material.

## Security properties

- Pairing codes expire, are single-use, and are rate-limited.
- Agent and installation tokens contain 256 bits of entropy and are hashed at rest.
- Call idempotency is scoped per installation.
- APNs delivery is routed only to the authenticated installation.
- The APNs key remains exclusively in developer infrastructure.
- Audio is installation-scoped, size/type-limited, non-cacheable, and automatically expires.
- iOS installation credentials are stored in Keychain.
- Relay responses use `Cache-Control: no-store`.

Before production, add database transactions, audited credential rotation/revocation, App Attest, per-installation quotas, encrypted call content, APNs invalid-token cleanup, and explicit call-event callbacks.

## Cloudflare deployment

The production-oriented relay target lives in `cloudflare/`:

```text
iPhone / agent
      |
      v
Cloudflare Worker API
      |---- D1: installations, credentials, calls, idempotency
      |---- Durable Object alarm: scheduled delivery and expiry cleanup
      `---- APNs HTTP/2 endpoint: alert or live-only VoIP push
```

Each installation has its own serialized Durable Object scheduler, avoiding a global delivery bottleneck. Calls remain authoritative in D1; each alarm queries and conditionally claims due rows for its installation before sending, so at-least-once alarm execution cannot send the same row twice. D1 unique constraints enforce installation-scoped call and audio idempotency.

R2 lifecycle rules do not provide exact one-hour deletion. Each audio row therefore carries an authoritative `expires_at`: downloads fail closed after that instant, and the scheduler deletes both the R2 object and D1 metadata.

The Worker creates APNs provider tokens with Web Crypto and sends through `fetch()`. The existing Node relay uses an explicit `node:http2` connection; Workers expose `node:http2` only as a non-functional compatibility stub. A real sandbox VoIP delivery from the deployed Worker is therefore a required release gate before switching the app's production relay URL.

## Live conversation

One-way messages use standard APNs alerts. A live call uses the VoIP push only to initiate a bidirectional voice session.

For live voice, the answered iOS call always creates a WebRTC offer and posts it through the authenticated installation bootstrap. The Worker creates a call-scoped Hermes tool token and asks that installation's `VoiceConnector` Durable Object to start a session. The Durable Object forwards the request through the outbound WebSocket already opened by the paired Hermes host.

For Codex, the connector selects Hermes's `openai-codex` pool entry and supplies its access token and account ID directly to the official local `codex app-server` using experimental `chatgptAuthTokens`. When app-server requests a refresh, the connector forces refresh of that same pool entry through Hermes's cross-process lock. It starts an ephemeral read-only V3 audio thread and returns only the SDP answer. The Worker and iPhone never receive the permanent OAuth access token or refresh token.

For xAI, the connector uses Hermes's local `XAI_API_KEY` to mint a short-lived Realtime client secret and returns only that ephemeral value. Audio then travels directly between iOS and xAI. If both providers are available, Codex is preferred unless the Worker explicitly requests xAI. `LIVE_VOICE_BACKEND=legacy` preserves the older Worker-managed xAI/public broker path as an explicit rollback; it is not an automatic credential fallback.
