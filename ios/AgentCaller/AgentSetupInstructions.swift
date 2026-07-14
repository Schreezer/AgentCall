import Foundation

enum AgentSetupInstructions {
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

        Install the skill
        - Create an agentskills-compatible skill named `urgent-caller` in the normal skills directory
          for this agent, such as `$HERMES_HOME/skills/urgent-caller`.
        - Provide a small Python standard-library client accepting `--message`, optional `--at`,
          optional `--caller-name`, optional `--audio-file` / `--audio-content-type`, and required
          `--idempotency-key`.
        - For `--audio-file`, upload the raw bytes to `POST $CALLER_RELAY_URL/v1/audio` using the
          agent bearer token, detected audio MIME type, a stable upload idempotency key, and an
          `X-Audio-Filename` header. Put the returned `audio_id` in the call JSON.
        - It must send `POST $CALLER_RELAY_URL/v1/calls` with
          `Authorization: Bearer $CALLER_AGENT_TOKEN`, JSON content, and an `Idempotency-Key` header.
        - A scheduled timestamp must be ISO-8601 with `Z` or an explicit timezone offset.
        - Keep spoken text between 1 and 500 characters and put the urgent fact first.
        - Keep `message` populated as the text-to-speech fallback when attaching audio. Audio is
          limited to 5 MB by default and expires from the relay after one hour.

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
        2. Make a harmless authenticated validation request or prepare the client; do not place a call.
        3. Report where the skill was installed and whether local scheduling is configured.
        4. Ask my permission before placing exactly one test call.
        5. Report the call ID and terminal relay status when available. If it is still scheduled,
           explicitly say delivery is pending. Never claim the phone rang or I answered without the
           corresponding relay event.
        """
    }
}
