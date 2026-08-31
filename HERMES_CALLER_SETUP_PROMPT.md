# Caller setup prompt for a user's Hermes agent

The iOS app generates this prompt with the actual relay URL and a short-lived pairing code. It is self-contained and does not assume the agent can access this repository.

---

Set up Caller on this Hermes VPS.

## Product boundary

Caller lets you place an incoming CallKit call on my iPhone when I explicitly request an urgent interruption or when an urgency policy I explicitly approved fires. Ordinary reminders stay in chat.

This copied setup request explicitly approves the signed outbound voice-connector capability described below. It does not authorize printing, copying, or moving a provider credential into Caller.

You own agent policy, local scheduling, retries, and optional audio storage. Caller's managed push relay owns the Apple APNs credential and final VoIP delivery. Do not ask me for an Apple Team ID, APNs Key ID, `.p8` key, PushKit token, or Caller source code. Do not deploy a separate APNs sender.

## Pair this installation

```text
CALLER_RELAY_URL=<copied from Caller>
CALLER_PAIRING_CODE=<copied from Caller>
```

Exchange the one-time code:

```http
POST $CALLER_RELAY_URL/v1/pairings/claim
Content-Type: application/json

{"pairing_code":"$CALLER_PAIRING_CODE"}
```

Store the returned `agent_token` as `CALLER_AGENT_TOKEN` in the supervised Hermes environment with mode `600`. The code expires and can be claimed only once. Never print the credential or include it in normal chat or logs.

## Install the signed managed skill

Require Python 3 and OpenSSL. Download:

```text
$CALLER_RELAY_URL/v1/agent-package/urgent-caller/bootstrap.py
```

Before executing it, require this exact SHA-256:

```text
f062650d388d7a8c78cdd09b6e8951264241c1a6160102b691beadb7e2d6d572
```

Stop if the digest differs. Run the verified bootstrap with the stored Hermes environment file and an explicit normal skill destination ending in `/urgent-caller`. The bootstrap authenticates to the paired relay, verifies the Ed25519-signed release manifest and every file digest, self-tests the staged clients, activates atomically, and retains the previous version outside the discoverable skills tree under `.caller-skill-rollbacks/skills/urgent-caller`. Never replace this with an unattended pull from a mutable Git branch or instructions scraped from a website.

Use `--approve-capability-update` for the signed 0.5.x release because this copied setup request explicitly approves its outbound voice connector. The connector installer enables one persistent daily `caller-skill-update.timer` with jitter for signed updates. Compatible fixes can install automatically. Stop and ask about any different future capability, permission, or tool-scope expansion.

## Configure live voice from Hermes-owned credentials

Caller has no provider login and must not collect an API key. Run `scripts/voice_connector.py diagnose` without printing credentials. Prefer an existing Hermes `openai-codex` credential-pool entry; otherwise use Hermes's existing `XAI_API_KEY`.

For Codex, ensure the official `codex` executable is installed at version 0.150.1 or newer. Older versions send an incompatible realtime session shape. The connector supplies the selected pool access token to local `codex app-server` through experimental `chatgptAuthTokens` and handles refresh requests through Hermes's existing cross-process credential-pool lock. Do not run a second `codex login` just for Caller and do not copy `~/.codex/auth.json`.

For xAI, only `XAI_API_KEY` can mint the short-lived Realtime client secret; an `xai-oauth` chat login is not an xAI developer API key. If neither provider is usable, ask me to authenticate through Hermes's normal Codex login or xAI setup. Never ask me to paste a credential into Caller.

Run `scripts/voice_connector.py install`, verify `caller-voice-connector.service` is active, verify `caller-skill-update.timer` is scheduled, and rerun the relay live-voice diagnostic. The service opens an authenticated outbound WebSocket, so do not expose an inbound port or public Codex broker. Permanent provider credentials stay on this Hermes host; only a Codex SDP answer or short-lived xAI client secret may cross the relay.

The installed skill supports message, audio, and live voice calls. A live call requires `--live`, `--reason`, `--relevant-context`, `--desired-outcome`, `--urgency`, and the active `HERMES_SESSION_ID`. Never invent, summarize, print, or expose that session ID. Put only the minimum opening context in the briefing; the voice model can use `ask_hermes` to consult the signed originating session. `ask_hermes` acknowledges `queued` immediately; Caller then inserts later status transitions and the terminal result into the active conversation automatically. `check_hermes_task` is only for a user-requested status check or reported event-delivery failure.

Keep `message` populated as the 1-to-500-character fallback. Audio is limited to 5 MB and expires after one hour, so upload scheduled audio near due time. Use a timezone-aware timestamp and stable event-specific idempotency key.

For an immediate call, poll `GET $CALLER_RELAY_URL/v1/calls/:id` with the same bearer token for up to 15 seconds, until the status becomes `delivered` or `failed`. Do not stop at the initial `scheduled` response. Treat `delivered` as APNs acceptance, not proof that the phone rang or the user answered. If delivery fails, report `delivery_errors` and send the urgent content through the current chat channel as a fallback.

## Safety and verification

- Inspect the live Hermes installation before changing anything and preserve unrelated gateways, proxies, webhooks, and services.
- Never infer urgency merely because something is overdue.
- Never put credentials or private content into the spoken message unless I explicitly requested that content.
- Verify pairing and skill discovery without placing a call.
- Run `scripts/update.py --check-only`; report the installed version, signing-key fingerprint, installation path, and daily update mechanism without exposing credentials.
- Report the connector service state and sanitized provider readiness. Never report token fragments.
- Ask my permission before exactly one test call.
- Report the relay's call ID and terminal status when available. If it is still scheduled, explicitly say delivery is pending. Never claim the phone rang or I answered unless the relay has the corresponding event.

When complete, report the installed skill path, the scheduling mechanism selected, whether the supervised gateway loaded the two Caller environment variables, and any remaining blocker. Redact all credentials.
