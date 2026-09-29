# Hermes PSTN Caller skill

This directory is the deployable Caller repository snapshot of the Hermes `pstn-caller` skill. It places outbound calls through the private Vobiz relay, polls bounded call results, and reads the inbound call inbox. The checked-in skill, script, and environment example are byte-for-byte copies of their tested Hermes source versions.

## Install on DebianBat

Install only when DebianBat is reachable. Copy this directory to a Caller checkout or staging directory on DebianBat, then run these commands from its parent checkout as the Hermes user:

```bash
install -d -m 0755 ~/.hermes/skills/pstn-caller/scripts
install -m 0644 integrations/hermes/pstn-caller/SKILL.md ~/.hermes/skills/pstn-caller/SKILL.md
install -m 0755 integrations/hermes/pstn-caller/scripts/place_call.py ~/.hermes/skills/pstn-caller/scripts/place_call.py
if [ ! -e ~/.hermes/pstn-caller.env ]; then
  install -m 0600 integrations/hermes/pstn-caller/pstn-caller.env.example ~/.hermes/pstn-caller.env
fi
```

Edit a newly created `~/.hermes/pstn-caller.env` on DebianBat with the private relay origin and dedicated token. Keep the file owned by the Hermes user with mode `0600`; repeat installations preserve an existing credential file.

Installing this skill does not require a gateway restart. DebianBat remains the sole Hermes production host and Telegram poller; do not run the Hermes gateway or Telegram poller on the Mac.

## Verify the package

```bash
python3 -m unittest integrations/hermes/pstn-caller/tests/test_pstn_caller.py
```
