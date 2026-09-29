#!/usr/bin/env python3
"""Start and inspect calls through the dedicated Hermes PSTN relay."""

import argparse
import json
import os
import pathlib
import re
import stat
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid


E164 = re.compile(r"^\+[1-9][0-9]{7,14}$")
CALL_ID = re.compile(r"^[0-9a-zA-Z_-]{8,128}$")
MAX_RESPONSE_BYTES = 8192
MAX_INBOX_RESPONSE_BYTES = 65536
MAX_CONFIG_BYTES = 4096
CONFIG_KEYS = {"HERMES_PSTN_RELAY_URL", "HERMES_PSTN_TOKEN"}
TERMINAL_STATUSES = {"completed", "failed", "canceled"}
DELIVERY_STATUSES = {"delivered", "not_delivered", "unknown"}
ACKNOWLEDGEMENT_STATUSES = {"acknowledged", "not_acknowledged", "unknown"}
MAX_WAIT_SECONDS = 180
MAX_POLL_SECONDS = 30
SENSITIVE_DIGITS = re.compile(r"(?<!\d)\+?\d(?:[ ()-]*\d){3,}(?!\d)")


class PstnRelayError(Exception):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, _request, _fp, _code, _msg, _headers, _newurl):
        raise PstnRelayError("PSTN relay redirected the request")


def relay_url(value):
    parsed = urllib.parse.urlsplit(value.rstrip("/"))
    if parsed.scheme != "https" and not (
        parsed.scheme == "http" and parsed.hostname in {"127.0.0.1", "localhost", "::1"}
    ):
        raise PstnRelayError("HERMES_PSTN_RELAY_URL must use HTTPS")
    if not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in {"", "/"}:
        raise PstnRelayError("HERMES_PSTN_RELAY_URL must be a relay origin")
    return value.rstrip("/")


def runtime_config(path=None):
    path = pathlib.Path(path) if path is not None else pathlib.Path.home() / ".hermes" / "pstn-caller.env"
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(path, flags)
    except FileNotFoundError:
        return {}
    except OSError as error:
        raise PstnRelayError("PSTN config file cannot be opened") from error

    try:
        with os.fdopen(descriptor, "r", encoding="utf-8") as stream:
            file_stat = os.fstat(stream.fileno())
            if not stat.S_ISREG(file_stat.st_mode) or file_stat.st_uid != os.geteuid() or stat.S_IMODE(file_stat.st_mode) != 0o600:
                raise PstnRelayError("PSTN config must be a regular mode-0600 file owned by Hermes")
            if file_stat.st_size > MAX_CONFIG_BYTES:
                raise PstnRelayError("PSTN config file is too large")
            content = stream.read(MAX_CONFIG_BYTES + 1)
    except UnicodeDecodeError as error:
        raise PstnRelayError("PSTN config must be UTF-8") from error
    if len(content.encode("utf-8")) > MAX_CONFIG_BYTES:
        raise PstnRelayError("PSTN config file is too large")

    values = {}
    for raw_line in content.splitlines():
        if not raw_line.strip() or raw_line.lstrip().startswith("#"):
            continue
        key, separator, value = raw_line.partition("=")
        if not separator or key not in CONFIG_KEYS or key in values or value != value.strip() or not value:
            raise PstnRelayError("PSTN config has an invalid key or value")
        values[key] = value
    return values


def credentials(config_path=None):
    values = runtime_config(config_path)
    values.update({key: value.strip() for key in CONFIG_KEYS if (value := os.environ.get(key, "")).strip()})
    base = values.get("HERMES_PSTN_RELAY_URL", "")
    token = values.get("HERMES_PSTN_TOKEN", "")
    if not base or not token:
        raise PstnRelayError("PSTN relay is not configured in this Hermes environment")
    return relay_url(base), token


def read_result(response, max_bytes=MAX_RESPONSE_BYTES):
    raw = response.read(max_bytes + 1)
    if len(raw) > max_bytes:
        raise PstnRelayError("PSTN relay returned an oversized response")
    try:
        result = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise PstnRelayError("PSTN relay returned invalid JSON") from error
    if not isinstance(result, dict):
        raise PstnRelayError("PSTN relay returned an invalid response")
    return result


def request(base, token, path, *, body=None, idempotency_key=None, timeout=15, response_limit=MAX_RESPONSE_BYTES):
    headers = {"authorization": f"Bearer {token}", "accept": "application/json", "user-agent": "Hermes-PSTN-Relay/1"}
    data = None
    if body is not None:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        headers["content-type"] = "application/json"
        headers["idempotency-key"] = idempotency_key
    call_request = urllib.request.Request(
        f"{base}{path}", data=data, headers=headers, method="POST" if body is not None else "GET"
    )
    opener = urllib.request.build_opener(NoRedirect)
    try:
        with opener.open(call_request, timeout=timeout) as response:
            return read_result(response, response_limit)
    except urllib.error.HTTPError as error:
        try:
            body = read_result(error)
            detail = body.get("error")
        except PstnRelayError:
            detail = None
        detail = detail if isinstance(detail, str) and re.fullmatch(r"[a-z0-9_ -]{1,100}", detail) else "request_failed"
        raise PstnRelayError(f"PSTN relay returned HTTP {error.code}: {detail}") from error
    except urllib.error.URLError as error:
        raise PstnRelayError("PSTN relay is unreachable") from error


def start(args):
    if not E164.fullmatch(args.to):
        raise PstnRelayError("Destination must be an unambiguous E.164 number such as +919876543210")
    briefing = args.briefing.strip()
    if len(briefing) < 10 or len(briefing) > 2000:
        raise PstnRelayError("Call briefing must be 10 to 2000 characters")
    try:
        uuid.UUID(args.idempotency_key)
    except ValueError as error:
        raise PstnRelayError("Idempotency key must be a UUID") from error
    payload = {"to": args.to, "briefing": briefing}
    if args.opening_speech is not None:
        speech = args.opening_speech
        if not speech.strip() or len(speech) > 320 or any(ord(char) < 32 for char in speech):
            raise PstnRelayError("Opening speech must be one nonempty line of at most 320 characters")
        payload["opening_speech"] = speech
    base, token = credentials()
    result = request(base, token, "/v1/pstn-calls", body=payload, idempotency_key=args.idempotency_key)
    if not isinstance(result.get("id"), str) or not isinstance(result.get("status"), str):
        raise PstnRelayError("PSTN relay returned a call without an ID or status")
    return {
        "id": result["id"],
        "status": result["status"],
        "to_number": result.get("to_number"),
        "from_number": result.get("from_number"),
        "created_at": result.get("created_at"),
    }


def safe_text(value, limit):
    if not isinstance(value, str):
        return None
    cleaned = "".join(char for char in " ".join(value.split()) if char.isprintable())
    cleaned = SENSITIVE_DIGITS.sub("[digits omitted]", cleaned)
    return cleaned[:limit] or None


def explicit_status(value, allowed):
    return value if isinstance(value, str) and value in allowed else "unknown"


def status(args, *, timeout=15):
    if not CALL_ID.fullmatch(args.id):
        raise PstnRelayError("Invalid call ID")
    base, token = credentials()
    result = request(base, token, f"/v1/pstn-calls/{urllib.parse.quote(args.id, safe='')}", timeout=timeout)
    if result.get("id") != args.id or not isinstance(result.get("status"), str):
        raise PstnRelayError("PSTN relay returned an invalid call status")
    return {
        "id": result["id"],
        "status": result["status"],
        "to_number": result.get("to_number"),
        "from_number": result.get("from_number"),
        "summary": safe_text(result.get("summary"), 1000),
        "delivery_status": explicit_status(result.get("delivery_status"), DELIVERY_STATUSES),
        "acknowledgement_status": explicit_status(result.get("acknowledgement_status"), ACKNOWLEDGEMENT_STATUSES),
        "outcome_evidence": safe_text(result.get("outcome_evidence"), 500),
        "created_at": result.get("created_at"),
        "ended_at": result.get("ended_at"),
    }


def wait(args):
    if not 1 <= args.timeout_seconds <= MAX_WAIT_SECONDS:
        raise PstnRelayError(f"Wait timeout must be 1 to {MAX_WAIT_SECONDS} seconds")
    if not 1 <= args.poll_seconds <= MAX_POLL_SECONDS:
        raise PstnRelayError(f"Poll interval must be 1 to {MAX_POLL_SECONDS} seconds")
    deadline = time.monotonic() + args.timeout_seconds
    latest = None
    while (remaining := deadline - time.monotonic()) > 0:
        latest = status(args, timeout=min(15, remaining))
        if latest["status"] in TERMINAL_STATUSES:
            return {**latest, "wait_timed_out": False}
        remaining = deadline - time.monotonic()
        if remaining > 0:
            time.sleep(min(args.poll_seconds, remaining))
    if latest is None:
        raise PstnRelayError("Timed out before the PSTN relay returned a call status")
    return {**latest, "wait_timed_out": True}


def inbound_call(result, *, detailed=False):
    if (not isinstance(result, dict) or not isinstance(result.get("id"), str)
            or not CALL_ID.fullmatch(result["id"]) or result.get("direction") != "inbound"
            or not isinstance(result.get("status"), str)):
        raise PstnRelayError("PSTN relay returned an invalid inbound call")
    caller = result.get("caller_number")
    called = result.get("called_number")
    call = {
        "id": result["id"],
        "direction": "inbound",
        "status": result["status"],
        "caller_number": caller if isinstance(caller, str) and E164.fullmatch(caller) else None,
        "caller_identity_verified": False,
        "called_number": called if isinstance(called, str) and E164.fullmatch(called) else None,
        "summary": safe_text(result.get("summary"), 1000),
        "owner_notification_status": result.get("owner_notification_status")
        if result.get("owner_notification_status") in {"pending", "sent"} else None,
        "created_at": result.get("created_at"),
        "ended_at": result.get("ended_at"),
    }
    if detailed:
        call["inbound_report"] = safe_text(result.get("inbound_report"), 500)
        call["source_type"] = "unknown"
    return call


def inbox(_args):
    base, token = credentials()
    result = request(base, token, "/v1/inbound-calls", response_limit=MAX_INBOX_RESPONSE_BYTES)
    calls = result.get("calls")
    if not isinstance(calls, list):
        raise PstnRelayError("PSTN relay returned an invalid inbound inbox")
    return {"calls": [inbound_call(call) for call in calls[:20]], "truncated": len(calls) > 20}


def inbound_status(args):
    if not CALL_ID.fullmatch(args.id):
        raise PstnRelayError("Invalid call ID")
    base, token = credentials()
    result = request(base, token, f"/v1/inbound-calls/{urllib.parse.quote(args.id, safe='')}")
    if result.get("id") != args.id:
        raise PstnRelayError("PSTN relay returned a different inbound call")
    return inbound_call(result, detailed=True)


def main(argv=None):
    parser = argparse.ArgumentParser(description="Place a Codex-only PSTN call or inspect calls through the private relay")
    subcommands = parser.add_subparsers(dest="command", required=True)
    start_parser = subcommands.add_parser("start")
    start_parser.add_argument("--to", required=True)
    start_parser.add_argument("--briefing", required=True)
    start_parser.add_argument("--opening-speech", help="Exact first line to speak after pickup")
    start_parser.add_argument("--idempotency-key", required=True)
    status_parser = subcommands.add_parser("status")
    status_parser.add_argument("--id", required=True)
    wait_parser = subcommands.add_parser("wait", help="Poll one existing call until it ends or the bounded timeout expires")
    wait_parser.add_argument("--id", required=True)
    wait_parser.add_argument("--timeout-seconds", type=int, default=60)
    wait_parser.add_argument("--poll-seconds", type=int, default=5)
    subcommands.add_parser("inbox", help="List recent inbound calls without dialing")
    inbound_parser = subcommands.add_parser("inbound-status", help="Inspect one inbound call without dialing")
    inbound_parser.add_argument("--id", required=True)
    args = parser.parse_args(argv)
    try:
        result = {"start": start, "status": status, "wait": wait,
                  "inbox": inbox, "inbound-status": inbound_status}[args.command](args)
    except PstnRelayError as error:
        print(str(error), file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
