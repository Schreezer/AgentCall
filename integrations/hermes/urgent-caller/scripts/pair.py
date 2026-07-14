#!/usr/bin/env python3
import argparse
import json
import os
import pathlib
import sys
import urllib.error
import urllib.request


def main():
    parser = argparse.ArgumentParser(description="Pair Hermes with one Caller installation")
    parser.add_argument("--relay-url", required=True)
    parser.add_argument("--code", required=True)
    parser.add_argument("--env-file", default=os.path.expanduser("~/.hermes/.env"))
    args = parser.parse_args()

    relay_url = args.relay_url.rstrip("/")
    request = urllib.request.Request(
        f"{relay_url}/v1/pairings/claim",
        data=json.dumps({"pairing_code": args.code}).encode(),
        method="POST",
        headers={"content-type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            result = json.loads(response.read().decode())
    except urllib.error.HTTPError as error:
        print(error.read().decode() or str(error), file=sys.stderr)
        return 1
    except urllib.error.URLError as error:
        print(f"Caller relay is unreachable: {error.reason}", file=sys.stderr)
        return 1

    env_path = pathlib.Path(args.env_file).expanduser()
    env_path.parent.mkdir(parents=True, exist_ok=True)
    existing = env_path.read_text() if env_path.exists() else ""
    retained = [line for line in existing.splitlines() if not line.startswith(("CALLER_RELAY_URL=", "CALLER_AGENT_TOKEN="))]
    retained.extend([f"CALLER_RELAY_URL={relay_url}", f"CALLER_AGENT_TOKEN={result['agent_token']}"])
    env_path.write_text("\n".join(retained).rstrip() + "\n")
    env_path.chmod(0o600)
    print(f"Caller paired for installation {result['installation_id']}. Credential stored in {env_path}; restart the supervised agent gateway safely.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
