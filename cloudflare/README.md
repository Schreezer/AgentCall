# AgentCall Cloudflare relay

This is the durable deployment target for the AgentCall relay. It implements the same API as `../backend` with Cloudflare-native persistence and scheduling.

## Bindings

| Binding | Purpose |
| --- | --- |
| `DB` | D1 installation, call, audio-metadata, rate-limit, and idempotency state |
| `AUDIO` | R2 audio objects |
| `SCHEDULER` | Per-installation Durable Object alarm for due calls and audio cleanup |

`APNS_TEAM_ID`, `APNS_KEY_ID`, and `APNS_PRIVATE_KEY` must be Worker secrets. `APNS_BUNDLE_ID` is a non-secret variable in `wrangler.jsonc`.

## Local verification

```bash
npm install
npm run db:migrate:local
npm test
npm run check
npm run dev
```

Copy `.dev.vars.example` to `.dev.vars` only when you have local APNs credentials to test. The API can run without them, but `/health` reports `apnsReady: false` and immediate calls finish as `failed`. Do not use a production device token against the APNs sandbox endpoint or vice versa.

## Deployment

See the root `README.md` for resource creation, secret setup, migration, and deployment commands.

The first deployed test must use a physical iPhone and a sandbox PushKit token. Require the call status to reach `delivered`; that means APNs accepted the request, not that the phone rang or the user answered.
