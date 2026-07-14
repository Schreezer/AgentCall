---
name: urgent-caller
description: Place or schedule a real incoming voice call when the user explicitly requests an urgent interruption or an approved urgency policy fires. Prefer chat for ordinary reminders.
---

# Urgent Caller

Caller uses a developer-managed Apple push relay. Never request an Apple Team ID, APNs Key ID, `.p8` key, or PushKit device token from the user. Those stay inside the Caller developer infrastructure.

## Pair once

The Caller iOS app supplies a relay URL and short-lived, one-time pairing code. Run:

```bash
python3 scripts/pair.py \
  --relay-url "https://push.caller.example" \
  --code "ABCD-EFGH"
```

The script exchanges the code for a credential scoped to one Caller installation and stores `CALLER_RELAY_URL` and `CALLER_AGENT_TOKEN` in the Hermes environment file with mode 600. Never print or include the token in conversational output. Restart only the supervised gateway that needs the new environment.

## Place or schedule a call

```bash
python3 scripts/call.py \
  --message "The message to speak after the user answers" \
  --audio-file "/path/to/speech.m4a" \
  --at "2026-07-12T05:50:00+05:30" \
  --idempotency-key "stable-event-identifier"
```

`--audio-file` is optional; `--message` remains required as the text-to-speech fallback. The client uploads supported audio to the relay, then attaches the returned opaque ID to the call. Omit `--at` to call immediately. Always include a timezone offset in scheduled timestamps. Use a stable event-specific idempotency key so retries cannot create duplicate calls.

Audio is limited to 5 MB by default and expires from the relay after one hour. For a later scheduled audio call, schedule the client itself to run near the due time instead of uploading the file far in advance.

## Judgment rules

- Do not infer urgency merely because a task is overdue.
- Keep spoken messages under 500 characters and put the key fact first.
- Do not include passwords, tokens, medical details, or other sensitive content in text or audio unless the user explicitly requested it.
- Ask permission before the first test call.
- For an immediate call, poll `GET /v1/calls/:id` for up to 15 seconds until the status is `delivered` or `failed`; do not report only the initial `scheduled` response.
- `delivered` means APNs accepted the VoIP push. Report the call ID, scheduled time, and terminal relay status, but do not claim the phone rang or the user answered.
- If the call remains `scheduled`, say delivery is still pending. If it becomes `failed`, include the relay's delivery error and use the current chat channel for the urgent message.
- If the relay fails, use the current chat channel and state that the call could not be scheduled.

For user-owned scheduling, use the existing Hermes scheduler or a supervised local process with persistent state. Do not deploy another APNs sender; the managed relay is the only component authorized to wake the App Store build.
