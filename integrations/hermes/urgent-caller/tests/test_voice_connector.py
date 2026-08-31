import asyncio
import base64
import importlib.util
import json
import os
import pathlib
import tempfile
import types
import unittest
from unittest import mock


SCRIPT = pathlib.Path(__file__).parents[1] / "scripts" / "voice_connector.py"
SPEC = importlib.util.spec_from_file_location("caller_voice_connector", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def jwt(account_id="acct-test"):
    encoded = base64.urlsafe_b64encode(json.dumps({
        "https://api.openai.com/auth": {"chatgpt_account_id": account_id},
    }).encode()).decode().rstrip("=")
    return f"header.{encoded}.signature"


class FakeEntry:
    def __init__(self, token):
        self.runtime_api_key = token


class VoiceConnectorTests(unittest.TestCase):
    def test_extracts_account_without_exposing_the_token(self):
        token = jwt()
        self.assertEqual(MODULE.account_id_from_jwt(token), "acct-test")
        credentials = MODULE.HermesCodexCredentials()
        credentials.entry = FakeEntry(token)
        self.assertEqual(credentials.current(), {
            "accessToken": token,
            "chatgptAccountId": "acct-test",
        })

    def test_forced_refresh_uses_the_selected_hermes_pool_entry(self):
        old = FakeEntry(jwt("old"))
        new = FakeEntry(jwt("new"))
        pool = mock.Mock()
        pool._refresh_entry.return_value = new
        credentials = MODULE.HermesCodexCredentials()
        credentials.pool = pool
        credentials.entry = old
        self.assertEqual(credentials.refresh()["chatgptAccountId"], "new")
        pool._refresh_entry.assert_called_once_with(old, force=True)

    def test_ready_message_contains_only_sanitized_capabilities(self):
        connector = MODULE.Connector("https://relay.example", "agent-secret", {"XAI_API_KEY": "xai-secret"})
        connector.credentials.available = mock.Mock(return_value=True)
        with mock.patch.object(MODULE.shutil, "which", return_value="/bin/sh"), \
             mock.patch.object(MODULE, "codex_version", return_value="0.150.1"):
            ready = connector.ready()
        self.assertEqual(ready["providers"], {"codex": True, "xai": True})
        self.assertEqual(ready["preferred_provider"], "codex")
        self.assertNotIn("agent-secret", json.dumps(ready))
        self.assertNotIn("xai-secret", json.dumps(ready))

    def test_codex_is_preferred_and_only_the_sdp_is_returned(self):
        connector = MODULE.Connector("https://relay.example", "agent-secret", {"XAI_API_KEY": "xai-secret"})
        connector.capabilities = mock.Mock(return_value={"codex": True, "xai": True})
        connector.codex.start = mock.AsyncMock(return_value="v=0\r\nanswer")
        request = {
            "protocol": 1,
            "request_id": "request-1",
            "type": "voice.session.start",
            "session_id": "session-1",
            "offer_sdp": "v=0\r\noffer",
            "instructions": "Speak naturally.",
            "opening_speech": "Did you take your omega-3 supplement today?",
            "tool_token": "t" * 32,
        }
        result = asyncio.run(connector.handle(request))
        self.assertEqual(result, {
            "type": "voice.session.result",
            "request_id": "request-1",
            "ok": True,
            "provider": "codex",
            "answer_sdp": "v=0\r\nanswer",
        })
        self.assertNotIn("tool_token", result)

    def test_prepare_starts_codex_before_the_phone_rings(self):
        connector = MODULE.Connector("https://relay.example", "agent-secret", {})
        connector.capabilities = mock.Mock(return_value={"codex": True, "xai": False})
        connector.codex.prepare = mock.AsyncMock()
        message = {
            "protocol": 1,
            "request_id": "request-prepare",
            "type": "voice.session.prepare",
            "prepare_id": "call-1",
        }
        result = asyncio.run(connector.handle(message))
        self.assertEqual(result, {
            "type": "voice.session.result",
            "request_id": "request-prepare",
            "ok": True,
            "provider": "codex",
        })
        connector.codex.prepare.assert_awaited_once_with("call-1")

    def test_answer_signal_is_forwarded_once_to_the_codex_session(self):
        connector = MODULE.Connector("https://relay.example", "agent-secret", {})
        connector.codex.answer = mock.AsyncMock()
        message = {
            "protocol": 1,
            "request_id": "request-answer",
            "type": "voice.session.answer",
            "session_id": "session-1",
        }
        result = asyncio.run(connector.handle(message))
        self.assertEqual(result, {
            "type": "voice.session.result",
            "request_id": "request-answer",
            "ok": True,
        })
        connector.codex.answer.assert_awaited_once_with("session-1")

    def test_codex_pickup_appends_context_then_speaks_through_live_model(self):
        voice = MODULE.CodexVoice("codex", mock.Mock(), "https://relay.example")
        voice.app = mock.Mock()
        voice.app.request = mock.AsyncMock()
        voice.sessions["session-1"] = {
            "thread_id": "thread-1",
            "tool_token": "tool-token",
            "opening_speech": "Did you take your omega-3 supplement today?",
            "cursor": 0,
            "answered": False,
        }
        asyncio.run(voice.answer("session-1"))
        self.assertEqual(voice.app.request.await_count, 2)
        context_method, context_params = voice.app.request.await_args_list[0].args
        speech_method, speech_params = voice.app.request.await_args_list[1].args
        self.assertEqual(context_method, "thread/realtime/appendText")
        self.assertEqual(context_params["role"], "user")
        self.assertIn("user answered the phone", context_params["text"])
        self.assertEqual(speech_method, "thread/realtime/appendSpeech")
        self.assertEqual(speech_params, {
            "threadId": "thread-1",
            "text": "Did you take your omega-3 supplement today?",
        })
        self.assertNotIn("response.create", repr(voice.app.request.await_args_list))
        self.assertTrue(voice.sessions["session-1"]["answered"])

    def test_relay_http_calls_use_the_connector_identity(self):
        response = mock.MagicMock()
        response.status = 200
        response.read.return_value = b'{"ok":true}'
        response.__enter__.return_value = response
        with mock.patch.object(MODULE.urllib.request, "urlopen", return_value=response) as urlopen:
            status, payload = asyncio.run(MODULE.http_json(
                "https://relay.example/v1/codex-tools/session/events",
                token="tool-secret",
            ))
        request = urlopen.call_args.args[0]
        self.assertEqual(request.get_header("User-agent"), f"Caller-Hermes-Connector/{MODULE.SKILL_VERSION}")
        self.assertEqual(status, 200)
        self.assertEqual(payload, {"ok": True})

    def test_dynamic_tool_rules_are_colocated_with_the_tools(self):
        ask_hermes, check_task = MODULE.hermes_tools()
        self.assertIn("stable independent_context", ask_hermes["description"])
        self.assertIn("results arrive as caller_hermes_event", ask_hermes["description"])
        self.assertIn("event delivery failed", check_task["description"])

    def test_hermes_event_contains_only_event_time_guidance(self):
        message = MODULE.hermes_event({"operation_id": "voiceop_" + "a" * 32, "status": "completed"})
        self.assertIn("Direct approvals to Caller", message)
        self.assertIn("Keep raw JSON and IDs private", message)
        self.assertNotIn("context_scope", message)

    def test_codex_v3_voice_rejects_stale_values(self):
        self.assertEqual(MODULE.supported_codex_voice("spruce"), "spruce")
        self.assertEqual(MODULE.supported_codex_voice("cedar"), "sol")
        self.assertEqual(MODULE.supported_codex_voice(None), "sol")

    def test_rejects_codex_versions_with_incompatible_realtime_shape(self):
        self.assertFalse(MODULE.codex_version_supported("0.149.1"))
        self.assertTrue(MODULE.codex_version_supported("0.150.1"))
        self.assertTrue(MODULE.codex_version_supported("0.151.0"))
        self.assertFalse(MODULE.codex_version_supported(None))

    def test_installer_adds_persistent_signed_update_timer(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = pathlib.Path(temporary)
            env_file = home / ".hermes" / ".env"
            env_file.parent.mkdir()
            env_file.write_text("CALLER_RELAY_URL=https://relay.example\nCALLER_AGENT_TOKEN=test\n")
            script = home / ".hermes" / "skills" / "urgent-caller" / "scripts" / "voice_connector.py"
            script.parent.mkdir(parents=True)
            script.write_text("")
            hermes_python = home / ".hermes" / "hermes-agent" / "venv" / "bin" / "python"
            hermes_python.parent.mkdir(parents=True)
            hermes_python.write_text("")
            owner = types.SimpleNamespace(pw_dir=str(home), pw_name="caller-test", pw_gid=os.getgid())
            group = types.SimpleNamespace(gr_name="caller-test")
            completed = types.SimpleNamespace(returncode=0)
            with mock.patch.object(MODULE.subprocess, "run", return_value=completed) as run, \
                 mock.patch.object(MODULE.pwd, "getpwuid", return_value=owner), \
                 mock.patch.object(MODULE.grp, "getgrgid", return_value=group), \
                 mock.patch.object(MODULE.sys, "executable", "/opt/hermes/venv/bin/python"):
                self.assertEqual(MODULE.install_service(script, env_file), 0)
            unit_dir = home / ".config" / "systemd" / "user"
            connector = (unit_dir / "caller-voice-connector.service").read_text()
            update = (unit_dir / "caller-skill-update.service").read_text()
            timer = (unit_dir / "caller-skill-update.timer").read_text()
            self.assertIn(f"{home}/.local/bin", connector)
            self.assertIn(f'ExecStart="{hermes_python}"', connector)
            self.assertIn("scripts/update.py", update)
            self.assertIn("Persistent=true", timer)
            self.assertIn("RandomizedDelaySec=45m", timer)
            calls = [call.args[0] for call in run.call_args_list]
            self.assertIn(["systemctl", "--user", "enable", "--now", "caller-skill-update.timer"], calls)


if __name__ == "__main__":
    unittest.main()
