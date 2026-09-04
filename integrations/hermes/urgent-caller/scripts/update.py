#!/usr/bin/env python3
"""Verify and atomically install the managed urgent-caller skill release."""

import argparse
import base64
import hashlib
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

SKILL_NAME = "urgent-caller"
CURRENT_VERSION = "0.5.19"
USER_AGENT = f"AgentCall-Hermes/{CURRENT_VERSION}"
TRUSTED_RELEASE_PUBLIC_KEY = """-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA0PXJ6vcqM8/U55Og/X1tPEq4zJk2WwYfiGbeGNTGW9g=
-----END PUBLIC KEY-----"""


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


def version_tuple(value):
    pieces = str(value).split(".")
    if len(pieces) != 3 or any(not piece.isdigit() for piece in pieces):
        raise ValueError(f"invalid semantic version: {value}")
    return tuple(int(piece) for piece in pieces)


def safe_relative_path(value):
    path = pathlib.PurePosixPath(str(value))
    if path.is_absolute() or not path.parts or any(part in {"", ".", ".."} for part in path.parts):
        raise ValueError(f"unsafe release path: {value}")
    return path


def request_bytes(url, token, timeout=20, max_bytes=1_000_000):
    request = urllib.request.Request(
        url,
        headers={
            "authorization": f"Bearer {token}",
            "accept": "application/json, application/octet-stream",
            "user-agent": USER_AGENT,
            "x-caller-skill-version": CURRENT_VERSION,
        },
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        content = response.read(max_bytes + 1)
        if len(content) > max_bytes:
            raise RuntimeError("Caller release response exceeds the allowed size")
        return content


def verify_signature(manifest, signature):
    with tempfile.TemporaryDirectory(prefix="caller-signature-") as temporary:
        root = pathlib.Path(temporary)
        manifest_path = root / "manifest.json"
        signature_path = root / "manifest.sig"
        public_key_path = root / "release-public-key.pem"
        manifest_path.write_bytes(canonical_json(manifest))
        signature_path.write_bytes(base64.b64decode(signature, validate=True))
        public_key_path.write_text(TRUSTED_RELEASE_PUBLIC_KEY)
        result = subprocess.run(
            [
                "openssl",
                "pkeyutl",
                "-verify",
                "-pubin",
                "-inkey",
                str(public_key_path),
                "-sigfile",
                str(signature_path),
                "-rawin",
                "-in",
                str(manifest_path),
            ],
            capture_output=True,
            check=False,
            text=True,
        )
    if result.returncode != 0:
        raise RuntimeError("release manifest signature verification failed")


def installed_version(skill_dir):
    state_path = skill_dir / ".caller-release.json"
    if state_path.exists():
        try:
            return json.loads(state_path.read_text()).get("skill_version", "0.0.0")
        except (OSError, ValueError, TypeError):
            pass
    return "0.0.0"


def validate_manifest(manifest):
    if manifest.get("schema_version") != 1 or manifest.get("skill_name") != SKILL_NAME:
        raise ValueError("unsupported Caller release manifest")
    version_tuple(manifest.get("skill_version"))
    version_tuple(manifest.get("minimum_supported_version"))
    files = manifest.get("files")
    if not isinstance(files, list) or not files or len(files) > 32:
        raise ValueError("release manifest contains no files")
    seen = set()
    for entry in files:
        if not isinstance(entry, dict) or not isinstance(entry.get("path"), str):
            raise ValueError("release contains an invalid file entry")
        path = str(safe_relative_path(entry.get("path")))
        if path in seen:
            raise ValueError(f"duplicate release path: {path}")
        seen.add(path)
        if not isinstance(entry.get("size"), int) or not 0 <= entry["size"] <= 1_000_000:
            raise ValueError(f"invalid release size: {path}")
        if not isinstance(entry.get("sha256"), str) or len(entry["sha256"]) != 64:
            raise ValueError(f"invalid release digest: {path}")
    required = {
        "SKILL.md",
        "scripts/call.py",
        "scripts/pair.py",
        "scripts/update.py",
        "scripts/voice_connector.py",
    }
    if not required.issubset(seen):
        raise ValueError("release is missing required skill files")


def download_release(relay_url, token, manifest, stage):
    version = manifest["skill_version"]
    for entry in manifest["files"]:
        relative = safe_relative_path(entry["path"])
        encoded_path = "/".join(urllib.parse.quote(part, safe="") for part in relative.parts)
        url = f"{relay_url}/v1/agent-package/{SKILL_NAME}/files/{version}/{encoded_path}"
        content = request_bytes(url, token, max_bytes=entry["size"])
        if len(content) != entry["size"]:
            raise RuntimeError(f"release size mismatch: {relative}")
        if hashlib.sha256(content).hexdigest() != entry["sha256"]:
            raise RuntimeError(f"release digest mismatch: {relative}")
        destination = stage.joinpath(*relative.parts)
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(content)
        destination.chmod(0o755 if destination.suffix == ".py" else 0o644)


def self_test(stage):
    skill_text = (stage / "SKILL.md").read_text()
    if not skill_text.startswith("---\n") or "name: urgent-caller" not in skill_text[:500]:
        raise RuntimeError("staged skill metadata is invalid")
    for script_name in ("call.py", "pair.py", "update.py", "voice_connector.py"):
        result = subprocess.run(
            [sys.executable, str(stage / "scripts" / script_name), "--help"],
            capture_output=True,
            check=False,
            text=True,
            timeout=15,
        )
        if result.returncode != 0:
            raise RuntimeError(f"staged {script_name} self-test failed")


def remove_path(path):
    if not path.exists() and not path.is_symlink():
        return
    if path.is_dir() and not path.is_symlink():
        shutil.rmtree(path)
    else:
        path.unlink()


def rollback_dir_for(skill_dir):
    return skill_dir.parent.parent / ".caller-skill-rollbacks" / skill_dir.parent.name / skill_dir.name


def activate(stage, skill_dir, manifest):
    state = {
        "skill_name": SKILL_NAME,
        "skill_version": manifest["skill_version"],
        "manifest_sha256": hashlib.sha256(canonical_json(manifest)).hexdigest(),
        "installed_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    (stage / ".caller-release.json").write_text(json.dumps(state, indent=2, sort_keys=True) + "\n")
    (stage / ".caller-release.json").chmod(0o644)

    # Hermes discovers SKILL.md files recursively inside its skills directory,
    # including hidden directories. Keep the rollback outside that tree so the
    # retained copy cannot collide with the active skill.
    previous = rollback_dir_for(skill_dir)
    previous.parent.mkdir(parents=True, exist_ok=True)
    previous.parent.chmod(0o700)
    remove_path(previous)

    # Migrate the rollback location used by Caller 0.4.0. Leaving this directory
    # in place makes Hermes see two skills named urgent-caller.
    legacy_previous = skill_dir.with_name(f".{skill_dir.name}.previous")
    remove_path(legacy_previous)

    if skill_dir.exists():
        skill_dir.rename(previous)
    try:
        stage.rename(skill_dir)
    except Exception:
        if previous.exists() and not skill_dir.exists():
            previous.rename(skill_dir)
        raise


def restart_voice_connector():
    # The glob also matches per-profile connector units (caller-voice-connector-<profile>.service).
    commands = [["systemctl", "--user", "try-restart", "caller-voice-connector.service", "caller-voice-connector-*.service"]]
    if os.geteuid() == 0:
        commands.append(["systemctl", "try-restart", "caller-voice-connector.service", "caller-voice-connector-*.service"])
    for command in commands:
        try:
            subprocess.run(command, capture_output=True, check=False, timeout=15)
        except (OSError, subprocess.SubprocessError):
            pass


def main():
    parser = argparse.ArgumentParser(description="Check and install signed urgent-caller skill releases")
    parser.add_argument("--relay-url")
    parser.add_argument("--env-file", default=os.path.expanduser("~/.hermes/.env"))
    parser.add_argument("--skill-dir", default=os.path.expanduser("~/.hermes/skills/urgent-caller"))
    parser.add_argument("--check-only", action="store_true")
    parser.add_argument("--approve-capability-update", action="store_true")
    args = parser.parse_args()

    env_path = pathlib.Path(args.env_file).expanduser()
    stored = parse_env_file(env_path)
    relay_url = (args.relay_url or os.environ.get("CALLER_RELAY_URL") or stored.get("CALLER_RELAY_URL", "")).rstrip("/")
    token = os.environ.get("CALLER_AGENT_TOKEN") or stored.get("CALLER_AGENT_TOKEN", "")
    if not relay_url or not token:
        print("Caller is not paired. CALLER_RELAY_URL and CALLER_AGENT_TOKEN are required.", file=sys.stderr)
        return 2

    skill_dir = pathlib.Path(args.skill_dir).expanduser().resolve()
    if skill_dir.name != SKILL_NAME or skill_dir.parent == skill_dir:
        print("The skill directory must end in /urgent-caller.", file=sys.stderr)
        return 2

    try:
        payload = json.loads(request_bytes(
            f"{relay_url}/v1/agent-package/{SKILL_NAME}/manifest",
            token,
            max_bytes=262_144,
        ).decode())
        manifest = payload["manifest"]
        validate_manifest(manifest)
        verify_signature(manifest, payload["signature"])
        current = installed_version(skill_dir)
        latest = manifest["skill_version"]
        if version_tuple(current) >= version_tuple(latest):
            print(json.dumps({"status": "current", "installed_version": current, "latest_version": latest}))
            return 0
        approval_required = bool(manifest.get("requires_user_approval")) or manifest.get("change_class") != "compatible"
        if approval_required and not args.approve_capability_update:
            print(json.dumps({
                "status": "approval_required",
                "installed_version": current,
                "latest_version": latest,
                "release_notes": manifest.get("release_notes", ""),
            }))
            return 3
        if args.check_only:
            print(json.dumps({"status": "update_available", "installed_version": current, "latest_version": latest}))
            return 0

        skill_dir.parent.mkdir(parents=True, exist_ok=True)
        stage = pathlib.Path(tempfile.mkdtemp(prefix=f".{SKILL_NAME}.stage-", dir=skill_dir.parent))
        try:
            download_release(relay_url, token, manifest, stage)
            self_test(stage)
            activate(stage, skill_dir, manifest)
            restart_voice_connector()
        finally:
            if stage.exists():
                shutil.rmtree(stage)
        print(json.dumps({"status": "updated", "installed_version": latest, "previous_version": current}))
        return 0
    except (KeyError, ValueError, OSError, RuntimeError, subprocess.SubprocessError, urllib.error.URLError) as error:
        print(f"Caller skill update failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
