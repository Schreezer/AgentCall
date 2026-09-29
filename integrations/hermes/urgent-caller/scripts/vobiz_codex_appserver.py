"""Isolated Codex App Server client for the Vobiz phone bridge.

The service reads the same Hermes credential pool as the existing Caller voice
connector, but does not depend on or modify the installed connector script.
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import pathlib
import re
import subprocess
import sys
import urllib.error
import urllib.request

MAX_MESSAGE_BYTES = 180_000
DEFAULT_WORKSPACE = "/tmp/caller-codex-voice"
DEFAULT_CODEX_VOICE = "sol"
CODEX_V3_VOICES = frozenset({
    "juniper", "maple", "spruce", "ember", "vale", "breeze", "arbor", "sol", "cove",
})
SUPPORTED_CODEX_SERIES = (0, 158)


def parse_env_file(path: pathlib.Path) -> dict[str, str]:
    if not path.is_file():
        return {}
    values = {}
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, value = line.split("=", 1)
        if re.fullmatch(r"[A-Z][A-Z0-9_]*", name.strip()):
            values[name.strip()] = value.strip().strip('"').strip("'")
    return values


def env_value(name: str, stored: dict[str, str]) -> str:
    return os.environ.get(name, stored.get(name, ""))


def account_id_from_jwt(token: str) -> str | None:
    try:
        encoded = token.split(".")[1]
        body = json.loads(base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4)))
        account = body.get("https://api.openai.com/auth") or {}
        return account.get("chatgpt_account_id") if isinstance(account, dict) else None
    except (IndexError, ValueError, TypeError):
        return None


def codex_version(command: str) -> str | None:
    try:
        result = subprocess.run([command, "--version"], capture_output=True, text=True, timeout=5, check=False)
        match = result.stdout.strip().split()
        return match[-1] if result.returncode == 0 and match else None
    except (OSError, subprocess.SubprocessError):
        return None


def codex_version_supported(value: str | None) -> bool:
    try:
        pieces = tuple(int(piece) for piece in str(value).split("."))
        return len(pieces) == 3 and pieces[:2] == SUPPORTED_CODEX_SERIES
    except (TypeError, ValueError):
        return False


def supported_codex_voice(value) -> str:
    voice = str(value or "").strip().lower()
    return voice if voice in CODEX_V3_VOICES else DEFAULT_CODEX_VOICE


async def http_json(url: str, *, method="GET", token: str, body=None,
                    timeout=15, idempotency_key=None):
    def perform():
        data = json.dumps(body).encode() if body is not None else None
        headers = {
            "authorization": f"Bearer {token}",
            "content-type": "application/json",
            "user-agent": "Caller-Vobiz-Codex-Bridge/0.1.0",
        }
        if idempotency_key:
            headers["idempotency-key"] = idempotency_key
        request = urllib.request.Request(url, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                raw = response.read(65_537)
                if len(raw) > 65_536:
                    raise RuntimeError("relay_response_too_large")
                return response.status, json.loads(raw)
        except urllib.error.HTTPError as error:
            try:
                return error.code, json.loads(error.read(65_536))
            except ValueError:
                return error.code, None
    return await asyncio.to_thread(perform)


class HermesCodexCredentials:
    """Use Hermes's authoritative credential pool and refresh lock."""

    def __init__(self) -> None:
        self.pool = None
        self.entry = None

    def available(self) -> bool:
        try:
            self._select()
            return True
        except Exception:
            return False

    def current(self) -> dict[str, str]:
        entry = self._select()
        token = str(entry.runtime_api_key or "").strip()
        account_id = account_id_from_jwt(token)
        if not token or not account_id:
            raise RuntimeError("codex_not_authenticated")
        return {"accessToken": token, "chatgptAccountId": account_id}

    def refresh(self) -> dict[str, str]:
        entry = self._select()
        refreshed = self.pool._refresh_entry(entry, force=True)
        self.entry = refreshed
        if refreshed is None:
            self.pool = None
            self.entry = None
        return self.current()

    def _select(self):
        if self.entry is not None and self.entry.runtime_api_key:
            return self.entry
        from agent.credential_pool import load_pool

        self.pool = load_pool("openai-codex")
        self.entry = self.pool.select()
        if self.entry is None or not self.entry.runtime_api_key:
            raise RuntimeError("codex_not_authenticated")
        return self.entry


class AppServer:
    def __init__(self, command: str, credentials: HermesCodexCredentials):
        self.command = command
        self.credentials = credentials
        self.process = None
        self.reader_task = None
        self.next_id = 1
        self.pending: dict[int, asyncio.Future] = {}
        self.waiters: list[tuple[str, object, asyncio.Future]] = []
        self.notification_listeners: set[object] = set()
        self.broken = False

    async def start(self) -> None:
        self.process = await asyncio.create_subprocess_exec(
            self.command, "app-server", "--enable", "realtime_conversation", "--listen", "stdio://",
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            limit=MAX_MESSAGE_BYTES + 1024,
        )
        self.reader_task = asyncio.create_task(self._read_loop())
        asyncio.create_task(self._stderr_loop())
        await self.request("initialize", {
            "clientInfo": {"name": "caller_vobiz_bridge", "title": "Caller Vobiz Bridge", "version": "0.1.0"},
            "capabilities": {"experimentalApi": True},
        })
        await self.notify("initialized", {})
        login = await self.request("account/login/start", {
            "type": "chatgptAuthTokens", **self.credentials.current(),
        })
        if not isinstance(login, dict) or login.get("type") != "chatgptAuthTokens":
            raise RuntimeError("codex_not_authenticated")

    async def request(self, method: str, params=None, timeout: float = 35.0):
        if (not self.process or not self.process.stdin or self.process.returncode is not None
                or self.broken or (self.reader_task and self.reader_task.done())):
            raise RuntimeError("codex_app_server_unavailable")
        request_id = self.next_id
        self.next_id += 1
        future = asyncio.get_running_loop().create_future()
        self.pending[request_id] = future
        try:
            await self._write({"method": method, "id": request_id, "params": params or {}})
            return await asyncio.wait_for(future, timeout)
        finally:
            self.pending.pop(request_id, None)

    async def notify(self, method: str, params=None):
        await self._write({"method": method, "params": params or {}})

    def notification_future(self, method: str, predicate):
        future = asyncio.get_running_loop().create_future()
        record = (method, predicate, future)
        self.waiters.append(record)
        future.add_done_callback(lambda _future: self.waiters.remove(record) if record in self.waiters else None)
        return future

    def add_notification_listener(self, listener):
        self.notification_listeners.add(listener)
        return lambda: self.notification_listeners.discard(listener)

    async def close(self):
        if self.process and self.process.returncode is None:
            self.process.terminate()
            try:
                await asyncio.wait_for(self.process.wait(), 5)
            except asyncio.TimeoutError:
                self.process.kill()

    async def _write(self, payload):
        data = (json.dumps(payload, separators=(",", ":")) + "\n").encode()
        if len(data) > MAX_MESSAGE_BYTES:
            raise RuntimeError("codex_message_too_large")
        self.process.stdin.write(data)
        await self.process.stdin.drain()

    async def _read_loop(self):
        try:
            while True:
                line = await self.process.stdout.readline()
                if not line:
                    raise RuntimeError("codex_app_server_unavailable")
                if len(line) > MAX_MESSAGE_BYTES:
                    continue
                try:
                    message = json.loads(line)
                except ValueError:
                    continue
                if "id" in message and ("result" in message or "error" in message):
                    future = self.pending.get(message["id"])
                    if future and not future.done():
                        if message.get("error"):
                            future.set_exception(RuntimeError("codex_app_server_request_failed"))
                        else:
                            future.set_result(message.get("result"))
                elif "id" in message and message.get("method"):
                    asyncio.create_task(self._server_request(message))
                elif message.get("method"):
                    params = message.get("params") or {}
                    for method, predicate, future in list(self.waiters):
                        if method == message["method"] and predicate(params) and not future.done():
                            future.set_result(params)
                    for listener in tuple(self.notification_listeners):
                        try:
                            listener(message["method"], params)
                        except Exception as error:
                            print(f"[caller vobiz] notification listener failed: {type(error).__name__}", file=sys.stderr)
        except Exception as error:
            self.broken = True
            for future in list(self.pending.values()):
                if not future.done():
                    future.set_exception(error)
            for _method, _predicate, future in list(self.waiters):
                if not future.done():
                    future.set_exception(error)
            if self.process and self.process.returncode is None:
                self.process.terminate()

    async def _server_request(self, message):
        try:
            if message["method"] != "account/chatgptAuthTokens/refresh":
                raise RuntimeError("pstn_tools_disabled")
            result = await asyncio.to_thread(self.credentials.refresh)
            await self._write({"id": message["id"], "result": result})
        except Exception:
            await self._write({"id": message["id"], "error": {"code": -32000, "message": "host_request_failed"}})

    async def _stderr_loop(self):
        while self.process and self.process.stderr:
            line = await self.process.stderr.readline()
            if not line:
                return
            print("[caller vobiz codex] " + line.decode(errors="replace").rstrip(), file=sys.stderr)
