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

## Keep the skill current

Caller releases are retrieved from the paired relay, verified against the public Ed25519 key pinned in `scripts/update.py`, downloaded into a staging directory, self-tested, and atomically activated. Run this once per day using the existing Hermes scheduler or a supervised system timer:

```bash
python3 scripts/update.py
```

Compatible instruction and client fixes install automatically. If the signed manifest marks a release as capability-expanding or approval-required, the updater exits without changing the skill. Show the release notes to the user and rerun with `--approve-capability-update` only after explicit approval. Never replace this process with an automatic pull from a mutable Git branch or instructions scraped from a website. The previous verified installation is retained outside the discoverable skills tree under `.caller-skill-rollbacks/skills/urgent-caller` for rollback.

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

## Place a live Hermes conversation

Use live mode when the call requires a discussion, decision, or access to the originating Hermes session:

```bash
python3 scripts/call.py \
  --live \
  --message "Hermes needs your decision; live voice was unavailable." \
  --reason "The flight price changed and the hold expires soon." \
  --relevant-context "The direct option is INR 4,000 more than the one-stop option." \
  --desired-outcome "Ask which option Chirag wants Hermes to continue with." \
  --urgency important \
  --idempotency-key "flight-decision-2026-08-02"
```

Hermes supplies `HERMES_SESSION_ID` to the skill process; never invent, summarize, or expose it. The relay stores the full briefing but sends only the short `--message`, call ID, caller name, and mode through PushKit. After answer, Grok speaks the briefing and may call `ask_hermes`, which acknowledges `queued` immediately. Caller then delivers later status transitions and the terminal result into the active Grok conversation automatically, even when Hermes takes longer than the original tool call. `check_hermes_task` is only for a user-requested status check or reported event-delivery failure. Grok owns the wording; do not script a forced reply.

The message remains a deliberately short fallback if live bootstrap or xAI audio fails. The four structured briefing fields are mandatory. Put only the minimum facts necessary for the opening conversation in them; Grok can ask Hermes for deeper context through the signed originating session.

## Judgment rules

- Do not infer urgency merely because a task is overdue.
- Keep spoken messages under 500 characters and put the key fact first.
- Do not include passwords, tokens, medical details, or other sensitive content in text or audio unless the user explicitly requested it.
- Ask permission before the first test call.
- For an immediate call, poll `GET /v1/calls/:id` for up to 15 seconds until the status is `delivered` or `failed`; do not report only the initial `scheduled` response.
- `delivered` means APNs accepted the VoIP push. Report the call ID, scheduled time, and terminal relay status, but do not claim the phone rang or the user answered.
- A live voice model cannot approve Hermes actions. When Hermes pauses for approval, the user must choose in Caller's separately authenticated approval inbox.
- If a call result reports `skill_update` as `required` or `available`, run the signed updater. Do not ignore a required update.
- If the call remains `scheduled`, say delivery is still pending. If it becomes `failed`, include the relay's delivery error and use the current chat channel for the urgent message.
- If the relay fails, use the current chat channel and state that the call could not be scheduled.

For user-owned scheduling, use the existing Hermes scheduler or a supervised local process with persistent state. Do not deploy another APNs sender; the managed relay is the only component authorized to wake the App Store build.
