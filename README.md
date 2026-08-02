# AgentCall

AgentCall lets a personal AI agent place an incoming voice call to an iPhone when a message cannot wait. It combines a native SwiftUI app, PushKit and CallKit, a small APNs relay, and a reference skill for [Hermes Agent](https://github.com/NousResearch/hermes-agent).

The relay can speak a text message, play a short supplied audio file, or place a live two-way xAI Grok voice call. During a live call, xAI invokes an authenticated Remote MCP endpoint on the Cloudflare Worker; the Worker reaches Hermes privately by session ID and Grok decides how to speak the returned result.

> [!IMPORTANT]
> Apple documents PushKit VoIP notifications for initiating live voice calls. Treat the prerecorded-message implementation as an MVP and development tool. A production App Store version should use ordinary or time-sensitive notifications for one-way reminders and reserve PushKit/CallKit for a real, bidirectional voice session.

## How it works

```text
Hermes / OpenClaw / another agent
              |
              | HTTPS + installation-scoped token
              v
       AgentCall relay
              |
              | APNs VoIP push
              v
      iPhone wakes Caller
              |
              | CallKit incoming-call UI
              v
     User answers -> TTS, uploaded audio, or live Grok voice
```

In live mode, microphone and playback audio travel directly between the iPhone and xAI using a short-lived token. Tool calls travel separately from xAI to the Worker's `/mcp` endpoint, then through a Workers VPC Service and the existing outbound Cloudflare Tunnel to Hermes on loopback. There is no separate AWS voice-bridge application, and the app contains no permanent xAI or Hermes credential.

The end user's agent never receives Apple developer credentials or the phone's PushKit token. It stores only a revocable token scoped to one paired app installation. The developer-operated relay retains the APNs Team ID, Key ID, and `.p8` signing key.

For the complete trust model and request lifecycle, see [ARCHITECTURE.md](ARCHITECTURE.md).

## Repository layout

| Path | Purpose |
| --- | --- |
| `ios/AgentCaller` | Native SwiftUI app, pairing UI, PushKit registration, CallKit handling, and audio playback |
| `backend` | Local Node.js relay for development and compatibility testing |
| `cloudflare` | Durable Cloudflare Worker relay using D1, R2, and a Durable Object scheduler |
| `integrations/hermes/urgent-caller` | Reference Hermes skill with dependency-free Python pairing and call clients |
| `HERMES_CALLER_SETUP_PROMPT.md` | Self-contained instructions that the iOS app can give to a user's agent |
| `MAC_TEST_DEPLOYMENT.md` | Temporary Mac-hosted relay and physical-device testing notes |

## Requirements

- macOS with Xcode and the iOS 17 SDK or newer
- [XcodeGen](https://github.com/yonaskolb/XcodeGen)
- Node.js 20 or newer
- An Apple Developer account with Push Notifications enabled for physical-device VoIP testing
- An APNs signing key (`.p8`), Team ID, and Key ID for the relay

UI, pairing, and the CallKit preview can be tested in the simulator. A real PushKit wake-up requires a signed build on a physical iPhone and valid APNs credentials.

## Run the relay

```bash
cd backend
cp .env.example .env
```

Set the relay configuration in `backend/.env`:

```dotenv
PORT=8788
PUBLIC_BASE_URL=https://your-public-relay.example
DATA_FILE=./data/relay-state.json
AUDIO_DIR=./data/audio

APNS_TEAM_ID=YOUR_TEAM_ID
APNS_KEY_ID=YOUR_KEY_ID
APNS_PRIVATE_KEY_PATH=/absolute/path/to/AuthKey_YOUR_KEY_ID.p8
APNS_BUNDLE_ID=com.chirag.agentcaller
```

Then start it:

```bash
node --env-file=.env src/server.js
```

Confirm that the relay and APNs configuration are ready:

```bash
curl https://your-public-relay.example/health
```

Expected response:

```json
{"ok":true,"service":"caller-push-relay","storageReady":true,"apnsReady":true}
```

The relay must be reachable over HTTPS by both the iPhone and the agent. For temporary testing from a Mac, a Tailscale Funnel or another HTTPS tunnel can expose the local port. Use persistent hosting, durable storage, managed secrets, monitoring, and rate limiting before treating it as production infrastructure.

### Deploy the Cloudflare relay

The `cloudflare` implementation preserves the same HTTP API while replacing local files and process timers with managed storage:

- D1 stores installations, hashed credentials, pairing codes, calls, rate limits, and idempotency records.
- R2 stores installation-scoped audio attachments.
- A Durable Object alarm delivers scheduled calls and removes expired audio.
- Worker secrets hold the APNs Team ID, Key ID, and `.p8` signing key.
- A second Durable Object plus a Workflow coordinate session-scoped Hermes operations.
- `/mcp` exposes only `ask_hermes` and `check_hermes_task` to xAI.
- A Workers VPC Service reaches the existing Hermes API without publishing port 8642.

Create the resources:

```bash
cd cloudflare
npm install
npx wrangler login
```

Wrangler automatically provisions the D1 database and R2 bucket declared in `cloudflare/wrangler.jsonc`; no account-specific resource IDs belong in source control. Configure the three APNs secrets:

```bash
npx wrangler secret put APNS_TEAM_ID
npx wrangler secret put APNS_KEY_ID
npx wrangler secret put APNS_PRIVATE_KEY
npx wrangler secret put XAI_API_KEY
npx wrangler secret put HERMES_API_KEY
```

For `APNS_PRIVATE_KEY`, paste the complete contents of the `.p8` file, including its `BEGIN PRIVATE KEY` and `END PRIVATE KEY` lines. Confirm that `APNS_BUNDLE_ID` in `wrangler.jsonc` exactly matches the signed iOS app.

Apply the database migration, verify the Worker bundle, and deploy:

```bash
npm run db:migrate:remote
npm test
npm run check
npm run deploy
```

After deployment:

1. Open the deployed `/health` endpoint and require `storageReady` and `apnsReady` to both be `true`.
2. Set the iOS app's Caller relay URL to the deployed Worker URL.
3. Register a physical development-signed iPhone and pair an agent.
4. With permission, place one sandbox call and confirm the returned relay state reaches `delivered`.

That final call is required production evidence: the unit test proves the ES256 token and APNs request shape, while only a deployed request proves Cloudflare negotiated a connection Apple accepted.

The full live-voice architecture, threat boundaries, rollout sequence, review history, and verified production evidence are recorded in [CLOUDFLARE_MCP_HERMES_IMPLEMENTATION_PLAN.md](CLOUDFLARE_MCP_HERMES_IMPLEMENTATION_PLAN.md).

## Run the iOS app

Generate and open the Xcode project:

```bash
xcodegen generate
open AgentCaller.xcodeproj
```

In Xcode:

1. Select the Apple development team that owns the app's bundle identifier.
2. Ensure Push Notifications and the `audio`, `voip`, and `remote-notification` background modes are enabled.
3. Build and run on an iPhone.
4. Open Settings in Caller and replace the placeholder relay URL with your public HTTPS URL.
5. Allow the permissions requested by the app and wait until its status reads **Ready**.

The checked-in managed relay is `https://agentcall-relay.chiragmgg.workers.dev`. Advanced settings may override it for local development. If you change the bundle identifier, update `APNS_BUNDLE_ID` on the relay to match.

## Pair a personal agent

Once the app is ready, it produces a short-lived pairing code and a **Copy agent instructions** action. Give the copied instructions to Hermes, OpenClaw, or another capable agent. The agent claims the one-time code and receives an installation-scoped credential.

To pair the included Hermes integration manually:

```bash
cd integrations/hermes/urgent-caller
python3 scripts/pair.py \
  --relay-url "https://your-public-relay.example" \
  --code "ABCD-EFGH"
```

The pairing client stores `CALLER_RELAY_URL` and `CALLER_AGENT_TOKEN` in the Hermes environment. Pairing codes expire and can be used only once; do not paste an agent token into chat or commit it to source control.

## Place a call

After pairing, the agent can place an immediate text-to-speech call:

```bash
python3 scripts/call.py \
  --message "Your taxi has arrived outside." \
  --caller-name "PersonalClaw" \
  --idempotency-key "taxi-arrival-2026-07-14"
```

Schedule a call by supplying a timezone-aware ISO 8601 timestamp:

```bash
python3 scripts/call.py \
  --message "Leave now for the airport." \
  --at "2026-07-14T18:30:00+05:30" \
  --idempotency-key "airport-departure-2026-07-14"
```

Use a stable, event-specific idempotency key. Retrying the same event with the same key will not create duplicate calls.

### Place a call with an audio file

The agent can upload MP3, M4A, AAC, WAV, AIFF, or CAF audio and have it played after the user answers:

```bash
python3 scripts/call.py \
  --message "This text is used if the audio cannot be played." \
  --audio-file "/path/to/message.m4a" \
  --caller-name "PersonalClaw" \
  --idempotency-key "spoken-reminder-2026-07-14"
```

Audio is limited to 5 MB by default and expires after one hour. For a future call, schedule the agent to upload the file close to the call time instead of uploading it when the reminder is first created. The push payload carries only an opaque audio ID; the app downloads the file after the call is answered.

## API summary

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Relay and APNs readiness |
| `POST` | `/v1/installations` | Register an iOS installation |
| `POST` | `/v1/pairings/claim` | Exchange a one-time code for an agent token |
| `POST` | `/v1/audio` | Upload a short-lived audio attachment |
| `POST` | `/v1/calls` | Place or schedule a call |
| `GET` | `/v1/calls/:id` | Read relay delivery status |

An immediate call can move through `scheduled`, `delivering`, `delivered`, or `failed`. `delivered` means APNs accepted the push; it does not prove that the phone rang or that the user answered.

## Tests

Run the relay tests:

```bash
npm test --prefix backend
npm test --prefix cloudflare
npm run check --prefix cloudflare
```

Run the iOS tests from Xcode, or from the command line with an installed simulator:

```bash
xcodebuild \
  -project AgentCaller.xcodeproj \
  -scheme AgentCaller \
  -destination 'platform=iOS Simulator,name=iPhone 17' \
  test
```

## Security notes

- Never commit the APNs `.p8` key, `backend/.env`, relay state, audio storage, device tokens, installation secrets, or agent tokens.
- Pairing codes are short-lived and single-use; installation and agent credentials are stored as hashes by the relay.
- Uploaded audio is installation-scoped, type/size limited, returned with `Cache-Control: no-store`, and deleted after expiry.
- A production relay still needs transactional database storage, token revocation and rotation, per-installation quotas, App Attest, encrypted content, audit logging, and APNs invalid-token cleanup.
- Spoken content can be overheard. Agents should not include passwords, tokens, health details, or other sensitive information unless the user explicitly requests it.

## Roadmap

- Live bidirectional WebRTC audio with the user's agent
- Time-boxed ElevenLabs voice sessions: configurable 1, 3, or 5 minute limits, a five-minute server-enforced ceiling, a 30-second spoken warning, early hang-up when the task is complete, and per-user monthly minute budgets
- User-approved caller identity for each paired agent, including a stable Contacts-backed photo or poster that CallKit can resolve on the system incoming-call screen
- Call answered/ended event callbacks
- Production database and object storage
- Credential revocation and device migration
- Per-agent call policy, quiet hours, and abuse controls
- App Store release hardening

## License

AgentCall is available under the [MIT License](LICENSE).
