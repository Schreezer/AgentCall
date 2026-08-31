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

## Pair an additional phone (family profiles)

One Hermes host can pair more than one Caller installation, for example a parent's iPhone for a daily check-in. Each phone runs its own copy of the Caller app and produces its own one-time pairing code. Store an additional pairing under a named profile instead of the default environment:

```bash
python3 scripts/pair.py \
  --relay-url "https://push.caller.example" \
  --code "ABCD-EFGH" \
  --profile mom
```

Before pairing, ask the user whose phone this is (name and relationship), what language that person is most comfortable speaking, and pick a short lowercase profile name together (for example `mom` or `dad`). Profile credentials are stored in `~/.hermes/caller-profiles/<profile>.env` with mode 600; never print them. Then install a per-profile voice connector so live calls to that phone can start:

```bash
python3 scripts/voice_connector.py install --profile mom
```

This creates `caller-voice-connector-<profile>.service` alongside the default connector; both share the same Hermes-owned provider credentials. Pass `--profile <name>` to `call.py` to place a call to that phone. Without `--profile`, every command keeps addressing the user's own phone. Ask the user's permission, then place one test call to the new profile and have the family member answer it before scheduling anything recurring.

## Enable live voice from Hermes credentials

Caller does not collect an xAI key or a Codex login. After pairing and installing the signed skill, inspect the local provider state without printing credentials:

```bash
python3 scripts/voice_connector.py diagnose
```

The connector prefers an available `openai-codex` credential-pool entry, then falls back to Hermes's `XAI_API_KEY`. A Codex entry is supplied to the official local `codex app-server` through experimental `chatgptAuthTokens`; refresh stays behind Hermes's existing cross-process credential-pool lock. An xAI API key is used locally only to mint a short-lived Realtime client secret. The permanent Codex token, refresh token, and xAI API key never go to Caller, its Worker, or the iPhone.

If neither provider is ready, ask the user to authenticate through Hermes: use Hermes's normal `openai-codex` login flow or configure `XAI_API_KEY`. Do not ask the user to paste either credential into Caller. Codex voice requires the official `codex` executable at version 0.150.1 or newer; older versions send an incompatible realtime session shape. Set `CALLER_CODEX_COMMAND` only when its trusted installed path is not discoverable as `codex`.

Once diagnosis reports a provider, install the supervised outbound connector:

```bash
python3 scripts/voice_connector.py install
```

It opens an authenticated outbound WebSocket to the installation-scoped Worker rendezvous, so no inbound port, public broker, or copied provider secret is required. The installer also enables `caller-skill-update.timer`, a persistent daily signed-update check with randomized delay. Verify `caller-voice-connector.service` is active, verify the timer is scheduled, and rerun the live-voice diagnostic. The Worker may see only provider readiness; during a call it receives a Codex SDP answer or an xAI ephemeral token, never permanent provider credentials.

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
  --opening-question "Which option do you want Hermes to continue with?" \
  --idempotency-key "flight-decision-2026-08-02"
```

Hermes supplies `HERMES_SESSION_ID` to the skill process; never invent, summarize, or expose it. The relay stores the full briefing but sends only the short `--message`, call ID, caller name, and mode through PushKit. Hermes writes one concise `--opening-question` from the immediate goal. After pickup, Caller sends it through the live provider's speech channel, so Sol speaks it; Caller never substitutes device TTS. The live model can then converse normally and may call `ask_hermes`, which acknowledges `queued` immediately. Caller delivers later status transitions and the terminal result into the active conversation automatically, even when Hermes takes longer than the original tool call. `check_hermes_task` is only for a user-requested status check or reported event-delivery failure.

The message remains a deliberately short fallback if live bootstrap fails. The five structured briefing fields are mandatory. Put only the minimum facts necessary for the opening conversation in them; the voice model can ask Hermes for deeper context through the signed originating session.

## Recurring family check-in call

A user-approved daily check-in with a family member is the one recurring call this skill supports. Set it up only after the user explicitly approves the schedule, the daily time, and the questions, and after the family member has answered a successful test call. Use the existing Hermes scheduler to run one live call per day against that person's profile:

```bash
python3 scripts/call.py \
  --profile mom \
  --live \
  --caller-name "Chirag's Assistant" \
  --message "Hi, this is your son's assistant calling for the daily check-in." \
  --reason "The user asked for a short daily check-in call with this family member." \
  --relevant-context "You are speaking with the user's mother. Be warm, unhurried, and simple; speak the language she is most comfortable with, switching if she does. Ask at most three things: whether she took her medication today, what she has eaten, and how she is feeling. Keep the call under three minutes. Before saying goodbye, send a 3-4 sentence summary of her answers and anything she complained about to Hermes using ask_hermes." \
  --desired-outcome "A short summary of medication, meals, and wellbeing reported back through ask_hermes before the call ends." \
  --urgency normal \
  --opening-question "Namaste! Chirag asked me to check in - how are you feeling today?" \
  --idempotency-key "checkin-mom-2026-08-31"
```

Check-in rules:

- Use a date-scoped idempotency key (`checkin-<profile>-<YYYY-MM-DD>`) so a retried scheduler task cannot ring twice.
- Adapt the briefing to what the user configured for this person: their name, language, medication list, and preferred questions. Never invent medical details.
- When the summary arrives through `ask_hermes`, append one JSON line to `~/.hermes/caller-checkins/<profile>.jsonl` with the date, whether the call was answered, and the summary, then forward the summary to the user on their normal chat channel.
- If no summary has arrived 20 minutes after the call was delivered, place exactly one retry with `-retry` appended to the idempotency key. If the retry also produces nothing, tell the user the check-in went unanswered instead of calling again.
- On request, produce a weekly digest from the stored summaries: missed days, recurring complaints, and anything mentioned repeatedly.
- Share summaries only with the user. Never include health details in any other output, and never place additional calls to a family member beyond the approved schedule unless the user explicitly asks.

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
