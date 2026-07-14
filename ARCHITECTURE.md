# Caller architecture

## Trust split

```text
User-owned Hermes VPS                   Developer-owned Caller relay
---------------------                  ----------------------------
agent policy                           APNs Team ID / Key ID / .p8
optional scheduling       HTTPS        PushKit device-token mapping
optional audio storage  ----------->   scoped authorization + rate limit
urgent-caller skill                   APNs VoIP delivery
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

The relay stores hashes of installation and agent credentials, not their plaintext values.

## Call flow

1. Hermes invokes the `urgent-caller` skill with a message, optional time, and stable idempotency key.
2. For recorded speech, the skill uploads the bounded audio bytes to `POST /v1/audio` and receives an opaque, expiring `audio_id`.
3. The skill sends an authenticated `POST /v1/calls` to the relay with the text fallback and optional `audio_id`.
4. The relay resolves the scoped installation, persists the call, and returns its ID.
5. When due, the worker sends a VoIP push containing only call metadata and the opaque audio ID to that installation's current PushKit token.
6. iOS wakes Caller. The PushKit delegate immediately reports the call through CallKit.
7. On answer, Caller downloads audio using its installation credential and plays it through the CallKit audio session. Download or decoding failures fall back to on-device text-to-speech.

## Relay API

- `GET /health`: non-secret service and APNs readiness.
- `POST /v1/installations`: create an app installation and pairing code.
- `PUT /v1/installations/:id/device`: refresh a token using the installation secret.
- `POST /v1/installations/:id/pairing-code`: rotate the one-time code.
- `POST /v1/pairings/claim`: exchange a code for an installation-scoped agent token.
- `POST /v1/audio`: upload a bounded, short-lived audio attachment using the agent token.
- `GET /v1/installations/:id/audio/:audio-id`: download owned audio using the installation secret.
- `POST /v1/calls`: create a call using `Authorization: Bearer <agent-token>` and `Idempotency-Key`.
- `GET /v1/calls/:id`: inspect a call owned by the authenticated installation.

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

## Audio and live conversation

The MVP supports both on-device text-to-speech and short-lived uploaded speech files. The APNs payload carries only an opaque ID, never the audio bytes. A production relay should move encrypted attachments to object storage with lifecycle deletion. A live agent call should use the VoIP push only to ring; after answer, the app joins a WebRTC session controlled by the user-owned agent service.
