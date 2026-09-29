# Caller × Hermes capability map

A static, mobile-first explanation of the personal Caller, Hermes, and Vobiz call routes. The page distinguishes existing Caller behavior, locally implemented phone features, and live activation still pending on DebianBat.

## Build

```sh
npm run check
```

The build produces `dist/`. `vercel.json` points Vercel at that output directory. The route selector uses a small local script; no framework or build-time secrets are required.

## Status copy

Review the date and every status label before a new deployment. In particular, update the Vobiz/Jio readiness and connection-tone answers only after a live carrier test. Keep personal phone numbers, DID numbers, tokens, caller reports, and transcripts out of the public page.
