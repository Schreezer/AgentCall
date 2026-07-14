#!/usr/bin/env python3
import argparse
import hashlib
import json
import mimetypes
import os
import pathlib
import sys
import time
import urllib.error
import urllib.request


def main():
    parser = argparse.ArgumentParser(description="Place or schedule a Caller call")
    parser.add_argument("--message", required=True)
    parser.add_argument("--at", dest="scheduled_at")
    parser.add_argument("--caller-name", default="Hermes")
    parser.add_argument("--audio-file", help="Optional MP3, M4A, AAC, WAV, AIFF, or CAF speech file")
    parser.add_argument("--audio-content-type", help="Override the MIME type detected from --audio-file")
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

    try:
        if args.audio_file:
            audio_path = pathlib.Path(args.audio_file).expanduser()
            if not audio_path.is_file():
                print(f"Audio file does not exist: {audio_path}", file=sys.stderr)
                return 2
            if audio_path.stat().st_size > 5_000_000:
                print("Audio file exceeds the relay's default 5 MB limit.", file=sys.stderr)
                return 2
            audio_data = audio_path.read_bytes()
            content_type = args.audio_content_type or mimetypes.guess_type(audio_path.name)[0]
            if not content_type or not content_type.startswith("audio/"):
                print("Could not detect a supported audio type; pass --audio-content-type.", file=sys.stderr)
                return 2
            audio_idempotency_key = "audio-" + hashlib.sha256(args.idempotency_key.encode()).hexdigest()
            safe_filename = audio_path.name.encode("latin-1", "replace").decode("latin-1")
            upload_request = urllib.request.Request(
                f"{relay_url}/v1/audio",
                data=audio_data,
                method="POST",
                headers={
                    "authorization": f"Bearer {agent_token}",
                    "content-type": content_type,
                    "idempotency-key": audio_idempotency_key,
                    "x-audio-filename": safe_filename,
                },
            )
            with urllib.request.urlopen(upload_request, timeout=30) as response:
                uploaded_audio = json.loads(response.read().decode())
            payload["audio_id"] = uploaded_audio["audio_id"]

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
            "has_audio": result.get("has_audio", False),
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
