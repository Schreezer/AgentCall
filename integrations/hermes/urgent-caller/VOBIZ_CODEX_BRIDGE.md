# Vobiz to Codex media bridge

The bridge is a separate Python service for the personal outbound-call pilot. It
accepts a Vobiz bidirectional WebSocket stream after the called person answers,
joins a Codex App Server realtime session as a WebRTC audio peer, and relays audio
in both directions. It uses the existing Hermes `openai-codex` credential pool
and ChatGPT authentication. It pins `gpt-6-sol` as the Codex text reasoning
model and uses the Codex realtime default GPT-Live model for speech. GPT-6 Sol
does not process audio directly. The voice model can answer a greeting or brief
acknowledgement itself; its call prompt tells it to delegate substantive
recipient requests to the Sol thread and speak the result. There is no OpenAI
API key or fallback provider.

The bridge does **not** install or restart Hermes's gateway. Inbound calls and
Jio forwarding are disabled in this pilot. The bridge admits one call at a time.
It holds audio only in short memory buffers; it does not save audio. It sends a
bounded, OTP-redacted transcript to the isolated outbound Worker at call end.

## Runtime

Use Python 3.11 or newer, **Codex CLI 0.158.0 or newer**, and an isolated virtual environment with
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
| `VOBIZ_BRIDGE_SECRET` | Shared HMAC key for Vobiz stream URLs, at least 32 characters |
| `VOBIZ_CODEX_LAUNCHER` | Absolute executable path to `vobiz_codex_bwrap.sh` |
| `VOBIZ_BWRAP_BINARY` | Absolute path to `bwrap`, usually `/usr/bin/bwrap` |
| `VOBIZ_CODEX_PACKAGE_ROOT` | Exact directory containing the Codex CLI entry and its runtime assets |
| `VOBIZ_CODEX_ENTRY_REL` | CLI entry path relative to that package root, such as `bin/codex.js` |
| `VOBIZ_NODE_BINARY` | Absolute path to the Node.js executable used by the CLI |

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
or different model fails the call and keeps readiness false. The realtime
session leaves its `model` unset, selecting Codex's supported GPT-Live speech
model. The thread's developer instructions restrict its text responses to the
approved call brief.
This filesystem boundary is required even though a local spoken canary did not
produce a file-tool call; the canary cannot prove future Codex versions have no
built-in tools. The launcher still shares networking for WebRTC; test and
restrict that separately if expanding this pilot's privileges.

`CALLER_VOBIZ_L16_ENDIAN` defaults to `big`, the network-order interpretation
of L16. Vobiz's public docs specify signed 16-bit PCM but do not state byte
order; confirm intelligible input and output in the authorized self-call. Set
`little` only if that call or Vobiz support confirms it. The service process
must use Hermes's Python environment or otherwise be able to import
`agent.credential_pool`.

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
and no call occupies this one-call pilot. On startup, the bridge starts and
verifies a `gpt-6-sol` thread, performs a ChatGPT-authenticated synthetic
WebRTC SDP/ICE exchange, and requires nonzero audio before exposing
`codex_ready: true`. Each actual call still has its own
SDP/ICE/media exchange.
The bridge ends an idle answered call after 45 seconds without speech and
enforces a 180-second answered-call limit. On idle end, it checkpoints the
final playback, waits up to four seconds for Vobiz `playedStream`, then sends
`stop`. A normal recipient hangup is handled by WebSocket close.

## Worker contract

The isolated Worker gives Vobiz an Answer URL that returns `<Stream
bidirectional="true" keepCallAlive="true"
contentType="audio/x-l16;rate=16000">` pointing at the public WSS URL with a
short-lived signed `token` query parameter. The token is
`base64url(JSON({v:1,id,exp,direction:'outbound'})).base64url(HMAC-SHA256(secret,
first_segment))`. The bridge checks it, then fetches
`GET /v1/vobiz/bridge/calls/{id}` using `VOBIZ_RELAY_TOKEN`. The context must
include `id`, `direction`, `vobiz_call_id`, `instructions`, and
`opening_speech`. The bridge compares the expected `vobiz_call_id` with
Vobiz's `start.callId` and atomically claims the call at
`POST /v1/vobiz/bridge/calls/{id}/claim` before starting Codex. This Worker
claim blocks token replay after a bridge restart.

The bridge reports `connected`, `ended`, or `failed` to
`POST /v1/vobiz/bridge/calls/{id}/events`. `ended` includes up to 20 transcript
turns (400 characters each); the Worker creates the owner-facing summary.
Unknown callers get no Hermes tools or private context. In the current pilot,
inbound tokens are rejected before a Codex session starts.

### Model verification

Local Codex 0.158.0 testing with ChatGPT authentication confirmed the split
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
speech may come from GPT-Live. Verify the handoff event trace again after a
Codex upgrade. DebianBat's installed Codex version and CPU/media support
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
