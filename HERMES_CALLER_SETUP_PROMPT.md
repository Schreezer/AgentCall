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

## Install the skill

Create an agentskills-compatible `urgent-caller` skill under the normal Hermes skills directory. Add a small client accepting:

- required `--message` between 1 and 500 characters;
- optional timezone-aware `--at`;
- optional `--caller-name`;
- required stable, event-specific `--idempotency-key`.

The client sends:

```http
POST $CALLER_RELAY_URL/v1/calls
Authorization: Bearer $CALLER_AGENT_TOKEN
Content-Type: application/json
Idempotency-Key: <stable-event-key>

{
  "caller_name":"Hermes",
  "message":"The urgent fact to speak",
  "scheduled_at":"2026-07-12T05:50:00+05:30"
}
```

Omit `scheduled_at` for an immediate call. For reliable user-owned scheduling, prefer the existing Hermes scheduler or one supervised local service with persistent SQLite state on this VPS. Do not create another cloud server merely for Caller.

For an immediate call, poll `GET $CALLER_RELAY_URL/v1/calls/:id` with the same bearer token for up to 15 seconds, until the status becomes `delivered` or `failed`. Do not stop at the initial `scheduled` response. Treat `delivered` as APNs acceptance, not proof that the phone rang or the user answered. If delivery fails, report `delivery_errors` and send the urgent content through the current chat channel as a fallback.

## Safety and verification

- Inspect the live Hermes installation before changing anything and preserve unrelated gateways, proxies, webhooks, and services.
- Never infer urgency merely because something is overdue.
- Never put credentials or private content into the spoken message unless I explicitly requested that content.
- Verify pairing and skill discovery without placing a call.
- Ask my permission before exactly one test call.
- Report the relay's call ID and terminal status when available. If it is still scheduled, explicitly say delivery is pending. Never claim the phone rang or I answered unless the relay has the corresponding event.

When complete, report the installed skill path, the scheduling mechanism selected, whether the supervised gateway loaded the two Caller environment variables, and any remaining blocker. Redact all credentials.
