"""Outbound pre-dial Codex Live preparation and release boundaries."""

import asyncio
import base64
import hashlib
import hmac
import json
import pathlib
import struct
import sys
import tempfile
import types
import unittest
import urllib.request
from unittest import mock


sys.path.insert(0, str(pathlib.Path(__file__).parents[1] / "scripts"))
import vobiz_codex_bridge as bridge  # noqa: E402


SECRET = "test-secret" * 5
CALL_ID = "e63e26f5-2739-4ee0-b21f-b6ce02d03f18"
PROVIDER_CALL_ID = "bb3a0bc5-5d9e-4b42-b4e7-4142cc1c2533"


def signed_token(payload):
    encoded = base64.urlsafe_b64encode(json.dumps(payload, separators=(",", ":")).encode()).decode().rstrip("=")
    signature = base64.urlsafe_b64encode(
        hmac.new(SECRET.encode(), encoded.encode(), hashlib.sha256).digest()
    ).decode().rstrip("=")
    return encoded + "." + signature


def action_token(action="prepare", **overrides):
    payload = {
        "v": 2, "id": CALL_ID, "exp": int(bridge.time.time()) + 90,
        "direction": "outbound", "action": action,
    }
    payload.update(overrides)
    return signed_token(payload)


class FakePreparedSession:
    def __init__(self):
        self.closed = 0

    async def close(self):
        self.closed += 1


class VobizPrewarmTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.spool_dir = temporary.name

    def service(self):
        return bridge.VobizCodexBridge(
            relay_url="https://relay.example", agent_token="a" * 40,
            stream_secret=SECRET, codex_command="codex",
            spool_dir=self.spool_dir,
        )

    def test_action_token_is_distinct_from_stream_and_bound_to_action_and_call(self):
        payload = bridge.verify_action_token(action_token(), SECRET, "prepare", CALL_ID)
        self.assertEqual(payload["action"], "prepare")
        invalid = [
            action_token() + "x", action_token("cancel"),
            action_token(id="another-call"), action_token(direction="inbound"),
            action_token(v=1), action_token(exp=int(bridge.time.time()) - 1),
            action_token(exp=int(bridge.time.time()) + 600),
            signed_token({
                "v": 1, "id": CALL_ID, "exp": int(bridge.time.time()) + 90,
                "direction": "outbound",
            }),
        ]
        for token in invalid:
            with self.subTest(token=token[:12]), self.assertRaises(ValueError):
                bridge.verify_action_token(token, SECRET, "prepare", CALL_ID)

    def test_health_distinguishes_runtime_liveness_from_call_capacity(self):
        async def check():
            service = self.service()

            class Reader:
                def done(self):
                    return False

            service.app = types.SimpleNamespace(
                process=types.SimpleNamespace(returncode=None),
                reader_task=Reader(), broken=False,
            )
            service.webrtc_verified = True
            service.prepared_calls[CALL_ID] = object()

            class Connection:
                def respond(self, status, body):
                    return status, json.loads(body)

            status, body = await service.process_request(
                Connection(), types.SimpleNamespace(path="/health")
            )
            self.assertEqual(status, 200)
            self.assertTrue(body["runtime_ready"])
            self.assertFalse(body["codex_ready"])
            service.prepared_calls.clear()
            self.assertTrue(service.codex_ready)
            service.active_calls.add(CALL_ID)
            self.assertTrue(service.runtime_ready)
            self.assertFalse(service.codex_ready)

        asyncio.run(check())

    def test_post_connect_webrtc_failure_invalidates_prepared_session(self):
        async def check():
            class Track:
                kind = "audio"

                async def recv(self):
                    await asyncio.Event().wait()

            class Peer:
                def __init__(self):
                    self.handlers = {}
                    self.connectionState = "new"
                    self.localDescription = None

                def on(self, name):
                    def register(callback):
                        self.handlers[name] = callback
                        return callback
                    return register

                def addTrack(self, _track):
                    pass

                async def createOffer(self):
                    return object()

                async def setLocalDescription(self, _offer):
                    self.localDescription = types.SimpleNamespace(sdp="v=0\r\nlocal")

                async def setRemoteDescription(self, _answer):
                    self.handlers["track"](Track())
                    self.connectionState = "connected"
                    self.handlers["connectionstatechange"]()

                async def close(self):
                    self.connectionState = "closed"
                    self.handlers["connectionstatechange"]()

            class App:
                async def request(self, method, _params, **_kwargs):
                    if method == "thread/start":
                        return {"model": "gpt-6-sol", "thread": {
                            "id": "sol-thread", "model": "gpt-6-sol", "modelProvider": "openai",
                        }}
                    return {}

                def add_notification_listener(self, _listener):
                    return lambda: None

                def notification_future(self, _method, _predicate):
                    result = asyncio.get_running_loop().create_future()
                    result.set_result({"sdp": "v=0\r\nremote"})
                    return result

            with tempfile.TemporaryDirectory() as workspace, \
                    mock.patch.object(bridge, "DEFAULT_WORKSPACE", workspace), \
                    mock.patch.object(bridge, "WEBRTC_DISCONNECT_GRACE_SECONDS", 0.02), \
                    mock.patch.dict(sys.modules, {"av": types.SimpleNamespace(
                        AudioResampler=lambda **_: object(),
                    )}):
                for failed_state in ("failed", "disconnected", "closed"):
                    peer = Peer()
                    with self.subTest(state=failed_state), mock.patch.dict(sys.modules, {
                        "aiortc": types.SimpleNamespace(
                            RTCPeerConnection=lambda: peer,
                            RTCSessionDescription=lambda **kwargs: types.SimpleNamespace(**kwargs),
                        ),
                    }):
                        session = bridge.CodexPSTNSession(
                            App(), None, "", {
                                "instructions": "Greet the recipient.",
                                "opening_speech": "Hello, I am an AI assistant.",
                            }, types.SimpleNamespace(track=object()),
                        )
                        await session.prepare()
                        self.assertFalse(session.realtime_error.is_set())
                        peer.connectionState = failed_state
                        peer.handlers["connectionstatechange"]()
                        if failed_state == "disconnected":
                            self.assertFalse(session.realtime_error.is_set())
                            await asyncio.sleep(0.04)
                        self.assertTrue(session.realtime_error.is_set())
                        await session.close()

                peer = Peer()
                with mock.patch.dict(sys.modules, {
                    "aiortc": types.SimpleNamespace(
                        RTCPeerConnection=lambda: peer,
                        RTCSessionDescription=lambda **kwargs: types.SimpleNamespace(**kwargs),
                    ),
                }):
                    session = bridge.CodexPSTNSession(
                        App(), None, "", {
                            "instructions": "Greet the recipient.",
                            "opening_speech": "Hello, I am an AI assistant.",
                        }, types.SimpleNamespace(track=object()),
                    )
                    await session.prepare()
                    peer.connectionState = "disconnected"
                    peer.handlers["connectionstatechange"]()
                    self.assertFalse(session.realtime_error.is_set())
                    peer.connectionState = "connected"
                    peer.handlers["connectionstatechange"]()
                    await asyncio.sleep(0.04)
                    self.assertFalse(session.realtime_error.is_set())
                    await session.close()
                    self.assertIsNone(session._disconnect_task)

        asyncio.run(check())

    def test_duplicate_prepare_shares_one_session_and_competing_call_is_busy(self):
        async def check():
            service = self.service()
            release = asyncio.Event()
            created = []
            session = FakePreparedSession()

            async def prepare(_call_id):
                created.append(_call_id)
                await release.wait()
                return session

            with mock.patch.object(service, "_create_prepared_session", new=prepare):
                first = asyncio.create_task(service.prepare_call(CALL_ID))
                await asyncio.sleep(0)
                second = asyncio.create_task(service.prepare_call(CALL_ID))
                with self.assertRaisesRegex(ValueError, "bridge_busy"):
                    await service.prepare_call("different-call")
                release.set()
                await asyncio.gather(first, second)
                self.assertEqual(created, [CALL_ID])
                self.assertIn(CALL_ID, service.prepared_calls)
                with self.assertRaisesRegex(ValueError, "bridge_busy"):
                    service.claim({"id": "different-call", "direction": "outbound", "exp": 9999999999})
                await service.cancel_prepared(CALL_ID)
                self.assertEqual(session.closed, 1)

        asyncio.run(check())

    def test_full_or_terminal_spool_rejects_before_preparing_voice(self):
        async def check():
            service = self.service()
            service.terminal_spool.persist_outbound(
                "older-call", "failed", detail="voice_stream_failed",
            )
            with mock.patch.object(service, "_create_prepared_session",
                                   new=mock.AsyncMock()) as prepare:
                with mock.patch.object(bridge, "MAX_TERMINAL_SPOOL_ENTRIES", 1):
                    with self.assertRaisesRegex(RuntimeError, "terminal_spool_full"):
                        await service.prepare_call(CALL_ID)
                with self.assertRaisesRegex(RuntimeError, "terminal_spool_call_already_terminal"):
                    await service.prepare_call("older-call")
            prepare.assert_not_awaited()
            self.assertFalse(service.prepared_calls)

        asyncio.run(check())

    def test_cancel_and_expiry_release_prepared_session_once(self):
        async def check():
            service = self.service()
            session = FakePreparedSession()
            with mock.patch.object(service, "_create_prepared_session", new=mock.AsyncMock(return_value=session)):
                await service.prepare_call(CALL_ID)
                await service.cancel_prepared(CALL_ID)
                await service.cancel_prepared(CALL_ID)
                self.assertEqual(session.closed, 1)
                self.assertFalse(service.prepared_calls)
                with mock.patch.object(bridge, "PREPARED_CALL_TTL_SECONDS", 0.01):
                    await service.prepare_call(CALL_ID)
                    await asyncio.sleep(0.05)
                self.assertFalse(service.prepared_calls)
                self.assertEqual(session.closed, 2)

        asyncio.run(check())

    def test_http_prepare_and_cancel_require_matching_bearer_action(self):
        async def check():
            service = self.service()

            class Connection:
                def respond(self, status, body):
                    return status, json.loads(body) if body.startswith("{") else body

            def request(action, token, *, query=""):
                return types.SimpleNamespace(
                    path=f"/{action}/{CALL_ID}{query}",
                    headers={"Authorization": "Bearer " + token} if token else {},
                )

            with mock.patch.object(service, "prepare_call", new=mock.AsyncMock()) as prepare, \
                    mock.patch.object(service, "cancel_prepared", new=mock.AsyncMock()) as cancel:
                self.assertEqual((await service.process_request(
                    Connection(), request("prepare", action_token())
                ))[0], 200)
                prepare.assert_awaited_once_with(CALL_ID)
                self.assertEqual((await service.process_request(
                    Connection(), request("cancel", action_token("cancel"))
                ))[0], 200)
                cancel.assert_awaited_once_with(CALL_ID)
                for bad in (
                    request("prepare", ""), request("prepare", action_token("cancel")),
                    request("cancel", action_token()),
                ):
                    self.assertEqual((await service.process_request(Connection(), bad))[0], 401)
                self.assertEqual((await service.process_request(
                    Connection(), request("prepare", action_token(), query="?token=leak")
                ))[0], 400)

        asyncio.run(check())

    def test_prepare_http_get_reaches_websockets_process_request(self):
        async def check():
            from websockets.asyncio.server import serve

            service = self.service()

            async def unused_socket(_socket):
                raise AssertionError("HTTP prepare must not upgrade to WebSocket")

            with mock.patch.object(service, "prepare_call", new=mock.AsyncMock()):
                async with serve(unused_socket, "127.0.0.1", 0,
                                 process_request=service.process_request) as server:
                    port = server.sockets[0].getsockname()[1]
                    request = urllib.request.Request(
                        f"http://127.0.0.1:{port}/prepare/{CALL_ID}",
                        headers={"Authorization": "Bearer " + action_token()},
                    )

                    def fetch():
                        with urllib.request.urlopen(request, timeout=3) as response:
                            return response.status, json.loads(response.read())

                    status, body = await asyncio.to_thread(fetch)
                    self.assertEqual(status, 200)
                    self.assertEqual(body, {"ok": True, "prepared": True})

        asyncio.run(check())

    def test_preanswer_remote_audio_is_drained_without_playback(self):
        async def check():
            class Socket:
                def __init__(self):
                    self.events = []

                async def send(self, raw):
                    self.events.append(json.loads(raw))

            class Frame:
                samples = 480
                planes = [struct.pack("<" + "h" * 480, *([3000] * 480))]

            class Remote:
                def __init__(self):
                    self.frames = asyncio.Queue()

                async def recv(self):
                    return await self.frames.get()

            class Tone:
                def __init__(self):
                    self.write_lock = asyncio.Lock()
                    self.handed_off = False

                async def handoff_to_voice(self):
                    self.handed_off = True

            socket = Socket()
            tone = Tone()
            remote = Remote()
            session = bridge.CodexPSTNSession(None, None, "", {}, None)
            session._prepared = True
            with mock.patch.dict(sys.modules, {"av": types.SimpleNamespace(
                AudioResampler=lambda **_: types.SimpleNamespace(resample=lambda frame: [frame]),
            )}):
                output = asyncio.create_task(session._forward_output(remote))
                remote.frames.put_nowait(Frame())
                await asyncio.sleep(0.01)
                self.assertEqual(socket.events, [])
                self.assertFalse(session.first_audio.is_set())
                session.attach(socket, "stream-test", tone, "little")
                session._activated = True
                remote.frames.put_nowait(Frame())
                await asyncio.wait_for(session.first_audio.wait(), timeout=1)
                self.assertTrue(tone.handed_off)
                self.assertEqual([event["event"] for event in socket.events], ["playAudio"])
                output.cancel()
                await asyncio.gather(output, return_exceptions=True)

        asyncio.run(check())

    def test_activation_prompts_only_after_attachment(self):
        async def check():
            calls = []
            session = bridge.CodexPSTNSession(None, None, "", {}, None)
            session.thread_id = "sol-thread"
            session._prepared = True

            class App:
                async def request(self, method, params):
                    calls.append((method, params))
                    session.first_audio.set()

            session.app = App()
            session.output_task = asyncio.create_task(asyncio.Event().wait())
            with self.assertRaisesRegex(RuntimeError, "codex_session_not_prepared"):
                await session.activate()
            self.assertEqual(calls, [])
            session.attach(types.SimpleNamespace(), "stream-test",
                           types.SimpleNamespace(write_lock=asyncio.Lock()), "little")
            await session.activate()
            self.assertEqual(calls[0][0], "thread/realtime/appendSpeech")
            self.assertIn("call is connected", calls[0][1]["text"])
            with self.assertRaisesRegex(RuntimeError, "codex_session_already_activated"):
                await session.activate()
            session.output_task.cancel()
            await asyncio.gather(session.output_task, return_exceptions=True)

        asyncio.run(check())

    def test_answered_stream_uses_prepared_session_without_starting_another(self):
        async def check():
            service = self.service()
            class Reader:
                def done(self):
                    return False

            app = types.SimpleNamespace(
                process=types.SimpleNamespace(returncode=None),
                reader_task=Reader(), broken=False,
            )
            service.app = app
            service.webrtc_verified = True
            prepared_context = {
                "id": CALL_ID, "direction": "outbound",
                "instructions": "Ask about lunch.",
                "opening_speech": "Hello, I am an AI assistant.",
                "caller_number": "+919000000001",
                "destination_number": "+919000000002",
                "vobiz_call_id": None,
            }
            done = asyncio.Event()
            activated = asyncio.Event()
            claim_started = asyncio.Event()
            claim_release = asyncio.Event()
            lifecycle = []

            class Prepared:
                def __init__(self):
                    self.app = app
                    self.context = prepared_context
                    self.realtime_error = asyncio.Event()
                    self.output_task = asyncio.create_task(asyncio.Event().wait())
                    self.transcript = []
                    self.last_voice_at = bridge.time.monotonic()
                    self.peer = types.SimpleNamespace(connectionState="connected")
                    self.attached = False
                    self.activated = False

                def attach(self, _socket, stream_id, _tone, _endian):
                    self.attached = stream_id == "stream-test"

                async def activate(self):
                    self.activated = True
                    activated.set()

                async def close(self):
                    self.output_task.cancel()
                    await asyncio.gather(self.output_task, return_exceptions=True)

            prepared = Prepared()
            task = asyncio.create_task(asyncio.sleep(0, result=prepared))
            service.prepared_calls[CALL_ID] = bridge.PreparedCall(task)
            await task

            class Socket:
                request = types.SimpleNamespace(path="/vobiz?token=" + signed_token({
                    "v": 2, "id": CALL_ID, "exp": int(bridge.time.time()) + 90,
                    "direction": "outbound", "provider_call_id": PROVIDER_CALL_ID,
                }))

                async def recv(self):
                    return json.dumps({"event": "start", "start": {
                        "streamId": "stream-test", "callId": PROVIDER_CALL_ID,
                        "mediaFormat": {"encoding": "audio/x-l16", "sampleRate": 16000},
                    }})

                async def send(self, _raw):
                    pass

                async def close(self, **_):
                    pass

            async def receive_media(*_):
                await done.wait()

            async def report(_call_id, event, **_extra):
                lifecycle.append(event)
                if event == "connected":
                    done.set()
                return True

            async def claim_remote(call_id):
                self.assertEqual(call_id, CALL_ID)
                claim_started.set()
                await claim_release.wait()

            with mock.patch.object(service, "context", new=mock.AsyncMock(
                    side_effect=AssertionError("answer-time context fetch"))) as context, \
                    mock.patch.object(service, "claim_remote", new=mock.AsyncMock(
                        side_effect=claim_remote)) as claim, \
                    mock.patch.object(service, "ensure_codex", new=mock.AsyncMock(
                        side_effect=AssertionError("answer-time Codex restart"))) as ensure, \
                    mock.patch.object(service, "_receive_media", new=receive_media), \
                    mock.patch.object(service, "report", new=report), \
                    mock.patch.object(bridge, "CodexPSTNSession", side_effect=AssertionError("cold start")):
                handle = asyncio.create_task(service.handle(Socket()))
                await asyncio.wait_for(activated.wait(), timeout=1)
                await asyncio.wait_for(claim_started.wait(), timeout=1)
                self.assertEqual(lifecycle, [])
                self.assertFalse(handle.done())
                claim_release.set()
                await asyncio.wait_for(handle, timeout=2)
            self.assertTrue(prepared.attached)
            self.assertTrue(prepared.activated)
            context.assert_not_awaited()
            ensure.assert_not_awaited()
            claim.assert_awaited_once_with(CALL_ID)
            self.assertEqual(lifecycle, ["connected", "ended"])
            self.assertFalse(service.prepared_calls)
            self.assertFalse(service.active_calls)

        asyncio.run(check())

    def test_outbound_stream_requires_prepared_session_before_upgrade(self):
        async def check():
            service = self.service()
            token = signed_token({
                "v": 2, "id": CALL_ID, "exp": int(bridge.time.time()) + 90,
                "direction": "outbound", "provider_call_id": PROVIDER_CALL_ID,
            })

            class Connection:
                def respond(self, status, body):
                    return status, body

            request = types.SimpleNamespace(path="/vobiz?token=" + token)
            status, _ = await service.process_request(Connection(), request)
            self.assertEqual(status, 503)
            with self.assertRaisesRegex(ValueError, "prewarm_missing"):
                service.claim(bridge.verify_stream_token(token, SECRET))

        asyncio.run(check())

    def test_provider_start_mismatch_never_claims_or_activates(self):
        async def check():
            service = self.service()
            prepared = FakePreparedSession()
            task = asyncio.create_task(asyncio.sleep(0, result=prepared))
            service.prepared_calls[CALL_ID] = bridge.PreparedCall(task)
            await task
            events = []

            class Socket:
                request = types.SimpleNamespace(path="/vobiz?token=" + signed_token({
                    "v": 2, "id": CALL_ID, "exp": int(bridge.time.time()) + 90,
                    "direction": "outbound", "provider_call_id": PROVIDER_CALL_ID,
                }))

                def __init__(self):
                    self.closed = False

                async def recv(self):
                    return json.dumps({"event": "start", "start": {
                        "streamId": "stream-test",
                        "callId": "d4dbe0ce-b15c-4c8e-83c6-7e40a13c6f73",
                        "mediaFormat": {"encoding": "audio/x-l16", "sampleRate": 16000},
                    }})

                async def close(self, **_):
                    self.closed = True

            async def report(_call_id, event, **_extra):
                events.append(event)
                return True

            socket = Socket()
            with mock.patch.object(service, "claim_remote", new=mock.AsyncMock()) as claim, \
                    mock.patch.object(service, "report", new=report):
                await service.handle(socket)
            self.assertTrue(socket.closed)
            self.assertEqual(prepared.closed, 1)
            self.assertEqual(events, ["failed"])
            claim.assert_not_awaited()
            self.assertFalse(service.active_calls)

        asyncio.run(check())

    def test_clean_stream_end_before_first_audio_reports_failed(self):
        async def check():
            service = self.service()

            class Reader:
                def done(self):
                    return False

            app = types.SimpleNamespace(
                process=types.SimpleNamespace(returncode=None),
                reader_task=Reader(), broken=False,
            )
            service.app = app
            service.webrtc_verified = True
            activated = asyncio.Event()

            class Prepared:
                def __init__(self):
                    self.app = app
                    self.context = {"id": CALL_ID, "direction": "outbound",
                                    "vobiz_call_id": None}
                    self.realtime_error = asyncio.Event()
                    self.output_task = asyncio.create_task(asyncio.Event().wait())
                    self.peer = types.SimpleNamespace(connectionState="connected")
                    self.transcript = []

                def attach(self, *_):
                    pass

                async def activate(self):
                    activated.set()
                    await asyncio.Event().wait()

                async def close(self):
                    self.output_task.cancel()
                    await asyncio.gather(self.output_task, return_exceptions=True)

            prepared = Prepared()
            task = asyncio.create_task(asyncio.sleep(0, result=prepared))
            service.prepared_calls[CALL_ID] = bridge.PreparedCall(task)
            await task

            class Socket:
                request = types.SimpleNamespace(path="/vobiz?token=" + signed_token({
                    "v": 2, "id": CALL_ID, "exp": int(bridge.time.time()) + 90,
                    "direction": "outbound", "provider_call_id": PROVIDER_CALL_ID,
                }))

                def __init__(self):
                    self.closed = False

                async def recv(self):
                    return json.dumps({"event": "start", "start": {
                        "streamId": "stream-test", "callId": PROVIDER_CALL_ID,
                        "mediaFormat": {"encoding": "audio/x-l16", "sampleRate": 16000},
                    }})

                async def send(self, _raw):
                    pass

                async def close(self, **_):
                    self.closed = True

            events = []

            async def report(_call_id, event, **extra):
                events.append((event, extra))
                return True

            async def receive_media(*_):
                await activated.wait()

            socket = Socket()
            with mock.patch.object(service, "claim_remote_with_retries",
                                   new=mock.AsyncMock(return_value=False)), \
                    mock.patch.object(service, "_receive_media", new=receive_media), \
                    mock.patch.object(service, "report", new=report):
                await asyncio.wait_for(service.handle(socket), timeout=2)
            self.assertTrue(socket.closed)
            self.assertEqual(events, [("failed", {
                "detail": "stream_ended_before_first_audio",
            })])
            self.assertFalse(service.active_calls)

        asyncio.run(check())

    def test_failed_background_claim_does_not_suppress_terminal_report(self):
        async def check():
            service = self.service()
            events = []

            async def report(_call_id, event, **_extra):
                events.append(event)
                return True

            claim_task = asyncio.create_task(asyncio.sleep(0, result=False))
            with mock.patch.object(service, "report", new=report):
                self.assertFalse(await service.report_connected_after_claim(CALL_ID, claim_task))
                await service.finish_call(CALL_ID, "outbound", [])
            self.assertEqual(events, ["ended"])

        asyncio.run(check())

    def test_eight_kilohertz_provider_frames_feed_prepared_sixteen_kilohertz_track(self):
        async def check():
            service = self.service()
            pushed = []
            track = types.SimpleNamespace(sample_rate=16000, push=pushed.append)
            session = types.SimpleNamespace(stream_id="stream-test", input_track=track,
                                            last_voice_at=bridge.time.monotonic())
            pcm = b"\x00\x00" * 160

            class Socket:
                async def __aiter__(self):
                    yield json.dumps({
                        "event": "media", "streamId": "stream-test",
                        "media": {"track": "inbound", "payload": base64.b64encode(pcm).decode()},
                    })

            class Plane:
                def __init__(self, size):
                    self.data = bytearray(size)

                def update(self, value):
                    self.data[:len(value)] = value

                def __bytes__(self):
                    return bytes(self.data)

            class Frame:
                def __init__(self, samples):
                    self.samples = samples
                    self.planes = [Plane(samples * 2)]
                    self.sample_rate = None

            class Resampler:
                def __init__(self, **_):
                    pass

                def resample(self, frame):
                    output = Frame(frame.samples * 2)
                    return [output]

            with mock.patch.dict(sys.modules, {"av": types.SimpleNamespace(
                AudioFrame=lambda **kwargs: Frame(kwargs["samples"]),
                AudioResampler=Resampler,
            )}):
                await service._receive_media(Socket(), session, "audio/x-l16", 8000)
            self.assertEqual(len(pushed), 1)
            self.assertEqual(len(pushed[0]), 640)

        asyncio.run(check())


if __name__ == "__main__":
    unittest.main()
