# Caller setup prompt for a user's Hermes agent

The iOS app generates this prompt with the actual relay URL and a short-lived pairing code. It is self-contained and does not assume the agent can access this repository.

---

Set up Caller on this Hermes VPS.

## Product boundary

Caller lets you place an incoming CallKit call on my iPhone when I explicitly request an urgent interruption or when an urgency policy I explicitly approved fires. Ordinary reminders stay in chat.

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

Use the existing Hermes scheduler or one supervised local timer to run `scripts/update.py` daily, preferably with jitter. Compatible instruction/client fixes can install automatically. If a signed release expands capabilities, permissions, or tool scope, the updater must stop with `approval_required`; show the signed release notes and use `--approve-capability-update` only after explicit user approval.

The installed skill supports message, audio, and live Grok calls. A live call requires `--live`, `--reason`, `--relevant-context`, `--desired-outcome`, `--urgency`, and the active `HERMES_SESSION_ID`. Never invent, summarize, print, or expose that session ID. Put only the minimum opening context in the briefing; Grok receives fresh voice instructions after answer and can use `ask_hermes` to consult the signed originating session. `ask_hermes` acknowledges `queued` immediately; Caller then inserts later status transitions and the terminal result into the active Grok conversation automatically, even when Hermes takes longer than the tool call. `check_hermes_task` is only for a user-requested status check or reported event-delivery failure.

Keep `message` populated as the 1-to-500-character fallback. Audio is limited to 5 MB and expires after one hour, so upload scheduled audio near due time. Use a timezone-aware timestamp and stable event-specific idempotency key.

For an immediate call, poll `GET $CALLER_RELAY_URL/v1/calls/:id` with the same bearer token for up to 15 seconds, until the status becomes `delivered` or `failed`. Do not stop at the initial `scheduled` response. Treat `delivered` as APNs acceptance, not proof that the phone rang or the user answered. If delivery fails, report `delivery_errors` and send the urgent content through the current chat channel as a fallback.

## Safety and verification

- Inspect the live Hermes installation before changing anything and preserve unrelated gateways, proxies, webhooks, and services.
- Never infer urgency merely because something is overdue.
- Never put credentials or private content into the spoken message unless I explicitly requested that content.
- Verify pairing and skill discovery without placing a call.
- Run `scripts/update.py --check-only`; report the installed version, signing-key fingerprint, installation path, and daily update mechanism without exposing credentials.
- Ask my permission before exactly one test call.
- Report the relay's call ID and terminal status when available. If it is still scheduled, explicitly say delivery is pending. Never claim the phone rang or I answered unless the relay has the corresponding event.

When complete, report the installed skill path, the scheduling mechanism selected, whether the supervised gateway loaded the two Caller environment variables, and any remaining blocker. Redact all credentials.
