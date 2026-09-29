import base64
import hashlib
import hmac
import json
import pathlib
import sys
import time
import unittest


sys.path.insert(0, str(pathlib.Path(__file__).parents[1] / "scripts"))
import vobiz_codex_bridge as bridge  # noqa: E402


SECRET = "test-secret" * 5


def signed_token(payload):
    encoded = base64.urlsafe_b64encode(json.dumps(payload, separators=(",", ":")).encode()).decode().rstrip("=")
    signature = base64.urlsafe_b64encode(hmac.new(SECRET.encode(), encoded.encode(), hashlib.sha256).digest()).decode().rstrip("=")
    return encoded + "." + signature


class VobizBridgeTests(unittest.TestCase):
    def token(self, **overrides):
        payload = {"v": 1, "id": "call-test", "exp": int(time.time()) + 90, "direction": "outbound"}
        payload.update(overrides)
        return signed_token(payload)

    def test_signed_token_validates_expiry_direction_and_signature(self):
        self.assertEqual(bridge.verify_stream_token(self.token(), SECRET)["id"], "call-test")
        with self.assertRaises(ValueError):
            bridge.verify_stream_token(self.token() + "x", SECRET)
        with self.assertRaises(ValueError):
            bridge.verify_stream_token(self.token(exp=int(time.time()) - 1), SECRET)
        with self.assertRaises(ValueError):
            bridge.verify_stream_token(self.token(direction="other"), SECRET)
        with self.assertRaises(ValueError):
            bridge.verify_stream_token(self.token(exp=int(time.time()) + 600), SECRET)

    def test_opening_discloses_ai_speaker_without_changing_approved_line(self):
        approved = "Hi Chirag, this is your Hermes AI agent. How are you doing?"
        self.assertEqual(bridge.disclosed_opening(approved), approved)
        misleading = "I'm calling about your AI subscription. How are you?"
        self.assertTrue(bridge.disclosed_opening(misleading).startswith("Hello, I'm an AI assistant"))

    def test_one_active_outbound_call_and_no_inbound_rollout(self):
        service = bridge.VobizCodexBridge(
            relay_url="https://relay.example", agent_token="a" * 40,
            stream_secret=SECRET, codex_command="codex",
        )
        first = bridge.verify_stream_token(self.token(), SECRET)
        service.claim(first)
        with self.assertRaisesRegex(ValueError, "bridge_busy"):
            service.claim(bridge.verify_stream_token(self.token(id="other-call"), SECRET))
        service.active_calls.clear()
        with self.assertRaisesRegex(ValueError, "replayed_stream_token"):
            service.claim(first)
        with self.assertRaisesRegex(ValueError, "inbound_not_enabled"):
            service.claim(bridge.verify_stream_token(self.token(id="inbound", direction="inbound"), SECRET))

    def test_health_rejects_dead_app_reader_or_unverified_webrtc(self):
        service = bridge.VobizCodexBridge(
            relay_url="https://relay.example", agent_token="a" * 40,
            stream_secret=SECRET, codex_command="codex",
        )
        class Reader:
            failed = False

            def done(self):
                return self.failed

        class Process:
            returncode = None

        class App:
            process = Process()
            reader_task = Reader()
            broken = False

        service.app = App()
        self.assertFalse(service.codex_ready)
        service.webrtc_verified = True
        self.assertTrue(service.codex_ready)
        service.app.reader_task.failed = True
        self.assertFalse(service.codex_ready)

    def test_decodes_vobiz_l16_and_mulaw_with_declared_format(self):
        pcm = b"\x34\x12\x78\x56"
        self.assertEqual(bridge.decode_vobiz_audio(base64.b64encode(b"\x12\x34\x56\x78").decode(), "audio/x-l16", 16000), pcm)
        self.assertEqual(bridge.decode_vobiz_audio(base64.b64encode(pcm).decode(), "audio/x-l16", 16000, "little"), pcm)
        silence = bridge.decode_vobiz_audio(base64.b64encode(b"\xff\xff").decode(), "audio/x-mulaw", 8000)
        self.assertEqual(silence, b"\x00\x00\x00\x00")
        with self.assertRaises(ValueError):
            bridge.decode_vobiz_audio("not base64!", "audio/x-l16", 16000)
        with self.assertRaises(ValueError):
            bridge.decode_vobiz_audio(base64.b64encode(pcm).decode(), "audio/x-l16", 24000)

    def test_relay_context_requires_matching_call_and_outbound_brief(self):
        service = bridge.VobizCodexBridge(
            relay_url="https://relay.example", agent_token="a" * 40,
            stream_secret=SECRET, codex_command="codex",
        )

        async def check():
            from unittest import mock
            with mock.patch.object(bridge, "http_json", new=mock.AsyncMock(return_value=(200, {
                "id": "call-test", "direction": "outbound", "instructions": "Call Chirag.",
                "opening_speech": "Hello.", "vobiz_call_id": "provider-id",
            }))):
                self.assertEqual((await service.context("call-test", "outbound"))["vobiz_call_id"], "provider-id")
            with mock.patch.object(bridge, "http_json", new=mock.AsyncMock(return_value=(200, {
                "id": "wrong", "direction": "outbound", "instructions": "Call Chirag.",
                "opening_speech": "Hello.",
            }))):
                with self.assertRaisesRegex(RuntimeError, "bridge_context_mismatch"):
                    await service.context("call-test", "outbound")

        import asyncio
        asyncio.run(check())

    def test_lifecycle_report_retries_with_stable_idempotency_key(self):
        async def check():
            from unittest import mock

            service = bridge.VobizCodexBridge(
                relay_url="https://relay.example", agent_token="a" * 40,
                stream_secret=SECRET, codex_command="codex",
            )
            responses = mock.AsyncMock(side_effect=[(503, {}), (200, {"ok": True})])
            with mock.patch.object(bridge, "http_json", responses), \
                    mock.patch.object(bridge.asyncio, "sleep", new=mock.AsyncMock()):
                self.assertTrue(await service.report("call-test", "connected"))
            self.assertEqual(responses.await_count, 2)
            self.assertEqual(
                responses.await_args_list[0].kwargs["idempotency_key"],
                responses.await_args_list[1].kwargs["idempotency_key"],
            )

        import asyncio
        asyncio.run(check())

    def test_final_stop_waits_for_checkpoint_playback_ack(self):
        async def check():
            import asyncio

            class Socket:
                def __init__(self):
                    self.events = []

                async def send(self, raw):
                    self.events.append(json.loads(raw))

            socket = Socket()
            session = bridge.CodexPSTNSession(None, socket, "stream-test", {}, None)
            session._playing = True
            stopping = asyncio.create_task(session.finish_playback_and_stop())
            await asyncio.sleep(0.35)
            self.assertEqual([event["event"] for event in socket.events], ["checkpoint"])
            session.played_checkpoint(socket.events[0]["name"])
            await asyncio.wait_for(stopping, timeout=1)
            self.assertEqual([event["event"] for event in socket.events], ["checkpoint", "stop"])

            session._playing = True
            await session.interrupt_playback()
            self.assertTrue(session._clear_pending)
            self.assertEqual(socket.events[-1]["event"], "clearAudio")
            session.cleared_audio()
            self.assertFalse(session._clear_pending)

        import asyncio
        asyncio.run(check())


if __name__ == "__main__":
    unittest.main()
