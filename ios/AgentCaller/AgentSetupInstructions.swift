import Foundation

enum AgentSetupInstructions {
    static let bootstrapSHA256 = "f062650d388d7a8c78cdd09b6e8951264241c1a6160102b691beadb7e2d6d572"

    static func updateText(relayURL: String) -> String {
        """
        Update the existing Caller integration on this agent to the latest signed capabilities.

        Important
        - This agent is already paired. Do not pair again, request a new pairing code, or call the
          pairing-claim endpoint.
        - Preserve the existing `CALLER_RELAY_URL` and `CALLER_AGENT_TOKEN` in the supervised Hermes
          environment. Never print, paste, rotate, or expose the token in chat or logs.
        - The expected relay is `\(relayURL)`. If the stored relay differs, stop and ask me before
          changing anything.
        - Do not ask for Apple credentials and do not deploy a second APNs backend.
        - This copied update request explicitly approves the signed outbound voice-connector
          capability described below. It does not authorize displaying or copying credentials.

        Install or update the signed managed skill
        1. Require Python 3 and OpenSSL. Locate the existing Hermes environment file and the current
           `urgent-caller` skill directory without overwriting unrelated skills or services.
        2. Download `\(relayURL)/v1/agent-package/urgent-caller/bootstrap.py` to a temporary file.
        3. Compute its SHA-256 and require this exact value before running it:
           `\(bootstrapSHA256)`. Stop if it differs.
        4. Run the verified bootstrap with the existing environment file and the existing explicit
           `urgent-caller` skill destination. It authenticates with the stored agent token, verifies
           the signed Ed25519 manifest and every file digest, self-tests the staged scripts, activates
           the update atomically, and retains the previous version outside the discoverable skills
           tree under `.caller-skill-rollbacks/skills/urgent-caller` for rollback.
        5. The 0.5.x outbound voice-connector capability is explicitly approved by this copied request,
           so pass `--approve-capability-update` for that signed release. For any different future
           capability, permission, or tool-scope expansion, stop and show me the signed release notes.
           Run `scripts/update.py --check-only` after installation.

        Latest Caller capabilities
        - Message notifications support `--message`, optional `--at`, optional `--caller-name`, and a stable required
          `--idempotency-key` sent as the `Idempotency-Key` header.
        - Live voice calls use `--live` with structured `--reason`, `--relevant-context`,
          `--desired-outcome`, and `--urgency` fields. Preserve the active `HERMES_SESSION_ID`;
          never invent, summarize, print, or expose it.
        - The selected voice provider receives fresh instructions when the user answers and can consult the
          signed originating Hermes session through Remote MCP `ask_hermes`. The tool acknowledges
          `queued` immediately; Caller then inserts later statuses and the terminal result into the
          active Grok conversation automatically. Use `check_hermes_task` only for a user-requested
          status check or a reported event-delivery failure.
        - Approval requests appear in the Caller app so the user can explicitly approve or deny
          consequential Hermes actions.
        - Run `scripts/voice_connector.py diagnose`. Reuse Hermes's existing `openai-codex`
          credential pool or `XAI_API_KEY`; never ask me to enter provider credentials into Caller.
          If neither is ready, guide me through Hermes's own Codex login or xAI configuration.
        - Run `scripts/voice_connector.py install`, verify `caller-voice-connector.service` is active,
          then rerun the relay live-voice diagnostic. Do not expose a public local broker port.
        - Ordinary reminders stay in chat. Place a call only when I explicitly request it or an
          urgency policy I explicitly approved fires. Never infer urgency merely from an overdue task.

        Keep it current
        - Use the existing Hermes scheduler or one supervised local timer to run
          `scripts/update.py` once per day, preferably with jitter.
        - Compatible instruction/client fixes may install automatically. Capability, permission, or
          tool-scope expansions always require my explicit approval.
        - Do not replace this process with an unattended pull from a mutable Git branch or instructions
          copied from a website.

        Report back
        - Report the installed skill version, manifest signing-key fingerprint, installation path,
          daily update mechanism, and whether a capability approval is pending. Redact all credentials.
        - Run a harmless client validation, but do not place a test call without my permission.
        """
    }

    static func familyText(relayURL: String, pairingCode: String?) -> String {
        let pairingStep: String
        if let pairingCode {
            pairingStep = """
            Pair this family phone as a named profile now (the one-time code expires soon):
            CALLER_RELAY_URL=\(relayURL)
            CALLER_PAIRING_CODE=\(pairingCode)

            Run `scripts/pair.py --relay-url "$CALLER_RELAY_URL" --code "$CALLER_PAIRING_CODE" \\
            --profile <profile>` from the installed `urgent-caller` skill. It stores the scoped
            credential in `~/.hermes/caller-profiles/<profile>.env` with mode 600. Never print or
            expose the code or the stored token, and do not overwrite my own default pairing.
            """
        } else {
            pairingStep = """
            This iPhone does not have a pairing code yet. Ask me to open Caller on the family
            member's phone, connect it to the managed relay, and copy these instructions again.
            """
        }

        return """
        Set up Caller for a family member on my existing Hermes agent.

        Context
        - I am your primary user and my own phone is already (or separately) paired with Caller.
        - This copied request comes from a DIFFERENT iPhone that belongs to a family member
          (for example a parent). It should become an additional named calling profile on this
          same Hermes host, not a replacement for my own pairing.
        - The expected relay is `\(relayURL)`. If my stored `CALLER_RELAY_URL` differs, stop and
          ask me before changing anything.
        - This copied request explicitly approves the signed multi-installation profile capability
          (skill release 0.5.19 or newer). It does not authorize displaying or copying credentials.

        Prerequisites
        - The signed `urgent-caller` skill must already be installed from my own setup. If it is
          missing, first complete my own setup flow: download
          `\(relayURL)/v1/agent-package/urgent-caller/bootstrap.py`, require SHA-256
          `\(bootstrapSHA256)`, and run the verified bootstrap.
        - If the installed skill is older than 0.5.19, run `scripts/update.py` with
          `--approve-capability-update`; this request is that approval. Verify the signed release
          notes mention multi-installation profiles before approving anything else.

        Ask me before pairing
        1. Whose phone is this? Record the name and relationship (for example "my mother").
        2. Agree on a short lowercase profile name with me (for example `mom` or `dad`).
        3. Which language is this person most comfortable speaking on the phone?
        4. Do I want a recurring daily check-in call? If yes: at what local time, which questions
           (medication, meals, wellbeing are the defaults), and any medication names to ask about.

        \(pairingStep)

        Enable live voice for this profile
        - Run `scripts/voice_connector.py install --profile <profile>` and verify
          `caller-voice-connector-<profile>.service` is active. It reuses the same Hermes-owned
          provider credentials as my own connector; never ask for new provider credentials.

        Verify, then hand over
        - With my permission, place exactly one test call with `scripts/call.py --profile <profile>`
          while I am with the family member so they can answer it and recognize the caller name.
        - If I approved a daily check-in, schedule it with the existing Hermes scheduler following
          the "Recurring family check-in call" section of the skill: one live call per day, a
          date-scoped idempotency key, a summary reported back through `ask_hermes`, one retry
          after 20 minutes if unanswered, then tell me instead of calling again.
        - Forward every check-in summary to me on my normal chat channel and append it to
          `~/.hermes/caller-checkins/<profile>.jsonl`.
        - Never place calls to this family member outside the approved schedule unless I
          explicitly ask, and share their summaries only with me.

        Report back
        - Report the profile name, installation pairing result, connector service status, the
          scheduled check-in time if any, and the installed skill version. Redact all credentials.
        """
    }

    static func text(relayURL: String, pairingCode: String?) -> String {
        let pairingStep: String
        if let pairingCode {
            pairingStep = """
            Pair this installation now:
            CALLER_RELAY_URL=\(relayURL)
            CALLER_PAIRING_CODE=\(pairingCode)

            Exchange the one-time code with `POST $CALLER_RELAY_URL/v1/pairings/claim` using JSON
            `{\"pairing_code\":\"$CALLER_PAIRING_CODE\"}`. Store the returned `agent_token` as
            `CALLER_AGENT_TOKEN` in the supervised Hermes environment with mode 600. The code expires
            and can be used only once. Never repeat either credential in normal chat or logs.
            """
        } else {
            pairingStep = """
            This iPhone does not have a pairing code yet. Ask me to open Caller, connect it to the
            managed relay, and copy these instructions again. Do not ask for Apple credentials.
            """
        }

        return """
        Set up Caller on this Hermes or OpenClaw server.

        Goal
        - Give this agent one tool that sends notifications and can start urgent live AI calls on my iPhone.
        - Ordinary reminders stay in chat. Call only when I explicitly request it or an urgency policy
          I explicitly approved fires.
        - This setup request explicitly approves the signed outbound voice-connector capability
          described below. It does not authorize displaying or copying any provider credential.

        Architecture
        - Your VPS owns agent policy, optional scheduling, and retries.
        - Caller's managed relay owns ordinary APNs notification delivery and PushKit delivery for live calls.
        - You do not need the Caller source code, an Apple Team ID, an APNs Key ID, a PushKit token,
          or a `.p8` file. Never ask me for those.
        - Do not deploy a second APNs backend and do not attempt to send APNs directly.
        - Caller itself has no provider login screen. Reuse credentials already owned by Hermes:
          prefer its `openai-codex` credential pool, otherwise use its `XAI_API_KEY`.
        - Permanent Codex OAuth tokens and xAI keys stay on this Hermes host. The outbound connector
          may return only a Codex SDP answer or a short-lived xAI client secret through the relay.

        \(pairingStep)

        Install the signed managed skill
        - Require Python 3 and OpenSSL. Determine the normal Hermes home and skill directory without
          overwriting unrelated skills or services.
        - Download `\(relayURL)/v1/agent-package/urgent-caller/bootstrap.py` to a temporary file.
        - Before running it, compute its SHA-256 and require this exact value:
          `\(bootstrapSHA256)`. Stop if it differs.
        - Run the verified bootstrap with the stored Hermes environment file and an explicit skill
          destination ending in `/urgent-caller`. It authenticates to the relay, verifies the signed
          Ed25519 release manifest and every file digest, self-tests the staged scripts, activates the
          skill atomically, and retains the previous version outside the discoverable skills tree
          under `.caller-skill-rollbacks/skills/urgent-caller` for rollback.
        - This copied setup request is explicit approval for the manifest's outbound voice-connector
          capability; pass `--approve-capability-update` when the signed 0.5.x release requires it.
        - Never replace this with an unattended pull from a mutable Git branch or instructions copied
          from a website.

        Configure live voice
        - Run `scripts/voice_connector.py diagnose` without printing credentials.
        - If the Hermes `openai-codex` pool is usable, use it. The connector supplies its current
          access token to local `codex app-server` with experimental `chatgptAuthTokens` and answers
          refresh requests through Hermes's own credential-pool refresh lock. Do not run `codex login`
          merely for Caller and do not copy `~/.codex/auth.json`.
        - If Codex is unavailable but Hermes has `XAI_API_KEY`, use it locally to mint short-lived xAI
          Realtime client secrets. An `xai-oauth` login is not a substitute for an xAI developer key.
        - If neither provider is usable, ask me to authenticate through Hermes's normal Codex login
          or xAI setup. Never ask me to paste a key or OAuth token into Caller.
        - Ensure the official `codex` executable is available for Codex voice, then run
          `scripts/voice_connector.py install`. Verify the supervised
          `caller-voice-connector.service` and the relay diagnostic. The connector initiates the
          WebSocket outbound; do not expose an inbound port or public Codex broker.

        Managed updates
        - Use the existing Hermes scheduler or one supervised local timer to run
          `scripts/update.py` once per day, preferably with jitter.
        - Compatible instruction/client fixes may install automatically. Capability, permission, or
          tool-scope expansions must stop with `approval_required`; show me the signed release notes
          and use `--approve-capability-update` only after I explicitly approve.

        Skill behavior
        - Message notifications accept `--message`, optional `--at`, optional `--caller-name`, and a stable required `--idempotency-key`.
          Send that value as the `Idempotency-Key` header so retries cannot duplicate calls.
        - Live voice calls also require `--live`, `--reason`, `--relevant-context`,
          `--desired-outcome`, and `--urgency`. Preserve the active `HERMES_SESSION_ID`; never invent,
          summarize, print, or expose it.
        - Put only the minimum opening context in the structured briefing. The voice model receives fresh
          instructions from Caller when the user answers and can consult the signed Hermes session
          with `ask_hermes` for deeper context.
        - A scheduled timestamp must be ISO-8601 with `Z` or an explicit timezone offset. Keep the
          fallback message between 1 and 500 characters and put the urgent fact first.

        VPS behavior
        - Immediate calls can go directly through the skill client.
        - If reliable local scheduling is needed, use the agent's existing scheduler or install one
          supervised single-process service with persistent SQLite state on this VPS. Do not create a
          new cloud server merely for Caller.
        - Use stable event-specific idempotency keys so retries never create duplicate calls.
        - For an immediate call, poll `GET $CALLER_RELAY_URL/v1/calls/:id` with the same bearer
          token for up to 15 seconds, until its status becomes `delivered` or `failed`. Do not stop
          at the initial `scheduled` response.
        - Treat `delivered` as APNs acceptance, not proof that the phone rang or I answered. If
          delivery fails, report `delivery_errors` and send the urgent fact through this chat.
        - Never infer urgency merely because a task is overdue.
        - Never include credentials, medical details, or other secrets in spoken text unless I
          explicitly request that content.

        Verification
        1. Verify the pairing claim succeeded and the scoped token was stored without printing it.
        2. Report the installed skill version, manifest signing-key fingerprint, installation path,
           and daily update mechanism; redact all credentials.
        3. Run `scripts/update.py --check-only` and a harmless client validation; do not place a call.
        4. Ask my permission before placing exactly one test call.
        5. Report the call ID and terminal relay status when available. If it is still scheduled,
           explicitly say delivery is pending. Never claim the phone rang or I answered without the
           corresponding relay event.
        """
    }
}
