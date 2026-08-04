#!/usr/bin/env python3
"""Stable, app-pinned bootstrap for the signed urgent-caller updater."""

import argparse
import base64
import hashlib
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import urllib.parse
import urllib.request

TRUSTED_RELEASE_PUBLIC_KEY = """-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA0PXJ6vcqM8/U55Og/X1tPEq4zJk2WwYfiGbeGNTGW9g=
-----END PUBLIC KEY-----"""
USER_AGENT = "AgentCall-Hermes/bootstrap-1"


def canonical_json(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode()


def parse_env_file(path):
    values = {}
    if not path.exists():
        return values
    for raw_line in path.read_text().splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        if key in {"CALLER_RELAY_URL", "CALLER_AGENT_TOKEN"}:
            values[key] = value.strip().strip('"').strip("'")
    return values


def request_bytes(url, token, max_bytes):
    request = urllib.request.Request(
        url,
        headers={"authorization": f"Bearer {token}", "user-agent": USER_AGENT},
    )
    with urllib.request.urlopen(request, timeout=20) as response:
        content = response.read(max_bytes + 1)
        if len(content) > max_bytes:
            raise RuntimeError("Caller release response exceeds the allowed size")
        return content


def verify_manifest(manifest, signature, root):
    manifest_path = root / "manifest.json"
    signature_path = root / "manifest.sig"
    public_key_path = root / "release-public-key.pem"
    manifest_path.write_bytes(canonical_json(manifest))
    signature_path.write_bytes(base64.b64decode(signature, validate=True))
    public_key_path.write_text(TRUSTED_RELEASE_PUBLIC_KEY)
    result = subprocess.run(
        [
            "openssl", "pkeyutl", "-verify", "-pubin", "-inkey", str(public_key_path),
            "-sigfile", str(signature_path), "-rawin", "-in", str(manifest_path),
        ],
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError("release manifest signature verification failed")


def main():
    parser = argparse.ArgumentParser(description="Bootstrap the signed urgent-caller skill")
    parser.add_argument("--relay-url")
    parser.add_argument("--env-file", default=os.path.expanduser("~/.hermes/.env"))
    parser.add_argument("--skill-dir", default=os.path.expanduser("~/.hermes/skills/urgent-caller"))
    parser.add_argument("--approve-capability-update", action="store_true")
    args = parser.parse_args()

    env_path = pathlib.Path(args.env_file).expanduser()
    stored = parse_env_file(env_path)
    relay_url = (args.relay_url or os.environ.get("CALLER_RELAY_URL") or stored.get("CALLER_RELAY_URL", "")).rstrip("/")
    token = os.environ.get("CALLER_AGENT_TOKEN") or stored.get("CALLER_AGENT_TOKEN", "")
    if not relay_url or not token:
        print("Caller is not paired. CALLER_RELAY_URL and CALLER_AGENT_TOKEN are required.", file=sys.stderr)
        return 2

    try:
        with tempfile.TemporaryDirectory(prefix="caller-bootstrap-") as temporary:
            root = pathlib.Path(temporary)
            envelope = json.loads(
                request_bytes(
                    f"{relay_url}/v1/agent-package/urgent-caller/manifest",
                    token,
                    262_144,
                ).decode()
            )
            manifest = envelope["manifest"]
            verify_manifest(manifest, envelope["signature"], root)
            if manifest.get("skill_name") != "urgent-caller" or manifest.get("schema_version") != 1:
                raise RuntimeError("unsupported Caller release manifest")
            approval_required = bool(manifest.get("requires_user_approval")) or manifest.get("change_class") != "compatible"
            if approval_required and not args.approve_capability_update:
                print("The current Caller release expands capabilities and requires explicit approval.", file=sys.stderr)
                return 3
            updater = next(
                (entry for entry in manifest.get("files", []) if entry.get("path") == "scripts/update.py"),
                None,
            )
            if not updater:
                raise RuntimeError("release manifest does not contain scripts/update.py")
            if not isinstance(updater.get("size"), int) or not 0 < updater["size"] <= 1_000_000:
                raise RuntimeError("release manifest contains an invalid updater size")
            version = urllib.parse.quote(manifest["skill_version"], safe="")
            updater_url = f"{relay_url}/v1/agent-package/urgent-caller/files/{version}/scripts/update.py"
            updater_bytes = request_bytes(updater_url, token, updater["size"])
            if len(updater_bytes) != updater["size"] or hashlib.sha256(updater_bytes).hexdigest() != updater["sha256"]:
                raise RuntimeError("signed updater digest verification failed")
            updater_path = root / "update.py"
            updater_path.write_bytes(updater_bytes)
            command = [
                sys.executable,
                str(updater_path),
                "--relay-url", relay_url,
                "--env-file", str(env_path),
                "--skill-dir", str(pathlib.Path(args.skill_dir).expanduser()),
            ]
            if args.approve_capability_update:
                command.append("--approve-capability-update")
            return subprocess.run(command, check=False).returncode
    except Exception as error:
        print(f"Caller bootstrap failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
