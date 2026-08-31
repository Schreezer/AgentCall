# DebianBat deployment

These are deployment templates, not evidence that the service is live. Keep the existing
`hermes-gateway`, `hermes-dashboard`, Caddy, and cloudflared units untouched except for the one
scoped Caddy handler below.

## 1. Preflight

On DebianBat, require:

```sh
node --version
codex --version
sudo -u chirag -H codex login status
systemctl is-active hermes-gateway caddy cloudflared
ss -ltn | grep -E ':(8642|8792) '
```

The pinned result is Node 20 or newer, `codex-cli 0.149.1`, a ChatGPT login, active existing
services, Hermes on loopback `:8642`, and nothing yet listening on `:8792`.

## 2. Install the broker files

Copy only `codex-voice-broker` to `/home/chirag/agentcaller-codex-voice-broker`. It has no npm
dependencies. Set ownership to `chirag:chirag`.

Create `/home/chirag/.config/agentcaller/codex-voice-broker.env` from the example with mode `0600`.
Generate a new random broker token and store the same value as the Worker secret
`CODEX_VOICE_BROKER_TOKEN`; never print it into logs or commit it.

Install the unit:

```sh
sudo install -o root -g root -m 0644 \
  deploy/debianbat/codex-voice-broker.service \
  /etc/systemd/system/codex-voice-broker.service
sudo systemctl daemon-reload
sudo systemctl enable --now codex-voice-broker.service
sudo systemctl status codex-voice-broker.service --no-pager
```

Use an authenticated health request on loopback. A bare request must return 401; the bearer request
must return 200 with `codex_version: 0.149.1`.

## 3. Add the private public route

Back up `/etc/caddy/Caddyfile`, add `Caddyfile.snippet` inside the existing `:80` site before its
final response, then validate before reload:

```sh
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

From the Mac, require an unauthenticated request to
`https://claw.forgeme.xyz/caller-codex/health` to return 401. Then test the bearer credential without
printing it. The broker stays inaccessible without that secret even though cloudflared publishes the
path.

## 4. Configure the Worker, then switch

Set the non-secret variable:

```text
CODEX_VOICE_BROKER_URL=https://claw.forgeme.xyz/caller-codex
```

Store the token with `wrangler secret put CODEX_VOICE_BROKER_TOKEN`, apply D1 migration 0005, deploy
while `LIVE_VOICE_PROVIDER` is still `xai`, and call the authenticated
`/v1/agent-diagnostics/live-voice` endpoint. Only after that returns a healthy Codex broker should
`LIVE_VOICE_PROVIDER` change to `codex`.

## 5. Evidence gates

The rollout is complete only after all of these are separately observed:

1. Broker unit active and authenticated local health 200.
2. Authenticated Worker diagnostic reports provider `codex` and Codex 0.149.1.
3. D1 records a new `voice_sessions.provider = 'codex'` row.
4. A physical iPhone answers a live call and exchanges audio in both directions.
5. One `ask_hermes` request reaches the existing DebianBat Hermes session and its later event is
   spoken naturally.

Build, simulator tests, or broker health do not substitute for the physical audio and Hermes gates.
