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
        5. Run `scripts/update.py --check-only` after installation. If the signed release is marked as
           a capability, permission, or tool-scope expansion, stop at `approval_required`, show me the
           signed release notes, and use `--approve-capability-update` only after I explicitly approve.

        Latest Caller capabilities
        - Message or audio calls support `--message`, optional `--at`, optional `--caller-name`,
          optional `--audio-file` / `--audio-content-type`, and a stable required
          `--idempotency-key` sent as the `Idempotency-Key` header.
        - Live Grok calls use `--live` with structured `--reason`, `--relevant-context`,
          `--desired-outcome`, and `--urgency` fields. Preserve the active `HERMES_SESSION_ID`;
          never invent, summarize, print, or expose it.
        - Grok receives fresh voice instructions from Caller when the user answers and can consult the
          signed originating Hermes session through Remote MCP `ask_hermes`. The tool acknowledges
          `queued` immediately; Caller then inserts later statuses and the terminal result into the
          active Grok conversation automatically. Use `check_hermes_task` only for a user-requested
          status check or a reported event-delivery failure.
        - Approval requests appear in the Caller app so the user can explicitly approve or deny
          consequential Hermes actions.
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
        - Give this agent one tool that places an urgent incoming CallKit call on my iPhone.
        - Ordinary reminders stay in chat. Call only when I explicitly request it or an urgency policy
          I explicitly approved fires.

        Architecture
        - Your VPS owns agent policy, optional scheduling, retries, and optional audio storage.
        - Caller's managed relay owns the Apple APNs credential and final VoIP push delivery.
        - You do not need the Caller source code, an Apple Team ID, an APNs Key ID, a PushKit token,
          or a `.p8` file. Never ask me for those.
        - Do not deploy a second APNs backend and do not attempt to send APNs directly.

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
        - Never replace this with an unattended pull from a mutable Git branch or instructions copied
          from a website.

        Managed updates
        - Use the existing Hermes scheduler or one supervised local timer to run
          `scripts/update.py` once per day, preferably with jitter.
        - Compatible instruction/client fixes may install automatically. Capability, permission, or
          tool-scope expansions must stop with `approval_required`; show me the signed release notes
          and use `--approve-capability-update` only after I explicitly approve.

        Skill behavior
        - Message/audio calls accept `--message`, optional `--at`, optional `--caller-name`, optional
          `--audio-file` / `--audio-content-type`, and a stable required `--idempotency-key`.
          Send that value as the `Idempotency-Key` header so retries cannot duplicate calls.
        - Live Grok calls also require `--live`, `--reason`, `--relevant-context`,
          `--desired-outcome`, and `--urgency`. Preserve the active `HERMES_SESSION_ID`; never invent,
          summarize, print, or expose it.
        - Put only the minimum opening context in the structured briefing. Grok receives fresh voice
          instructions from Caller when the user answers and can consult the signed Hermes session
          with `ask_hermes` for deeper context.
        - A scheduled timestamp must be ISO-8601 with `Z` or an explicit timezone offset. Keep the
          fallback message between 1 and 500 characters and put the urgent fact first.
        - Audio is limited to 5 MB and expires after one hour; upload scheduled audio near due time.

        VPS behavior
        - Immediate calls can go directly through the skill client.
        - If reliable local scheduling is needed, use the agent's existing scheduler or install one
          supervised single-process service with persistent SQLite state on this VPS. Do not create a
          new cloud server merely for Caller.
        - For scheduled audio, run the upload client near the due time instead of uploading the file
          far in advance.
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
