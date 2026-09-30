# Vobiz to Codex media bridge

The bridge is a separate Python service for the personal Vobiz calling pilot. It
accepts a Vobiz bidirectional WebSocket stream after a call connects,
joins a Codex App Server realtime session as a WebRTC audio peer, and relays audio
in both directions. For outbound calls, the Worker asks the bridge to prepare
that call's Sol thread and GPT Live WebRTC session **before** it asks Vobiz to
dial. The bridge releases the opening only after the answered stream is
authenticated and bound to that prepared session. It uses the existing Hermes `openai-codex` credential pool
and ChatGPT authentication. It pins `gpt-6-sol` as the Codex text reasoning
model and uses the Codex realtime default GPT-Live model for speech. GPT-6 Sol
does not process audio directly. The voice model can answer a greeting or brief
acknowledgement itself; its call prompt tells it to delegate substantive
recipient requests to the Sol thread and speak the result. There is no OpenAI
API key or fallback provider.

The bridge does **not** install or restart Hermes's gateway. Inbound admission
is now enabled on the DebianBat bridge and its public health reports Codex and
runtime ready; the isolated Worker retains its disabled inbound switch. The purchased DID `+918071580171` is attached
to the Vobiz `Hermes_Inbound` Application, but Jio forwarding remains
unconfigured and no live inbound conversation has been proven. The bridge
admits one call at a time.
It holds audio only in short memory buffers; it does not save audio. Inbound
calls send a bounded, digit-redacted report to the isolated Worker at call end.
The bridge never writes the full transcript to its recovery spool.
The inference-aware script is deployed on DebianBat and public health is ready;
its pre-update backup is
`/home/chirag/.config/caller-vobiz-backups/20260930T090107Z-inferred-reason-v2`.
A synthetic post-call Sol inference using Hermes credentials returned a grounded
result with the required inferred, unverified label. A real inbound phone
callback, conversation, and Telegram alert remain unproven.

## Runtime

Use Python 3.11 or newer, **Codex CLI 0.158.x**, and an isolated virtual environment with
[`requirements-vobiz-bridge.txt`](requirements-vobiz-bridge.txt). Put the three new
scripts `scripts/vobiz_codex_bridge.py` and `scripts/vobiz_codex_appserver.py`
side by side in the service directory, along with executable
`scripts/vobiz_codex_bwrap.sh`. None imports the installed Caller
`voice_connector.py`.

Required service environment:

| Name | Purpose |
| --- | --- |
| `VOBIZ_RELAY_URL` | Base HTTPS URL of the isolated outbound Worker |
| `VOBIZ_RELAY_TOKEN` | Bridge-only Worker bearer token |
| `VOBIZ_BRIDGE_SECRET` | Shared HMAC key for Vobiz stream URLs and pre-dial action tokens, at least 32 characters |
| `VOBIZ_CODEX_LAUNCHER` | Absolute executable path to `vobiz_codex_bwrap.sh` |
| `VOBIZ_BWRAP_BINARY` | Absolute path to `bwrap`, usually `/usr/bin/bwrap` |
| `VOBIZ_CODEX_PACKAGE_ROOT` | Exact directory containing the Codex CLI entry and its runtime assets |
| `VOBIZ_CODEX_ENTRY_REL` | CLI entry path relative to that package root, such as `bin/codex.js` |
| `VOBIZ_NODE_BINARY` | Absolute path to the Node.js executable used by the CLI |
| `VOBIZ_BRIDGE_ALLOW_INBOUND` | Explicit inbound opt-in; defaults to `false` |
| `VOBIZ_BRIDGE_SPOOL_DIR` | Optional absolute path for durable inbound terminal reports; defaults to `/home/chirag/.local/state/caller-vobiz-bridge/terminal-events` on DebianBat |
| `CALLER_RELAY_URL`, `CALLER_AGENT_TOKEN` | Optional paired Caller relay origin and agent token for a short iPhone message after a completed inbound call; set both or neither |
| `HERMES_SEND_EXECUTABLE`, `HERMES_NOTIFICATION_TARGET` | Optional direct owner alert through an absolute `hermes` executable and one explicit `telegram:<chat-id>` target; set both or neither. When configured, this takes precedence over Caller relay. |

Resolve the DebianBat paths from `readlink -f` on the installed Codex and Node
executables, then point `VOBIZ_CODEX_PACKAGE_ROOT` at the narrow CLI package
directory that contains the Codex entry and its assets. The launcher refuses
to start without an executable bubblewrap binary or with a Codex entry outside
that package. It clears all inherited environment variables before starting
Codex, binds only the CLI package, Node binary, system libraries, certificate
and DNS files, and gives Codex an empty temporary home and `CODEX_HOME`. It
does not bind `/home/chirag/.hermes`, the operator's home, SSH files, or the
bridge's bearer secrets. The Python bridge keeps Hermes's authoritative
credential pool and passes ChatGPT auth tokens to Codex over App Server stdio.
It starts an ephemeral read-only `gpt-6-sol` thread with no environments or
dynamic tools. It explicitly rejects provider model fallback and checks both
model fields returned by `thread/start` before opening WebRTC media. A missing
or different startup model keeps readiness false. Any `model/rerouted`
notification during a call aborts that call. The realtime
session leaves its `model` unset, selecting Codex's supported GPT-Live speech
model. The thread's developer instructions restrict its text responses to the
approved call brief. A WebRTC `failed` or `closed` state ends the call
immediately. A transient `disconnected` state has five seconds to recover;
the bridge ends the call only if it remains disconnected.
This filesystem boundary is required even though a local spoken canary did not
produce a file-tool call; the canary cannot prove future Codex versions have no
built-in tools. The launcher still shares networking for WebRTC; test and
restrict that separately if expanding this pilot's privileges.

`CALLER_VOBIZ_L16_ENDIAN` defaults to `little` for both inbound Linear16 and
outbound `playAudio`. The first connected carrier test used `big`: the bridge
sent Codex audio but the callee heard silence. Sarvam's Vobiz integration guide
specifies raw little-endian Linear16 for `playAudio`. Keep this setting explicit
for the account and verify intelligible input and output in a live call. The service process
must use Hermes's Python environment or otherwise be able to import
`agent.credential_pool`.

Both relay URL settings must be exact origins. HTTPS is required off-machine;
plain HTTP is accepted only for numeric loopback addresses. Credentials, paths,
queries, and fragments are rejected before the bridge starts.

Before an inbound `ended` event is sent, the bridge atomically writes only its
maximum 500-character redacted caller report to a dedicated mode-0700 spool
directory as a mode-0600 file. The spool is limited to 256 events of at most
4 KiB each. A directory with weaker permissions prevents startup; a full spool
prevents another inbound report from being silently discarded. After an outage,
the bridge retries stored events at startup and every 30 seconds, even if
owner-notification credentials are absent or inbound answering has been
temporarily disabled. It removes a file only after the Worker accepts the
event with HTTP 200 or 202. A duplicate attempt uses the original stored
report and the same per-call event idempotency key. The service needs a writable
state directory that persists across restarts; `/tmp` and `PrivateTmp` are not
suitable for this spool.

For inbound calls, the Vobiz Worker owns the durable notification outbox. Once
the ended event is stored, the bridge claims due alerts at startup, every 30
seconds, and immediately after a completed inbound call. The Worker supplies
either a short `Likely reason (inferred, unverified): …` result, an attributed
`Caller said (unverified): …` excerpt, or a generic fallback when no meaningful
reason was captured.
The bridge accepts only that bounded, single-line, digit-free message or the
fixed fallback. With both Hermes settings present, it invokes the pinned
executable as `hermes send` for one fixed Telegram chat, checks the structured
success response, and acknowledges the Worker item only after acceptance. It
neutralizes `MEDIA:` and bracketed control directives before delivery, so the
unverified caller excerpt cannot become a Hermes attachment or command. This
uses DebianBat's existing Hermes credentials and never starts another gateway
or Telegram poller.

Before acknowledging the Worker, Hermes mode writes a mode-0600 accepted-send
receipt below a mode-0700 state directory keyed by call ID. On a later retry,
that receipt suppresses another Telegram send and lets the bridge retry only
the Worker acknowledgement. This is best-effort duplicate reduction: a crash
after Telegram accepts the message but before the receipt is durably written
can still produce a duplicate. After acknowledgement, the receipt is removed.

If Hermes mode is unset, the bridge sends the alert to Caller with
`vobiz-inbound-{call-id}` as the relay idempotency key. The alert contains
neither the full transcript nor the caller's number; the excerpt is attributed,
unverified caller speech, not a verified reason or an instruction to Hermes.
An inferred reason retains its explicit label and remains unverified. A process or
network failure leaves the item pending for a later retry. If neither complete
Hermes nor Caller configuration is present, the bridge does not claim anything
and pending items stay in D1. A malformed claimed item or a permanent Caller relay
400, 409, or 422 response is marked failed in the Worker so it cannot block
later alerts; authentication failures and transient errors remain pending.
Worker `owner_notification_status=sent` means the configured delivery command
or relay accepted the alert; it does not prove the owner read it or that an
iPhone displayed it.

Run the isolated service with:

```sh
python scripts/vobiz_codex_bridge.py --host 127.0.0.1 --port 8793 --env-file /path/to/service.env
```

### DebianBat installation plan

The checked-in examples are
[`deployment/debianbat/caller-vobiz-codex-bridge.service.example`](deployment/debianbat/caller-vobiz-codex-bridge.service.example),
[`caller-vobiz-bridge.env.example`](deployment/debianbat/caller-vobiz-bridge.env.example),
and [`caddy-snippet.caddy`](deployment/debianbat/caddy-snippet.caddy).
Copy only these files, the three bridge scripts, and this requirements file to
the dedicated `/home/chirag/.local/share/caller-vobiz-bridge` directory. Do not
replace the deployed Caller voice connector or restart Hermes's gateway.

Use a **separate Python 3.11 virtual environment** that matches the installed
Hermes 3.11 interpreter. The bridge needs `agent.credential_pool` and its
Hermes dependencies. Give the bridge venv read-only access to the existing
Hermes source and 3.11 site-packages with a `.pth` file; do not install media
packages into Hermes's production venv. Example, after copying the scoped
files to the dedicated directory:

```sh
BRIDGE_DIR=/home/chirag/.local/share/caller-vobiz-bridge
HERMES_PY=/home/chirag/.hermes/hermes-agent/venv/bin/python
"$HERMES_PY" -m venv "$BRIDGE_DIR/venv"
"$BRIDGE_DIR/venv/bin/python" -m pip install -r "$BRIDGE_DIR/requirements-vobiz-bridge.txt"
BRIDGE_SITE=$("$BRIDGE_DIR/venv/bin/python" -c 'import site; print(site.getsitepackages()[0])')
HERMES_SITE=$("$HERMES_PY" -c 'import site; print(site.getsitepackages()[0])')
printf '%s\n%s\n' /home/chirag/.hermes/hermes-agent "$HERMES_SITE" > "$BRIDGE_SITE/hermes-readonly.pth"
"$BRIDGE_DIR/venv/bin/python" -c 'from agent.credential_pool import load_pool; import aiortc, av, websockets; print("imports ok")'
```

If DebianBat cannot reach package indexes, build a Linux x86_64 wheelhouse on
a networked machine for **Python 3.11** and copy it to DebianBat. For example:

```sh
python3 -m pip download --only-binary=:all: --platform manylinux_2_28_x86_64 --platform manylinux2014_x86_64 --python-version 311 --implementation cp --abi cp311 -r requirements-vobiz-bridge.txt -d wheelhouse
```

Then replace the install line above with
`"$BRIDGE_DIR/venv/bin/python" -m pip install --no-index --find-links "$BRIDGE_DIR/wheelhouse" -r "$BRIDGE_DIR/requirements-vobiz-bridge.txt"`.
Use wheels compatible with the host's glibc and CPU, then run the import and
codec check on DebianBat before starting the service. Bubblewrap must be
installed separately; `vobiz_codex_bwrap.sh --version` must print a supported
Codex version as `chirag` with the filled environment. If bubblewrap or its
user namespace support is unavailable, the bridge must remain disabled.

Install the env example as `/home/chirag/.config/caller-vobiz-bridge.env` with
mode `0600`, replacing placeholders with the isolated Worker's bridge token and
stream secret plus the local Codex/Node paths. Install the unit at
`/etc/systemd/system/caller-vobiz-codex-bridge.service`. Add the Caddy snippet
to the existing `claw.forgeme.xyz` site, run `caddy validate`, and reload Caddy
after validation. Starting this standalone service does not touch
`hermes-gateway.service`. Before enabling Worker outbound calls, verify both
`http://127.0.0.1:8793/health` and the public
`https://claw.forgeme.xyz/caller-vobiz/health` report `codex_ready: true`.

Caddy should expose `https://claw.forgeme.xyz/caller-vobiz/*` through
`handle_path` to `127.0.0.1:8793`, making the public stream URL
`wss://claw.forgeme.xyz/caller-vobiz/vobiz`. The bridge's `GET /health` returns
`codex_ready: true` only while the authenticated App Server process is alive
and no call or prepared outbound session occupies this one-call pilot. It also
returns `runtime_ready: true` when the App Server and verified WebRTC runtime
are alive even while an outbound call has reserved capacity. The Worker uses
`codex_ready` to admit a new call. The outbound Answer callback returns its
stream without a new bridge health fetch; the bridge checks the reserved
session's liveness before attaching it. On startup, the bridge starts and
verifies a `gpt-6-sol` thread, performs a ChatGPT-authenticated synthetic
WebRTC SDP/ICE exchange, and requires nonzero audio before exposing
`codex_ready: true`. This startup check proves the configured Sol thread and
voice transport; it does not exercise a substantive backend handoff. Each
actual call still has its own SDP/ICE/media exchange.

After the Worker persists an outbound call row, it sends an authenticated
`GET /caller-vobiz/prepare/<call-id>` to the bridge and waits for HTTP 200 with
`{"ok":true,"prepared":true}` before issuing Vobiz's outbound dial request.
The bridge fetches the approved brief, pins the ephemeral `gpt-6-sol` thread,
and completes the GPT Live WebRTC SDP/ICE exchange within 38 seconds. It feeds
silence to the audio input and continuously drains any early model output
without sending it to a phone. Duplicate prepare requests for the same call
share the one session; another call receives HTTP 409. A 180-second timer or
an authenticated `GET /caller-vobiz/cancel/<call-id>` closes an unclaimed
session. The Worker sends cancel after definite pre-dial failures and
pre-answer hangups. These endpoints require a distinct short-lived V2 HMAC
Bearer token bound to the call ID, outbound direction, expiry, and action;
stream URL tokens cannot authorize them. The token never appears in an
action URL. A preparation failure prevents the Worker from dialing.

As soon as the bridge verifies the signed WebSocket token and Vobiz `start`
frame format, it plays a paced in-call connecting tone. For outbound calls it
compares `start.callId` with the callback-verified provider UUID signed into
the stream token, checks the already prepared session, and attaches it without
another Worker context fetch. The remote claim and connected event run in the
background; an HTTPS delay on those bookkeeping requests cannot hold speech.
A missing or unhealthy outbound reservation fails closed, with no cold start.
Inbound calls retain their fresh context fetch, synchronous claim, and Codex
start after answer. A failure during or after activation ends the call; it
does not risk replaying buffered or duplicate speech through a second session.
An 8 kHz provider input is
resampled into the prepared 16 kHz WebRTC input. Inbound calls continue to
start only after the stream arrives. The tone
uses the [published Indian local ringing cadence](https://www.itu.int/dms_pub/itu-t/opb/sp/T-SP-E.180-2010-PDF-E.pdf)
(400 Hz with 25 Hz modulation, 0.4 s on, 0.2 s off, 0.4 s on, 2.0 s off).
It uses 50 ms raw L16 chunks at 24 kHz. Before sending the first model speech
frame, the bridge sends `clearAudio` and waits for Vobiz's `clearedAudio`
acknowledgement, so the greeting does not race a queued tone. A
caller hangup or failed session stops the tone. This tone is played **after the
PSTN call is answered**; the carrier controls the true ringback before answer.
The bridge logs only the call UUID and bounded prepare, attach, and first
audio timing; it does not log the bearer token, phone number, or transcript.

Vobiz documents [`StartApp`](https://www.vobiz.ai/docs/concepts/callbacks) at
answer and executes [`<Stream>`](https://www.vobiz.ai/docs/xml/stream) after
the Answer URL returns XML. Its [early-media `<PreAnswer>`](https://www.vobiz.ai/docs/xml/preanswer)
can play static audio before formal answer on supported SIP routes, but cannot
contain `<Stream>` and may run only after answer on unsupported routes. The
Voice Application has no separately documented pre-answer webhook to
authenticate an incoming DID call and initialize GPT Live while network
ringback is still playing. The actual DID and carrier path need a live trace
before any stronger timing claim or early-media rollout.

The bridge ends an idle answered call after 45 seconds without speech and
enforces a 180-second answered-call limit. On idle end, it checkpoints the
final playback, waits up to four seconds for Vobiz `playedStream`, then sends
`stop`. A normal recipient hangup is handled by WebSocket close.

## Worker contract

The isolated Worker gives Vobiz an Answer URL that returns `<Stream
bidirectional="true" keepCallAlive="true"
contentType="audio/x-l16;rate=16000">` pointing at the public WSS URL with a
short-lived signed `token` query parameter. Inbound uses
`base64url(JSON({v:1,id,exp,direction:"inbound"})).base64url(HMAC-SHA256(secret,
first_segment))`. The bridge fetches inbound context through
`GET /v1/vobiz/bridge/calls/{id}` using `VOBIZ_RELAY_TOKEN`; it requires the
owned E.164 `called_number`, may accept an unverified E.164 `caller_number`,
compares the expected `vobiz_call_id` with Vobiz's `start.callId`, and claims
the call synchronously before voice starts.

Outbound uses an exact V2 stream payload
`{v:2,id,exp,direction:"outbound",provider_call_id}` signed the same way.
The provider call ID is the callback-verified lowercase UUID. The bridge
requires the matching prepared session, which already holds the authenticated
context fetched before dialing, and compares `start.callId` to that UUID.
It consumes the local call reservation once, including across replay attempts
in the running process. After a bridge restart the prepared session is absent,
so the stream fails closed. A remote `/claim` records the attachment in the
Worker in the background; the provider Hangup and terminal bridge event can
still record the outcome if that claim is late.

The DID is already attached to `Hermes_Inbound`. First test that binding with
the Worker inbound flag off: authenticated callbacks are recorded as
`blocked_disabled`, while Answer returns `<Hangup/>`. Fixed callback routes
remain HMAC-only. Token-suffixed routes accept one confidential, canonical
43-character bearer for providers that omit signature headers; if headers are
present, their HMAC must still validate. After callback proof, direct Hermes
delivery configuration, and healthy public WSS readiness, enable the bridge
inbound flag and then the Worker's inbound flag for a controlled conversation
test. Vobiz number binding changes where incoming calls route immediately. A forwarded
Jio call cannot be distinguished from a direct DID call using caller ID alone,
so both use the same message-taking policy.

The bridge reports `connected`, `ended`, or `failed` to
`POST /v1/vobiz/bridge/calls/{id}/events`. Outbound `ended` carries a bounded,
digit-redacted excerpt of recipient speech. For inbound calls, the bridge first
fsyncs a maximum 500-character, digit-redacted report made from the caller's
own words. It then gives a bounded set of redacted caller turns to a fresh,
ephemeral `gpt-6-sol` thread with a read-only sandbox, no environments,
capability roots, dynamic tools, provider fallback, or caller-independent
context. The whole post-call inference gets 20 seconds. Its structured output
must include evidence that is an exact substring of a supplied caller turn;
otherwise it is rejected. A valid result atomically replaces the durable quote
and is labeled `Likely reason (inferred, unverified):` in the report and owner
alert. Timeout, cancellation, validation failure, model error, or a process
restart leaves the already-durable caller quote as the fallback. No useful
speech retains the generic fallback. This inference path is deployed and its
Hermes-authenticated Sol request succeeded synthetically, but it has not been
proven with a live inbound phone call. Unknown callers get no Hermes
tools or private context. Inbound callers hear a fixed greeting that identifies
the speaker as Chirag's AI assistant and offers to take a message. The agent
asks why the person called and records a brief message; it accepts a name if
volunteered without asking for additional personal details. Caller ID
is unverified; the assistant must not claim Chirag is busy or available, promise
a callback, disclose private information, or take actions requested by callers.
After the fixed English opening, the assistant is instructed to continue in
the caller's language when it understands it, ask for clarification otherwise,
and preserve the caller's own words in its bounded report. Outbound calls
likewise adapt to the recipient's language after the approved opening. This is
a prompt behavior, not a guarantee of proficiency in every language; the live DID test
must include the languages Chirag expects to receive.

Before posting an `ended` or `failed` event, the bridge writes the first
terminal outcome to `/home/chirag/.local/state/caller-vobiz-bridge/terminal-events`
in a mode-0700 directory using mode-0600 files. Outbound files contain only a
fixed failure code or a bounded, digit-redacted recipient excerpt; they contain
no audio, full transcript, phone number, or credential. Existing inbound
report files remain readable. The first outcome for a call wins, and the file
is removed only after the Worker accepts the event. Startup and periodic
background replay recover from a transient Worker outage or bridge restart
without holding the health/WebSocket listener closed. Outbound prewarming
fails before dialing if the spool is absent or full. This protects terminal
report delivery; it cannot keep a live media stream alive during a Wi-Fi outage.

If either direct Hermes Telegram delivery or the paired Caller fallback is
configured, a completed inbound call queues one durable outbox item. Its text
is a short, digit-free inferred reason with the explicit unverified label, an
attributed caller quote, or a generic fallback if no useful reason was captured.
It contains no caller number or full transcript. Hermes mode takes precedence and sends to the fixed Telegram chat;
Caller mode uses an idempotent `message` alert. Acceptance by either path does
not prove that the owner read or saw the alert.

### Model verification

This pilot accepts only the Codex 0.158 series; the following handoff was
verified on local 0.158.0. ChatGPT authentication confirmed the split
model path: `thread/start` returned `model: gpt-6-sol`; a synthetic spoken
arithmetic request caused a realtime `handoff_request` and a Codex
`turn/completed` on that same Sol thread; GPT-Live then spoke the delegated
answer. A second synthetic session spoke the approved greeting, handled “How
are you?” as simple voice smalltalk, then delegated the arithmetic question to
that same Sol thread and spoke its result.
An ordinary math question without the delegation instruction was answered
directly by GPT-Live. This is why the prompt now requests delegation for
substantive turns. App Server does not guarantee that every spoken reply is
Sol-generated, so the service does not claim that; simple conversational
speech may come from GPT-Live. A runtime `model/rerouted` event fails the call
because the configured model can differ from per-turn execution. Verify the
handoff event trace before admitting another Codex series. DebianBat's
installed Codex version and CPU/media support
remain to be checked on the host before enabling outbound calls.

The [GPT-6 Sol model page](https://developers.openai.com/api/docs/models/gpt-6-sol)
lists no audio modality. The [GPT-Live delegation guide](https://developers.openai.com/api/docs/guides/live-delegation)
describes delegating spoken requests to a text model. The bridge uses Codex
App Server's ChatGPT-authenticated handoff, not the separately billed API-key
path shown in platform examples.

Protocol references: [Vobiz stream format](https://www.vobiz.ai/docs/concepts/streaming-websockets),
[Vobiz stream events](https://www.vobiz.ai/docs/xml/stream/stream-events),
[checkpoint acknowledgement](https://www.vobiz.ai/docs/xml/stream/checkpoint-event),
[stop event](https://www.vobiz.ai/docs/xml/stream/stop-event), and
[Codex App Server](https://learn.chatgpt.com/docs/app-server). The Codex
realtime methods are experimental and their subscription entitlement should be
verified with a real session after upgrades.
