# Caller

Caller lets a personal agent place an urgent incoming voice call to an iPhone. Hermes, OpenClaw, or another agent receives a credential scoped to one app installation; Apple APNs credentials never leave the developer-operated push relay.

## Architecture

- `ios/AgentCaller`: native SwiftUI app, PushKit registration, one-time agent pairing, CallKit incoming-call UI, and MVP speech playback.
- `backend`: developer-owned push relay. It registers installations, exchanges short-lived pairing codes, authorizes scoped agent calls, persists schedules, and sends APNs VoIP pushes.
- `integrations/hermes/urgent-caller`: reference skill and pairing/call clients for a user-owned Hermes VPS.
- `HERMES_CALLER_SETUP_PROMPT.md`: self-contained setup contract copied to an agent.
- `ARCHITECTURE.md`: trust boundaries and complete request flow.

## Trust boundary

An App Store user does not provide an Apple Team ID or `.p8` key. The developer relay holds one APNs key for `com.chirag.agentcaller`. The user-owned Hermes server holds only a revocable token scoped to the paired Caller installation.

## Run the relay locally

```bash
cd backend
cp .env.example .env
# Fill the developer APNs values only when testing a signed physical iPhone.
node --env-file=.env src/server.js
```

The simulator can exercise pairing and the debug CallKit preview, but real PushKit delivery requires a signed physical iPhone.

## Run the iOS app

```bash
xcodegen generate
open AgentCaller.xcodeproj
```

Set `CallerRelayURL` to the deployed relay. Select the Apple team that owns the App Store bundle and enable Push Notifications plus the VoIP, audio, and remote-notification background modes.

The checked-in relay URL is the intentionally non-functional `https://push.caller.example` placeholder. Replace it in `project.yml`/`Info.plist`, or enter your HTTPS relay in the app's settings. Change the bundle identifier and APNs topic when signing under another Apple Developer account.

## Secrets and local state

Never commit an APNs `.p8` key, `backend/.env`, relay state, PushKit device tokens, installation secrets, or agent tokens. The repository ignores the standard local paths for these files; production deployments should use a dedicated secret manager and persistent database.

## Current MVP

The relay sends `call_id`, `caller_name`, and `message` in the VoIP push. After answer, the app speaks the message on-device and ends the call. Audio-file playback and a live WebRTC conversation are later phases.
