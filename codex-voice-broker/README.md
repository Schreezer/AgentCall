# AgentCaller Codex voice broker

This small local service owns the experimental Codex app-server connection. It uses the
ChatGPT login already managed by `codex login`; it never reads or exports OAuth tokens.

Requirements:

- Node.js 20 or newer
- `codex-cli 0.149.1`
- `codex login status` reporting a ChatGPT login
- a private HTTPS route from the Cloudflare Worker to this service (or a loopback URL for local tests)

Copy `.env.example` into your process manager's secret/config store, then run:

```sh
npm test
npm start
```

The service binds to `127.0.0.1:8791` by default. Put an authenticated tunnel or reverse proxy in
front of it for the Worker, set `CODEX_VOICE_BROKER_URL` and the matching
`CODEX_VOICE_BROKER_TOKEN` Worker secret, and switch `LIVE_VOICE_PROVIDER` to `codex` only after
the `/health` diagnostic succeeds.

Because the Codex realtime methods are experimental, the CLI version is checked at startup. Update
the pin only after regenerating the app-server experimental schema and rerunning this package's tests.

## DebianBat

The intended host is Chirag's `debianBat`, alongside Hermes but in its own systemd unit. The checked
host has Debian 13, an SSE4.1-only Core 2 Duo, and about 4 GiB RAM. The official Codex 0.149.1 Linux
binary was executed there successfully; Bun remains unsupported, but this broker uses Debian's Node
20 package. It listens on `127.0.0.1:8792` so it does not collide with the stale Caddy routes already
reserved for port 8791.

Deployment templates live under `deploy/debianbat`. The intended route is:

```text
Cloudflare Worker
  -> https://claw.forgeme.xyz/caller-codex/*
  -> existing cloudflared tunnel
  -> Caddy handle_path
  -> 127.0.0.1:8792
  -> codex-voice-broker.service (User=chirag)
  -> codex app-server
```

Install Node and the exact Codex version, then sign in interactively as `chirag`:

```sh
sudo apt-get install nodejs npm
sudo npm install --global @openai/codex@0.149.1
sudo -u chirag -H codex login --device-auth
sudo -u chirag -H codex login status
```

Do not copy Hermes's credential-pool files into `~/.codex`. The app-server should own its official
ChatGPT login and refresh lifecycle. Follow [`deploy/debianbat/README.md`](deploy/debianbat/README.md)
for the service, Caddy, and Worker rollout order.
