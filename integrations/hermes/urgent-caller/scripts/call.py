#!/usr/bin/env python3
import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request


def main():
    parser = argparse.ArgumentParser(description="Place or schedule a Caller call")
    parser.add_argument("--message", required=True)
    parser.add_argument("--at", dest="scheduled_at")
    parser.add_argument("--caller-name", default="Hermes")
    parser.add_argument("--idempotency-key", required=True)
    parser.add_argument(
        "--wait-seconds",
        type=float,
        help="Poll an accepted call for this many seconds (default: 15 for immediate calls, 0 for scheduled calls)",
    )
    args = parser.parse_args()

    relay_url = os.environ.get("CALLER_RELAY_URL", "").rstrip("/")
    agent_token = os.environ.get("CALLER_AGENT_TOKEN", "")
    if not relay_url or not agent_token:
        print("Caller is not paired. CALLER_RELAY_URL and CALLER_AGENT_TOKEN are required.", file=sys.stderr)
        return 2

    payload = {"caller_name": args.caller_name, "message": args.message}
    if args.scheduled_at:
        payload["scheduled_at"] = args.scheduled_at

    request = urllib.request.Request(
        f"{relay_url}/v1/calls",
        data=json.dumps(payload).encode(),
        method="POST",
        headers={
            "authorization": f"Bearer {agent_token}",
            "content-type": "application/json",
            "idempotency-key": args.idempotency_key,
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            result = json.loads(response.read().decode())

        wait_seconds = args.wait_seconds
        if wait_seconds is None:
            wait_seconds = 0 if args.scheduled_at else 15
        deadline = time.monotonic() + max(wait_seconds, 0)
        while result.get("status") in {"scheduled", "delivering"} and time.monotonic() < deadline:
            time.sleep(min(1, max(deadline - time.monotonic(), 0)))
            status_request = urllib.request.Request(
                f"{relay_url}/v1/calls/{result['id']}",
                headers={"authorization": f"Bearer {agent_token}"},
            )
            with urllib.request.urlopen(status_request, timeout=15) as response:
                result = json.loads(response.read().decode())

        output = {
            "id": result.get("id"),
            "status": result.get("status"),
            "scheduled_at": result.get("scheduled_at"),
            "delivered_at": result.get("delivered_at"),
            "delivery_errors": result.get("delivery_errors", []),
        }
        print(json.dumps(output))
        return 1 if result.get("status") == "failed" else 0
    except urllib.error.HTTPError as error:
        print(error.read().decode() or str(error), file=sys.stderr)
        return 1
    except urllib.error.URLError as error:
        print(f"Caller relay is unreachable: {error.reason}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
