# Caller Remote MCP to Hermes Implementation Plan

**Status:** Implemented, independently approved, deployed, and MCP-verified; user-heard voice acceptance remains

**Repository:** `/Users/chirag13/development/caller`

**Related runtime:** Hermes Agent on `OpenClaw-usw2`, listening privately on `127.0.0.1:8642`
**Architecture decision:** xAI Grok Speech-to-Speech uses a server-side Remote MCP tool hosted by the existing Caller Cloudflare Worker. There is no separate AWS voice-bridge application. Independent security review proved that current Hermes lacks a per-request tool-policy boundary, so production enablement requires one narrow, upstreamable Hermes API extension for a server-validated request toolset allowlist; no voice logic or bridge service is added to Hermes.

## 1. Outcome

When Hermes places a live call, the iPhone rings through the existing Caller/APNs path. After the user answers:

1. The iPhone streams microphone audio directly to xAI Grok Speech-to-Speech.
2. The iPhone plays Grok's returned audio.
3. The phone configures Grok with an authenticated Remote MCP server URL, but it does not execute Hermes tools itself.
4. When Grok decides Hermes is needed, xAI calls the Caller Worker MCP server directly.
5. The Worker invokes the existing authenticated Hermes API through a private Cloudflare Workers VPC binding.
6. Hermes retains its memory, skills, tools, and persisted sessions. Human approvals stay outside Grok's server-side MCP authority.
7. The MCP result returns to Grok, and Grok decides what should be spoken. No bridge-authored or forced speech is used.
8. Hermes validates each voice-originated run against a configured server-side safe toolset allowlist; Cloudflare cannot widen it.

The completed topology is:

```text
                                  Remote MCP over HTTPS
                         +-----------------------------------+
                         |                                   v
iPhone <-- direct audio --> xAI Grok Voice           Caller Cloudflare Worker
  |                                                       /mcp
  | CallKit/APNs + authenticated bootstrap                  |
  +---------------- Caller Cloudflare Worker                | Workers VPC binding
                                                           v
                                             Cloudflare Tunnel (outbound only)
                                                           |
                                                           v
                                              Hermes API on 127.0.0.1:8642
```

## 2. Locked Decisions

### 2.1 The phone is the ears and mouth

The iOS app owns only:

- CallKit and PushKit lifecycle.
- The direct xAI realtime WebSocket.
- Microphone capture and PCM playback.
- Voice interruption and audio-session behavior.
- Fetching a short-lived bootstrap document and placing its MCP configuration into `session.update`.

The phone does not:

- Execute `ask_hermes` locally.
- Hold the Hermes API key or permanent xAI key.
- Poll Hermes or interpret Hermes run events.
- Decide what the assistant should say after Hermes responds.

### 2.2 The MCP server is for Grok, not for Hermes

Installing an MCP server into Hermes would give Hermes more tools. That is the wrong direction.

The new MCP server is hosted at the Caller Worker and presented to Grok. The first production version exposes only a narrow, read/status-oriented Hermes facade to xAI:

- `ask_hermes`
- `check_hermes_task`

`answer_hermes_approval` is deliberately not an MCP tool. A server-side voice model possessing the MCP token is not proof that the human approved an action. Any Hermes approval must cross a separately authenticated iOS confirmation boundary. `cancel_hermes_task` is also deferred until the chosen Hermes execution path can prove cancellation rather than merely canceling a Cloudflare monitor.

Internally, those tools use the deliberately extended and capability-probed Hermes HTTP API contract described below; no voice transport or MCP server is installed inside Hermes.

### 2.3 There is no AWS bridge application

AWS continues to run the existing Hermes agent. The only added server-side process is `cloudflared`, installed as an outbound-only tunnel connector. There is no new Python bridge, SQLite bridge database, public Hermes port, reverse proxy, or application service on AWS. The sole Hermes change is request-scoped toolset restriction inside its existing API server, because prompts and Cloudflare filtering cannot prevent an internal Hermes tool invocation.

### 2.4 Grok owns speech

MCP tool results contain operational truth and structured status. Grok decides what is useful to say based on the live conversation. The integration never uses `force_message`, bridge-written speech, or a separate summarizer LLM.

### 2.5 Session IDs only in v1

No friendly names or aliases are introduced. Grok may address:

- The active Hermes lineage for the call.
- A new Hermes lineage.
- A specific raw Hermes session ID supplied in a previous result.

Hermes compression may rotate the raw session ID. The Worker resolves and returns the current canonical ID after each completed operation. A Grok-supplied session ID is accepted only if it is the call's signed origin ID or an ID the installation coordinator previously created or resolved; arbitrary Hermes IDs are never forwarded.

### 2.6 The live Hermes contract is narrower than its capability advertisement

The currently running AWS process advertises run submission, polling, approval, and stop, but the deployed checkout does not yet contain the newer durable run store or persisted continuation behavior. The local Hermes checkout already contains an isolated, tested durable-run implementation in progress. V1 production enablement requires finishing and deploying that existing work plus the request-toolset restriction below, then proving capabilities `run_durable`, `run_idempotent_create`, `run_restart_recovery`, `run_session_continuation`, `run_tool_receipts`, and `run_request_toolset_allowlist` from the live process.

Cloudflare then submits `/v1/runs` with a stable operation ID/idempotency key, the exact allowed session ID, and `continue_session: true`. Hermes—not Cloudflare—loads its native conversation representation, including tool-call/result context. The run route is selected over synchronous session chat because it also exposes approval, stop, durable status, replayable events, restart fencing, and reconciliation state. Exactly-once side effects are still not claimed: an interrupted unreceipted tool intent becomes `needs_reconciliation`/`outcome_unknown` rather than being blindly replayed.

### 2.7 Tool safety is enforced inside Hermes

Add an optional `enabled_toolsets` field to Hermes API run requests. Hermes validates every requested name, intersects it with the toolsets already enabled for `api_server`, and also requires membership in an operator-owned `gateway.api_server.request_toolset_allowlist`. Unknown, unavailable, or policy-disallowed entries fail closed with HTTP 400; omission preserves all existing clients unchanged. The effective list is passed to `AIAgent(enabled_toolsets=...)` and returned as sanitized run metadata for audit.

The initial voice allowlist contains only toolsets audited as non-consequential, such as public web/X search, vision analysis, session search, and clarification. Mixed read/write toolsets such as `file`, `skills`, `memory`, `browser`, `terminal`, `cronjob`, Home Assistant, communications, and arbitrary MCP servers are excluded until split or individually proven to have an approval gate. Delegation is allowed only if children inherit the same restricted toolsets and the live probe confirms that invariant. This server-owned allowlist is the production safety boundary; prompts are only behavioral guidance.

## 3. Why the Design Is Supported

- xAI Speech-to-Speech supports Remote MCP tools in `session.update` and performs those tool calls server-side.
- xAI Remote MCP supports Streamable HTTP or SSE, bearer authorization, custom headers, descriptions, and `allowed_tools`.
- Cloudflare Workers can host a stateless Streamable HTTP MCP server.
- Hermes already exposes authenticated session, run, event, approval, and stop endpoints.
- Workers VPC can route a Worker binding through Cloudflare Tunnel to a private service without publishing the origin.

Primary references:

- <https://docs.x.ai/developers/model-capabilities/audio/speech-to-speech>
- <https://docs.x.ai/developers/tools/remote-mcp>
- <https://developers.cloudflare.com/agents/model-context-protocol/guides/remote-mcp-server/>
- <https://developers.cloudflare.com/workers-vpc/>
- <https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server>

## 4. Complete Runtime Sequence

### 4.1 Hermes creates the call

The existing `urgent-caller` integration gains a live mode:

```json
{
  "mode": "live_voice",
  "caller_name": "Hermes",
  "message": "Short non-sensitive fallback reason",
  "call_context": {
    "reason": "Why Hermes is calling now",
    "relevant_context": "The facts needed for the discussion",
    "desired_outcome": "The decision, answer, or action Hermes needs",
    "urgency": "normal | important | urgent"
  },
  "origin_hermes_session_id": "value automatically read from HERMES_SESSION_ID"
}
```

`message` remains required because the current one-way TTS/audio path is the safe fallback when live bootstrap fails. The full briefing and origin session ID never enter APNs.

### 4.2 Cloudflare stores and delivers the call

The Worker:

1. Validates the live-call fields and size limits.
2. Hashes the full request into the existing call idempotency record so the same key cannot silently replay different context.
3. Stores the full briefing and origin session ID in D1.
4. Sends APNs with only `call_id`, `mode`, `caller_name`, short `message`, and optional audio ID.

Approval notifications use standard APNs remote notifications, never PushKit/VoIP. The content-minimal payload contains only `event: "hermes_approval_required"`, `call_id`, `operation_id`, and a stable notification ID. Commands, arguments, context, choices, and session IDs never enter APNs. PushKit remains exclusively for events that immediately report a real CallKit call, including actual follow-up calls.

### 4.3 The phone answers and bootstraps

After CallKit answer, the app calls:

```text
POST /v1/installations/{installation_id}/calls/{call_id}/voice-bootstrap
Authorization: Bearer <installation secret>
```

The Worker verifies:

- Installation and call ownership.
- `mode == live_voice`.
- The call is recent enough to answer.
- Rate limits and revocation state.
- The call has not already been bootstrapped incompatibly.

It returns:

```json
{
  "call_id": "...",
  "voice_session_id": "...",
  "xai": {
    "model": "grok-voice-latest",
    "ephemeral_token": "xai-client-secret...",
    "expires_at": "..."
  },
  "session": {
    "instructions": "stable voice policy plus a delimited call briefing",
    "voice": "eve",
    "turn_detection": {
      "type": "server_vad"
    },
    "tools": [
      {
        "type": "mcp",
        "server_url": "https://agentcall-relay.chiragmgg.workers.dev/mcp",
        "server_label": "hermes",
        "server_description": "Consult and operate Chirag's personal Hermes agent.",
        "allowed_tools": [
          "ask_hermes",
          "check_hermes_task"
        ],
        "authorization": "Bearer <short-lived call-scoped MCP token>"
      }
    ]
  }
}
```

The permanent xAI API key never leaves Worker secrets. The MCP token is stored hashed and is scoped to one installation, call, voice session, and that call's operations.

### 4.4 Grok starts the conversation

The app opens the direct xAI WebSocket using the ephemeral token and sends `session.update` with the returned session configuration.

The briefing is inserted as delimited untrusted data beneath stable governing instructions. After xAI acknowledges the session update, the app requests the first response. Grok is instructed to:

- State why Hermes called and the relevant context before requesting a decision.
- Speak naturally and concisely.
- Use Hermes when personal memory, tools, skills, files, external systems, or careful execution are needed.
- Never read raw JSON or session IDs unless the user asks.
- Decide what to say after every MCP result.
- Never claim success unless Hermes confirms it.

### 4.5 xAI invokes Hermes through Remote MCP

When Grok selects `ask_hermes`, xAI—not the phone—performs the MCP `tools/call` request against the Worker using the call-scoped Authorization header.

The MCP handler:

1. Validates the hashed call token and expiry.
2. Resolves the call's installation and active Hermes lineage.
3. Validates the tool arguments.
4. Enqueues the operation on the installation coordinator.
5. Starts the durable Hermes Workflow.
6. Returns a structured `queued` acknowledgement immediately.

That initial result is automatically incorporated by xAI's voice agent. Each later user-facing status transition is also appended to `hermes_operation_events`. While the call remains active, the installation-authenticated iOS client reads only its own voice session's cursor-based feed and inserts each event into xAI with `conversation.item.create`. Nonterminal events update conversation context without forcing speech. A terminal result requests a new Grok response only after the current response has ended and the user is not speaking. Grok therefore receives a two-minute result just as automatically as a two-second result and does not need to poll Hermes itself.

### 4.6 Hangup

Ending the call:

- Stops the microphone, player, and xAI WebSocket.
- Calls the Worker revoke endpoint for that voice session.
- Prevents new MCP operations under the call token.
- Does not pretend that closing the socket cancels an already accepted Hermes turn.
- Keeps durable completion state associated with the installation.
- If a background operation finishes after the voice session ends, schedules an authenticated follow-up Caller/APNs call containing only a short fallback summary and a reference to the completed operation.

## 5. Remote MCP Tool Contracts

### 5.1 `ask_hermes`

```json
{
  "request": "A complete standalone request for Hermes",
  "context_scope": "origin | independent",
  "independent_context": "required only for independent"
}
```

Rules:

- `request` must be non-empty, bounded, and standalone.
- `origin` uses only the signed session that placed the call and fails if none exists.
- `independent` creates an isolated Hermes context for an unrelated topic or task.
- Reusing one `independent_context` key continues only that independent task; another key creates another isolated context.
- Unknown arguments are rejected.
- The Worker never exposes, fabricates, or asks Grok or the user to choose Hermes session IDs.

Possible output:

```json
{
  "status": "answered | working | needs_external_approval | failed | outcome_unknown",
  "operation_id": "voiceop_...",
  "answer": "present when answered",
  "summary": "present when work continues",
  "completion_delivery": "caller_events",
  "user_action": "present when an authenticated non-MCP confirmation is required"
}
```

`ask_hermes` durably accepts the operation, starts one Workflow instance, and returns `queued` without waiting for Hermes. Caller owns later delivery through the call-scoped event feed. The initial MCP response and every later event refer to the same operation; no second Hermes turn is launched merely to improve latency.

### 5.2 `check_hermes_task`

```json
{
  "operation_id": "voiceop_..."
}
```

Only operation IDs explicitly granted to the current call token may be read. A later call receives individual pending/completed operation grants during bootstrap; it does not inherit access to every operation owned by the installation. The tool returns the same status envelope as `ask_hermes`, but Grok uses it only for a user-requested status check or a reported event-delivery failure.

### 5.3 Human approval boundary

Approvals are not exposed through Remote MCP. The `/v1/runs` monitor records the exact redacted pending approval and exact permitted choices. The app displays a native confirmation sheet and submits the selected choice to a separate installation-authenticated HTTPS endpoint; only the Worker can translate that into `POST /v1/runs/{run_id}/approval`. Grok may explain that confirmation is required, but cannot satisfy it.

When approval is detected, the coordinator writes an idempotent approval-notification outbox item. The scheduler sends the minimal event through the standard APNs alert/background channel using a separately registered device token and `apns-push-type: background` (or `alert` when the product opts into visible notification text). Silent delivery is best-effort, so the app also maintains and refreshes an authenticated in-app approval inbox. The app fetches redacted details and exact choices from `GET /v1/installations/{installation_id}/hermes-operations/{operation_id}/approval` using the installation secret, and submits one exact choice to the corresponding `POST` endpoint. Approval grants expire, duplicate events collapse by notification ID, denial is terminal, and post-hangup approval remains available only until its short expiry. The app never executes a choice directly from push data.

Before production enablement, P0 must submit a harmless command that Hermes classifies as approval-requiring and prove all three cases: the run pauses before execution, MCP cannot approve it, and only the authenticated iOS approval endpoint resumes or denies it. If that probe fails, live `ask_hermes` stays disabled rather than relying on prompt wording.

### 5.4 Cancellation boundary

V1 can cancel a queued operation before Hermes accepts it and can request `/v1/runs/{run_id}/stop` after acceptance. After the durable-run prerequisite is deployed, restart recovery resumes only safely fenced work; any Hermes `needs_reconciliation` or missing terminal proof becomes `outcome_unknown`. The UI and Grok must not claim cancellation or failure without a terminal Hermes status.

## 6. Hermes API Mapping

The Worker uses only supported Hermes endpoints through `env.HERMES_PRIVATE.fetch(...)`:

| Purpose | Hermes endpoint |
| --- | --- |
| Read capabilities | `GET /v1/capabilities` |
| Create a session | `POST /api/sessions` |
| Resolve current canonical session | `GET /api/sessions/{id}/messages` |
| Submit/replay one durable continued run | `POST /v1/runs` |
| Poll run and approval state | `GET /v1/runs/{run_id}` |
| Read replayable run events | `GET /v1/runs/{run_id}/events` |
| Resolve a human-approved choice | `POST /v1/runs/{run_id}/approval` |
| Request stop | `POST /v1/runs/{run_id}/stop` |

Every path component is URL-encoded, every request includes Hermes's `API_SERVER_KEY` from a Worker secret, and the API remains bound to loopback on AWS. Before each submission the Worker resolves the exact allowed session and sends `session_id`, `continue_session: true`, `client_operation_id`, and the server-approved `enabled_toolsets`. Hermes loads its own lossless conversation representation. The Worker never reconstructs tool history from the public message shape.

## 7. Session and Concurrency Semantics

### 7.1 Durable Object authority

Use one `HermesInstallationCoordinator` Durable Object per Caller installation. It is authoritative for:

- All allowed Hermes lineages and their current canonical raw session IDs.
- Prior raw IDs mapped to each lineage.
- The call-scoped capability grants for individual lineages and operations.
- Per-lineage ordered queues and active queue heads.
- Operation lifecycle transitions and follow-up-call outbox entries.

Different lineages may run concurrently. Caller-originated operations within one lineage are submitted in order. This is not a global Hermes lock: Telegram, Desktop, background wakes, and other Hermes clients can still write the same session concurrently. Global serialization would require a future lock inside Hermes.

### 7.2 Canonicalization

For `active` and `continue`:

1. Resolve the supplied/current ID before submission through `/messages`.
2. Enqueue against the logical lineage, not merely the current string.
3. Resolve again after terminal completion.
4. Atomically update the coordinator's lineage mapping and active pointer if Hermes compression rotated the ID.
5. Return the post-run canonical ID to Grok.

### 7.3 Fresh-session crash safety

For `new`:

1. Generate and persist the raw Hermes ID in the coordinator before calling `POST /api/sessions`.
2. Ownership means this high-entropy ID was durably reserved by this installation coordinator before any Hermes call; Hermes itself does not assert Caller ownership.
3. On `409`, recover only when that exact coordinator reservation already exists and the Hermes session resolves successfully.
4. Submit `/v1/runs` with the operation ID as `client_operation_id`/`Idempotency-Key` and `continue_session: true`.
5. A replay with the same operation and payload returns the same run; a changed payload conflicts. Hermes restart recovery may repeat model computation only when its durable tool-intent/receipt fence says that is safe. Any `needs_reconciliation` state becomes `outcome_unknown` for Caller and is never silently resubmitted.

### 7.4 Same-lineage ordering

The operation enters Durable Object storage before any Hermes submission. The next Caller-originated operation is not submitted until the head reaches a terminal or explicit `outcome_unknown` state and post-turn canonicalization completes.

### 7.5 Recoverable Workflow launch

Durable Object state and Workflow creation are not transactional. Acceptance therefore persists `workflow_pending` before returning and uses the operation ID as the deterministic Workflow instance ID. The coordinator attempts creation, then arms an alarm while any operation remains `workflow_pending`. The alarm reconciler retries Workflow creation; an “instance already exists” response is success. No Hermes request occurs before the Workflow marks itself attached to the authoritative operation.

### 7.6 MCP replay identity

For each `tools/call`, the MCP handler derives a replay key from the call scope, tool name, and MCP JSON-RPC request ID, and persists an argument hash before scheduling work. An exact replay returns the existing operation; the same key with different arguments is rejected. A staging probe records whether xAI preserves request IDs across HTTP retries. If xAI generates a new ID, duplicate semantic requests cannot be claimed as deduplicated; they remain distinct operations unless Grok supplies a previously returned `operation_id` to `check_hermes_task`.

## 8. Fast and Long Work

xAI publishes no guaranteed Remote MCP tool timeout. The production contract therefore does not depend on a guessed two-second window:

- `ask_hermes` durably creates one logical operation, schedules its deterministic Workflow, and returns `queued` immediately.
- The coordinator appends each status transition to a D1 event log keyed by installation, voice session, and monotonic cursor.
- The iOS call client reads that scoped feed and inserts status envelopes into the active xAI conversation. Terminal events request speech only when no response or user speech is active.
- Grok calls `check_hermes_task` only when the user asks for a status check or Caller reports that event delivery is unavailable.
- Accepted orchestration continues durably through a Cloudflare Workflow; the underlying Hermes turn has the restart and ambiguous-outcome limits stated above.
- A P0 characterization harness exposes authenticated 1/2/5/10/30-second no-op MCP probes in staging only. Those measurements tune, but never become, a correctness dependency.
- If completion occurs after hangup, the coordinator writes an outbox item and the existing scheduler creates a follow-up Caller/APNs call. The follow-up call is separately authenticated and bootstrapped with a grant for that exact operation ID.

An `HermesOperationWorkflow` handles:

- Resolving the exact coordinator-owned canonical session.
- One idempotent durable `/v1/runs` creation using the operation ID.
- Polling durable run state/events with bounded backoff and surfacing approval or reconciliation.
- Post-run canonicalization.
- Completion persistence.
- Follow-up-call outbox creation after hangup.

Ordinary `ctx.waitUntil()` is not used for long Hermes work because its post-response lifetime is bounded. Workflow steps contain only serializable data.

## 9. Detached Delegation Boundary

Detached Hermes delegation is explicitly outside v1 acceptance. The live API does not expose a reliable initiating-run-to-delegation identifier. V1 treats only the parent run's terminal response as the operation result. It does not monitor an independently detached child, claim that child finished, or hold the queue for an uncorrelated event. Adding detached completion later requires a real live probe and a supported correlation ID in Hermes's API.

## 10. Persistence Model

Add a versioned D1 migration with these logical entities.

### `installations` addition

- `alert_device_token` for standard APNs remote notifications, separate from the existing VoIP `device_token`

### `calls` additions

- `mode`
- `call_context_json`
- `origin_hermes_session_id`
- `request_hash`
- `answered_at`

### `voice_sessions`

- `id`
- `installation_id`
- `call_id`
- `xai_conversation_id`
- `mcp_token_hash`
- `active_lineage_id`
- `created_at`
- `expires_at`
- `revoked_at`

### `hermes_lineages` projection

- `id`
- `installation_id`
- `current_session_id`
- `bridge_created`
- timestamps

### `hermes_session_aliases` projection

- raw `session_id`
- `lineage_id`
- timestamps

This is an internal raw-ID rotation map, not a user-facing naming feature.

### `hermes_operations` projection

- `id`
- installation/call/voice-session ownership
- lineage and ordinal
- requested mode and supplied session ID
- pre-run and post-run canonical IDs
- MCP call-scope/JSON-RPC replay key and argument hash
- deterministic Workflow instance ID equal to operation ID
- `workflow_pending | queued | submitting | running | completed | failed | cancelled_before_start | needs_external_approval | outcome_unknown`
- structured result
- timestamps

### `hermes_operation_events`

- monotonic cursor
- operation, installation, and voice-session ownership
- one user-facing status transition and its structured result snapshot
- creation timestamp

This append-only table prevents the phone from missing fast transitions between polls. Its HTTPS reader requires the installation secret, verifies the exact active voice session, returns at most 100 ordered events after a cursor, and never exposes Hermes session IDs.

### `completion_outbox`

- stable event ID and sequence
- installation/call/operation ownership
- payload
- follow-up call ID, delivery attempts, and acknowledgement state

The installation coordinator, not D1, is authoritative for alias, queue, operation, grant, and completion transitions. D1 is an idempotent query projection/outbox; no transaction is claimed across Durable Object storage and D1. Follow-up delivery is durable at-least-once, and the existing call idempotency key is derived from the stable completion event ID. No exactly-once claim is made across Hermes, APNs, or xAI.

## 11. Authentication and Security

### 11.1 Credentials

Worker secrets:

- `XAI_API_KEY`
- `HERMES_API_KEY`
- Existing APNs credentials

The iPhone receives only:

- Its existing installation secret from Keychain.
- A short-lived xAI ephemeral token.
- A short-lived call-scoped MCP token.

### 11.2 MCP token scope

The MCP bearer token is bound to:

- One installation.
- One call.
- One voice session.
- The signed origin lineage plus lineages created by that voice session.
- Operations created under that voice session and exact prior operation IDs explicitly granted in its bootstrap.
- A short expiry.

The token is stored only as a cryptographic hash in D1. Authorization is checked on every MCP initialize, list, and call request. A fresh call token cannot enumerate or read all installation operations. Hangup revokes permission to create new operations; exact completion grants may remain valid only for the brief follow-up call that carried them, with expiry as the backstop.

### 11.3 Network boundary

- Hermes remains on `127.0.0.1:8642`.
- `cloudflared` establishes an outbound QUIC tunnel.
- A Workers VPC Service binding targets only `127.0.0.1:8642`, reducing SSRF scope and avoiding IPv6 localhost resolution where Hermes is not listening.
- The Worker invokes Hermes through the binding rather than a public URL.
- No API key, briefing, session ID, or MCP token is placed in APNs or logs.

## 12. Component and File Plan

### 12.1 Cloudflare Worker

Existing files to extend:

- `cloudflare/src/index.js`
- `cloudflare/src/core.js`
- `cloudflare/src/apns.js`
- `cloudflare/wrangler.jsonc`
- `cloudflare/package.json`
- `cloudflare/worker-configuration.d.ts` generated by Wrangler

New focused modules:

- `cloudflare/src/mcp.js` — Streamable HTTP MCP server and schemas.
- `cloudflare/src/hermes-client.js` — bounded private Hermes API client.
- `cloudflare/src/voice-bootstrap.js` — xAI token minting, briefing, and call-scope creation.
- `cloudflare/src/hermes-installation-coordinator.js` — installation-scoped authoritative Durable Object with per-lineage queues.
- `cloudflare/src/hermes-operation-workflow.js` — durable orchestration around one idempotently created Hermes run.
- `cloudflare/src/voice-store.js` — D1 persistence helpers and transactions.
- `cloudflare/migrations/0002_live_voice_mcp.sql`.

Tests:

- MCP initialize/list/call protocol tests.
- Token scope, expiry, ownership, revocation, and hash tests.
- Live-call validation and idempotency conflict tests.
- Hermes API fixtures for fresh/active/continue, rotation, ambiguous outcomes, and failures.
- Caller-channel FIFO, cross-lineage concurrency, strict session allowlist, and exact-operation grant tests.
- Workflow launch reconciliation, idempotent run replay/conflict, Hermes reconciliation state, completion projection, and follow-up call outbox tests.

Wrangler changes are explicit rather than implied:

- Add and export the `HermesInstallationCoordinator` SQLite Durable Object and a new migration tag.
- Add and export `HermesOperationWorkflow` with a Workflow binding.
- Add `HERMES_PRIVATE` under `vpc_services` using the created VPC Service ID.
- Add `agents`, the exact compatible `@modelcontextprotocol/server` v2 beta, and `zod`; implement `/mcp` with stateless `createMcpHandler()`.
- Regenerate `worker-configuration.d.ts` from the pinned Wrangler version after updating to the current release.

### 12.2 Narrow Hermes API safety/durability prerequisite

Finish and verify the existing uncommitted durable-run work in `/Users/chirag13/development/hermes-agent` without reverting or rewriting its current changes:

- `gateway/api_run_store.py`
- the existing focused additions in `gateway/platforms/api_server.py`
- `tests/gateway/test_api_run_store.py`
- `tests/gateway/test_api_server_durable_runs.py`

Add the smallest separate request-toolset patch and tests:

- Accept optional `enabled_toolsets` only on native session-chat/run endpoints that opt into the contract.
- Validate names, require they are already enabled for `api_server`, intersect with operator config `gateway.api_server.request_toolset_allowlist`, and reject any widening.
- Pass the exact validated list to `AIAgent`; preserve legacy behavior when omitted.
- Include the request toolset policy in the durable request fingerprint so an idempotency replay cannot widen authority.
- Advertise `run_request_toolset_allowlist` only when configured.
- Test unknown/disallowed/mixed toolsets, omission compatibility, durable replay conflict, child delegation inheritance, and zero-tool/read-only configurations.

This is a prerequisite in the existing Hermes API process, not a voice bridge. It must be committed and deployed independently so rollback is straightforward.

### 12.3 Hermes caller add-on

Modify:

- `integrations/hermes/urgent-caller/scripts/call.py`
- `integrations/hermes/urgent-caller/SKILL.md`

Add structured live-call arguments and automatically read `HERMES_SESSION_ID`. Continue supporting existing message/audio calls unchanged.

### 12.4 iOS Caller

Modify:

- `ios/AgentCaller/IncomingCall.swift`
- `ios/AgentCaller/PushManager.swift`
- `ios/AgentCaller/CallCoordinator.swift`
- `ios/AgentCaller/AppDelegate.swift`
- `ios/AgentCaller/ConnectionConfiguration.swift`
- `ios/AgentCaller/Info.plist`
- `project.yml`

Add:

- `ios/AgentCaller/VoiceBootstrapClient.swift`
- `ios/AgentCaller/GrokVoiceSession.swift`
- `ios/AgentCaller/RealtimeAudioEngine.swift`
- `ios/AgentCaller/VoicePromptBuilder.swift`
- `ios/AgentCaller/HermesApprovalCoordinator.swift` — native, installation-authenticated approval UI boundary; not callable through MCP.

The CallKit state machine independently tracks:

- Answer accepted.
- Bootstrap ready.
- CallKit audio session activated.

The microphone starts only when all three are true. End/reset/deactivate cancels bootstrap, closes the xAI socket/audio engine, and revokes the voice session. Failed bootstrap falls back to existing TTS or downloaded audio.

Inject the installation credential provider and relay configuration into `CallCoordinator`; do not access secrets through globals. Add `NSMicrophoneUsageDescription` and request microphone permission during normal in-app setup before the first live call, not from the background PushKit callback. Implement bounded microphone buffering, stale-output cancellation after interruption, AVAudioSession interruption/route-change handling, and reconnect/resumption behavior that fails closed to the existing one-way fallback.

`AppDelegate` registers for standard remote notifications in addition to the existing PushKit registration. `PushManager` keeps the two tokens and handlers structurally separate: the VoIP handler accepts only call payloads and always reports CallKit; the standard APNs handler recognizes the minimal `hermes_approval_required` event, deduplicates its notification ID, refreshes the approval inbox, fetches details with the installation credential, and presents the native confirmation UI without auto-answering or placing command text in the notification. Tests cover token registration, expiry, duplicate delivery, exact-choice validation, denial, approval after the originating call ended, revocation, and proof that approval events never enter the VoIP handler.

### 12.5 AWS connectivity and Hermes API update

No repository code is deployed as an AWS bridge. Operational work is limited to:

1. Test, commit, and deploy the durable-run plus request-toolset Hermes API prerequisite; restart only the existing gateway and re-probe it.
2. Confirm the installed `cloudflared` is current enough for Workers VPC (live evidence: `2026.3.0`).
3. Create an outbound QUIC tunnel.
4. Register a Workers VPC Service targeting `127.0.0.1:8642`.
5. Install and enable the `cloudflared` service.
6. Verify no inbound security-group port is added.

Deployment order is: deploy code with dormant feature flag and new bindings, apply D1 migration, create and verify tunnel/VPC Service, add Worker secrets, enable MCP for a disposable installation, run production probes, then enable live bootstrap. Rollback disables live bootstrap first, rolls back the Worker version, and leaves additive D1/DO data intact.

## 13. Implementation Order

### P0 — Independent feasibility proof

- Review this document against current xAI, Cloudflare, Hermes, Caller, and AWS state.
- Prove xAI Speech-to-Speech accepts a Remote MCP tool definition.
- Prove Workers can serve a compatible Streamable HTTP MCP endpoint.
- Audit every effective `api_server` toolset and classify it read-only, approval-gated consequential, or disallowed; production starts deny-by-default with only explicitly audited read-only toolsets.
- Finish and deploy Hermes durable-run/request-toolset support, then probe live capability and behavior with disposable sessions/runs.
- Prove with a harmless approval-requiring command that `/v1/runs` pauses before tool execution and resumes only through the authenticated non-MCP approval endpoint; otherwise keep live Hermes tools disabled.
- Prove continuation across a prior tool-using turn using Hermes's native session history and fail closed if tool-call/result context is lost.
- Confirm Workers VPC is enabled for the account and can be configured through Wrangler or dashboard.
- Characterize xAI Remote MCP with authenticated 1/2/5/10/30-second staging probe tools during the first user-heard voice test; keep v1 correctness independent of the result.
- Characterize whether xAI preserves MCP JSON-RPC request IDs on HTTP retries; do not claim semantic deduplication if it does not.

### P1 — Cloudflare MCP contract

- Add the stateless MCP endpoint and two tool schemas.
- Add bounded token validation and mock Hermes client.
- Test with the official MCP Inspector and protocol fixtures.

### P2 — Durable session orchestration

- Apply D1 migration.
- Add the installation coordinator Durable Object and operation Workflow, including Wrangler exports/bindings and the new-DO migration tag.
- Implement fresh/active/continue, pre/post canonicalization, strict session/toolset allowlists and operation grants, MCP replay keys, `workflow_pending` alarm reconciliation, durable Hermes idempotency, reconciliation outcomes, approval/follow-up outboxes, and APNs deduplication.
- Prove Caller-channel ordering and Workflow launch/restart behavior with deterministic fake Hermes responses.

### P3 — Private Hermes connectivity

- Configure the already-installed Cloudflare Tunnel connector on `OpenClaw-usw2`.
- Create the Workers VPC Service and binding.
- Store Hermes API credentials as Worker secrets.
- Prove `/health`, `/v1/capabilities`, session creation, native-history durable run submission, tool-result continuation, exact-session continuation, pause-before-tool approval, authenticated approval/deny, and stop through the deployed Worker without a public Hermes port.

### P4 — Call/bootstrap contract

- Extend call creation and APNs payloads.
- Mint xAI ephemeral and MCP call tokens.
- Add briefing instructions and revoke endpoint.
- Preserve message/audio compatibility.

### P5 — iOS live voice path

- Implement xAI WebSocket audio transport.
- Add bootstrap and Remote MCP session configuration.
- Integrate the three-gate CallKit lifecycle and fallback.
- Add injected credentials/configuration, microphone setup, bounded buffers, reconnect/resumption, route interruption handling, stale-output cancellation, and the separate native approval boundary.
- Run unit tests and simulator lifecycle tests.

### P6 — Live MCP validation

- Deploy Worker and migrations.
- Use MCP Inspector against the production `/mcp` endpoint with a test call scope.
- Invoke `ask_hermes` against a disposable new Hermes session.
- Continue the returned session ID and prove transcript continuity.
- Test unknown/ungranted session failure, exact operation grants, MCP replay behavior, operation polling, Caller-channel ordering, approval isolation, Workflow launch reconciliation, and ambiguous-outcome behavior.
- Do not place a paid/user-heard voice call without the explicit final test boundary.

## 14. Acceptance Criteria

- xAI can initialize the deployed Remote MCP server and discover only `ask_hermes` and `check_hermes_task`.
- `ask_hermes(new)` returns `queued` immediately, and Caller automatically inserts subsequent status transitions and the terminal Hermes answer into the active Grok conversation.
- `ask_hermes(continue, returned_id)` reaches the same Hermes lineage.
- Compression-ID rotation is resolved before and after work and the current ID is returned.
- Two Caller-originated same-lineage operations preserve FIFO ordering; two different lineages may proceed concurrently. No global cross-client lock is claimed.
- Existing message and audio calls remain green.
- APNs contains only the short fallback envelope.
- No permanent xAI/Hermes key exists in the app, MCP output, APNs, logs, or repository.
- Hermes remains bound to loopback and no inbound AWS port is opened.
- The deployed MCP endpoint is authenticated, call-scoped, expiring, and revocable.
- MCP Inspector and direct protocol tests pass against production.
- A real deployed MCP call reaches Hermes and returns evidence-backed output.
- A completion after hangup creates one idempotent follow-up Caller/APNs call, while a fresh call token can read only explicitly granted operation IDs.
- No Grok-callable MCP route can approve a Hermes tool action.
- A live harmless command proves Hermes pauses before execution and resumes or denies only after the separate installation-authenticated approval request.
- The live Hermes capability advertises and enforces a deny-by-default request toolset allowlist; no voice request can widen it.
- A prior tool-using Hermes turn remains semantically available when the same session is continued through `ask_hermes`.
- Approval delivery uses the separate standard APNs token/channel, is content-minimal, idempotent, expiring, and causes the app to fetch details before showing the native confirmation UI; PushKit handles only actual calls.
- A crash between operation persistence and Workflow creation is repaired by the coordinator alarm without creating a second logical Workflow.
- iOS unit/build/simulator proof is reported separately from unperformed user-heard voice proof.

## 15. Review Questions for the Independent Agent

The reviewer must explicitly verify:

1. Does xAI Speech-to-Speech truly execute Remote MCP tools server-side, leaving the phone out of tool execution?
2. Is the proposed Cloudflare Streamable HTTP implementation compatible with xAI's supported MCP transport and authentication?
3. Can Workers VPC bind the existing Worker to a tunnel targeting `127.0.0.1:8642` without a public hostname?
4. Does durable `continue_session` preserve native tool context and expose a trustworthy pause-before-tool approval boundary and reconciliation state?
5. Does a Workflow plus one installation coordinator preserve Caller-channel ordering across Cloudflare restarts and session-ID rotation without overstating global Hermes serialization?
6. Is any separate AWS application still necessary?
7. Does the call-scoped event feed deliver both fast and long-running terminal results without Grok polling, while preventing response overlap and cross-session reads?
8. Can the current iOS xAI WebSocket implementation be built using native APIs without adding an unnecessary audio proxy?
9. Are there security or App Store concerns that change the planned CallKit/bootstrap boundary?
10. Which recommendations are blockers before implementation versus later hardening?

The first four reviews returned `REVISE`. This revision incorporates their blockers: deployment of the existing durable-run continuation work, a server-enforced request toolset allowlist, native tool-history preservation, live approval and policy-coverage gates, a separate standard-APNs approval channel plus authenticated inbox/detail/response routes, strict PushKit-for-calls-only handling, follow-up Caller/APNs completion delivery, no MCP approval tool, Caller-only ordering language, exact operation grants, detached delegation deferred, one authoritative installation coordinator, explicit Wrangler bindings/migrations, deterministic Workflow launch reconciliation, durable idempotent run creation and reconciliation handling, MCP JSON-RPC replay keys, a timeout/retry characterization gate, complete iOS prerequisites, and an exact session allowlist.

Implementation began only after the reviewer gave an approve-or-revise verdict and all material blockers were incorporated.

## 16. Implementation and Production Evidence

The independent reviewer completed four revise cycles. The final verdict was **APPROVE**, with no remaining implementation blockers. The important recommendations incorporated before implementation were the Hermes server-side request toolset boundary, a separate installation-authenticated approval path, one installation-scoped coordinator, durable operation projection, exact session/operation grants, and PushKit use restricted to actual calls.

The implementation is live with this boundary:

- Caller Worker: `https://agentcall-relay.chiragmgg.workers.dev`, deployed version `2ff4638c-28bd-46b0-aff6-1dc4cc12af2f`.
- Private path: a Workers VPC Service targets the existing healthy Cloudflare tunnel at Hermes `127.0.0.1:8642`; no public Hermes port or separate AWS bridge application was added.
- Hermes: upgraded to `0.19.1`, durable run capabilities enabled, and voice requests restricted to the server-configured `web` and `session_search` toolsets.
- Remote MCP: production discovery returns exactly `ask_hermes` and `check_hermes_task`.
- Production smoke: the Worker minted an xAI ephemeral token, initialized MCP, accepted the operation immediately with `completion_delivery: caller_events`, observed `queued → running → answered` through the call-scoped event feed, and returned the exact Hermes answer `CALLER_MCP_LIVE_OK`.
- Worker verification: 14 Node unit tests and five Worker-runtime tests pass; generated types, TypeScript checking, dry deploy, and startup validation pass.
- Hermes verification: 31 focused durable/API/tool-policy tests and six serialized-configuration tests pass locally against the deployed code lineage. A broader relevant suite passed 173 tests; one pre-existing readiness expectation remains unrelated to this feature.
- iOS verification: all 41 simulator tests pass, including authenticated cursor construction, event-output escaping, and response-overlap gating. A signed Debug device build was installed, launched, and observed running on Aeon.
- Live event-path verification: call `005ebac4-e4ec-4bd7-b8e3-56c4dde15459` created one Hermes operation with durable `queued → running → answered` events. Cloudflare live logs then showed the Aeon app repeatedly reading the authenticated feed at cursor `after=6`, proving that the physical client consumed through the terminal event. Whether the exact terminal wording was heard remains a separate human observation.
- Managed agent package: signed compatible release `0.4.3` is installed on the primary Hermes VPS, verifies current, retains the prior rollback, and has one flock-guarded daily updater entry at 03:37 UTC.

The final acceptance action is therefore intentionally human: answer one live call on Aeon, grant microphone permission if prompted, interrupt Grok once, and ask it to consult Hermes. That test characterizes real audio, barge-in behavior, and xAI's server-side MCP latency; those properties cannot be truthfully proven by the automated MCP smoke.
