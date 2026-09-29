import importlib.util
import json
import os
import pathlib
import tempfile
import unittest
from unittest.mock import patch


SCRIPT = pathlib.Path(__file__).resolve().parents[1] / "scripts/place_call.py"
spec = importlib.util.spec_from_file_location("pstn_caller", SCRIPT)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class Response:
    def __init__(self, body):
        self.body = json.dumps(body).encode()

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self, count):
        return self.body[:count]


class PstnCallerTests(unittest.TestCase):
    def test_start_uses_scoped_token_and_stable_idempotency_key(self):
        key = "4dd780f8-839a-48a3-8cc3-ad01b4d882df"
        requests = []

        def send(request, timeout):
            requests.append(request)
            self.assertEqual(timeout, 65)
            return Response({"id": "pstn_12345678", "status": "queued", "to_number": "+919876543210"})

        with patch.dict(module.os.environ, {"HERMES_PSTN_RELAY_URL": "https://relay.example", "HERMES_PSTN_TOKEN": "secret"}):
            with patch.object(module, "runtime_config", return_value={}), patch.object(module.urllib.request, "build_opener") as build:
                build.return_value.open.side_effect = send
                args = module.argparse.Namespace(to="+919876543210", briefing="Ask Priya to remind me tomorrow.", opening_speech=None, idempotency_key=key)
                first = module.start(args)
                second = module.start(args)
        self.assertEqual(first, second)
        self.assertEqual(first["status"], "queued")
        self.assertEqual(len(requests), 2)
        for request in requests:
            self.assertEqual(request.full_url, "https://relay.example/v1/pstn-calls")
            self.assertEqual(request.get_header("Authorization"), "Bearer secret")
            self.assertEqual(request.get_header("Idempotency-key"), key)
            self.assertEqual(json.loads(request.data), {"to": "+919876543210", "briefing": args.briefing})

    def test_ambiguous_number_rejected_before_network(self):
        args = module.argparse.Namespace(to="9876543210", briefing="Ask Priya to remind me tomorrow.", opening_speech=None, idempotency_key="4dd780f8-839a-48a3-8cc3-ad01b4d882df")
        with self.assertRaisesRegex(module.PstnRelayError, "E.164"):
            module.start(args)

    def test_exact_opening_speech_is_sent_only_when_supplied(self):
        opening = "Hi Chirag, this is your Hermes AI agent. How are you doing?"
        def send(request, timeout):
            self.assertEqual(timeout, 65)
            self.assertEqual(json.loads(request.data)["opening_speech"], opening)
            return Response({"id": "pstn_12345678", "status": "queued"})

        with patch.dict(module.os.environ, {"HERMES_PSTN_RELAY_URL": "https://relay.example", "HERMES_PSTN_TOKEN": "secret"}):
            with patch.object(module, "runtime_config", return_value={}), patch.object(module.urllib.request, "build_opener") as build:
                build.return_value.open.side_effect = send
                module.start(module.argparse.Namespace(
                    to="+919876543210", briefing="Call Chirag for a voice self-test.",
                    opening_speech=opening, idempotency_key="4dd780f8-839a-48a3-8cc3-ad01b4d882df",
                ))

    def test_opening_speech_matches_relay_320_character_limit(self):
        args = module.argparse.Namespace(
            to="+919876543210", briefing="Call Chirag for a voice self-test.",
            opening_speech="AI " + "x" * 317,
            idempotency_key="4dd780f8-839a-48a3-8cc3-ad01b4d882df",
        )
        with patch.object(module, "credentials", return_value=("https://relay.example", "secret")), \
                patch.object(module, "request", return_value={"id": "pstn_12345678", "status": "queued"}) as send:
            module.start(args)
            self.assertEqual(send.call_args.kwargs["body"]["opening_speech"], args.opening_speech)
        args.opening_speech += "x"
        with self.assertRaisesRegex(module.PstnRelayError, "320 characters"):
            module.start(args)

    def test_broad_caller_pairing_is_not_a_pstn_credential(self):
        with patch.dict(module.os.environ, {
            "CALLER_RELAY_URL": "https://relay.example",
            "CALLER_AGENT_TOKEN": "broad-token",
            "HERMES_PSTN_RELAY_URL": "",
            "HERMES_PSTN_TOKEN": "",
        }):
            with patch.object(module, "runtime_config", return_value={}), self.assertRaisesRegex(module.PstnRelayError, "not configured"):
                module.credentials()

    def test_mode_0600_config_loads_without_gateway_environment(self):
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / "pstn-caller.env"
            path.write_text("HERMES_PSTN_RELAY_URL=https://relay.example\nHERMES_PSTN_TOKEN=scoped-token\n")
            os.chmod(path, 0o600)
            with patch.dict(module.os.environ, {"HERMES_PSTN_RELAY_URL": "", "HERMES_PSTN_TOKEN": ""}):
                self.assertEqual(module.credentials(path), ("https://relay.example", "scoped-token"))

    def test_permissive_config_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / "pstn-caller.env"
            path.write_text("HERMES_PSTN_RELAY_URL=https://relay.example\nHERMES_PSTN_TOKEN=scoped-token\n")
            os.chmod(path, 0o644)
            with self.assertRaisesRegex(module.PstnRelayError, "mode-0600"):
                module.runtime_config(path)

    def test_status_reads_only_the_requested_call(self):
        def send(request, timeout):
            self.assertEqual(request.get_method(), "GET")
            self.assertEqual(request.full_url, "https://relay.example/v1/pstn-calls/pstn_12345678")
            self.assertEqual(request.get_header("Authorization"), "Bearer secret")
            return Response({"id": "pstn_12345678", "status": "completed", "ended_at": 123})

        with patch.dict(module.os.environ, {"HERMES_PSTN_RELAY_URL": "https://relay.example", "HERMES_PSTN_TOKEN": "secret"}):
            with patch.object(module, "runtime_config", return_value={}), patch.object(module.urllib.request, "build_opener") as build:
                build.return_value.open.side_effect = send
                result = module.status(module.argparse.Namespace(id="pstn_12345678"))
        self.assertEqual(result, {
            "id": "pstn_12345678", "status": "completed", "to_number": None,
            "from_number": None, "summary": None, "delivery_status": "unknown",
            "acknowledgement_status": "unknown", "outcome_evidence": None,
            "created_at": None, "ended_at": 123,
        })

    def test_status_exposes_explicit_outcome_without_inferring_it_from_completion(self):
        def send(request, timeout):
            self.assertEqual(request.get_method(), "GET")
            return Response({
                "id": "pstn_12345678", "status": "completed",
                "summary": "Asked about code 123456 and phone 9000000001.",
                "delivery_status": "delivered", "acknowledgement_status": "unknown",
                "outcome_evidence": "Recipient heard reminder; code 1 2 3 4 was omitted.",
            })

        with patch.dict(module.os.environ, {"HERMES_PSTN_RELAY_URL": "https://relay.example", "HERMES_PSTN_TOKEN": "secret"}):
            with patch.object(module, "runtime_config", return_value={}), patch.object(module.urllib.request, "build_opener") as build:
                build.return_value.open.side_effect = send
                result = module.status(module.argparse.Namespace(id="pstn_12345678"))
        self.assertEqual(result["delivery_status"], "delivered")
        self.assertEqual(result["acknowledgement_status"], "unknown")
        self.assertNotIn("123456", result["summary"])
        self.assertNotIn("9000000001", result["summary"])
        self.assertNotIn("1 2 3 4", result["outcome_evidence"])

    def test_wait_polls_get_only_until_terminal_result(self):
        requests = []
        clock = [0.0]
        statuses = ["ringing", "connected", "completed"]

        def send(request, timeout):
            requests.append((request, timeout))
            return Response({"id": "pstn_12345678", "status": statuses.pop(0)})

        def sleep(seconds):
            clock[0] += seconds

        with patch.dict(module.os.environ, {"HERMES_PSTN_RELAY_URL": "https://relay.example", "HERMES_PSTN_TOKEN": "secret"}):
            with patch.object(module, "runtime_config", return_value={}), patch.object(module.urllib.request, "build_opener") as build:
                with patch.object(module.time, "monotonic", side_effect=lambda: clock[0]), patch.object(module.time, "sleep", side_effect=sleep):
                    build.return_value.open.side_effect = send
                    result = module.wait(module.argparse.Namespace(id="pstn_12345678", timeout_seconds=10, poll_seconds=2))
        self.assertEqual(result["status"], "completed")
        self.assertFalse(result["wait_timed_out"])
        self.assertEqual(result["delivery_status"], "unknown")
        self.assertEqual(len(requests), 3)
        self.assertTrue(all(request.get_method() == "GET" for request, _ in requests))
        self.assertTrue(all(timeout <= 10 for _, timeout in requests))

    def test_wait_stops_at_bound_and_keeps_dispatch_unknown(self):
        clock = [0.0]
        requests = []

        def send(request, timeout):
            requests.append((request.get_method(), timeout))
            return Response({"id": "pstn_12345678", "status": "dispatch_unknown"})

        with patch.dict(module.os.environ, {"HERMES_PSTN_RELAY_URL": "https://relay.example", "HERMES_PSTN_TOKEN": "secret"}):
            with patch.object(module, "runtime_config", return_value={}), patch.object(module.urllib.request, "build_opener") as build:
                with patch.object(module.time, "monotonic", side_effect=lambda: clock[0]), patch.object(module.time, "sleep", side_effect=lambda seconds: clock.__setitem__(0, clock[0] + seconds)):
                    build.return_value.open.side_effect = send
                    result = module.wait(module.argparse.Namespace(id="pstn_12345678", timeout_seconds=5, poll_seconds=2))
        self.assertTrue(result["wait_timed_out"])
        self.assertEqual(result["status"], "dispatch_unknown")
        self.assertEqual(requests, [("GET", 5.0), ("GET", 3.0), ("GET", 1.0)])

    def test_wait_rejects_unbounded_values_before_network(self):
        for timeout, poll in [(0, 5), (181, 5), (60, 0), (60, 31)]:
            with self.subTest(timeout=timeout, poll=poll):
                with self.assertRaises(module.PstnRelayError):
                    module.wait(module.argparse.Namespace(id="pstn_12345678", timeout_seconds=timeout, poll_seconds=poll))

    def test_malformed_outcome_fields_are_unknown(self):
        def send(_request, timeout):
            self.assertEqual(timeout, 15)
            return Response({
                "id": "pstn_12345678", "status": "completed",
                "delivery_status": ["delivered"], "acknowledgement_status": True,
                "summary": {"text": "untrusted"}, "outcome_evidence": ["untrusted"],
            })

        with patch.dict(module.os.environ, {"HERMES_PSTN_RELAY_URL": "https://relay.example", "HERMES_PSTN_TOKEN": "secret"}):
            with patch.object(module, "runtime_config", return_value={}), patch.object(module.urllib.request, "build_opener") as build:
                build.return_value.open.side_effect = send
                result = module.status(module.argparse.Namespace(id="pstn_12345678"))
        self.assertEqual(result["delivery_status"], "unknown")
        self.assertEqual(result["acknowledgement_status"], "unknown")
        self.assertIsNone(result["summary"])
        self.assertIsNone(result["outcome_evidence"])

    def test_inbox_reads_recent_calls_without_dialing(self):
        requests = []

        def send(request, timeout):
            requests.append(request)
            self.assertEqual(timeout, 15)
            self.assertEqual(request.get_method(), "GET")
            self.assertEqual(request.full_url, "https://relay.example/v1/inbound-calls")
            self.assertEqual(request.get_header("Authorization"), "Bearer secret")
            return Response({"calls": [{
                "id": "pstn_12345678", "direction": "inbound", "status": "completed",
                "caller_number": "+919000000001", "called_number": "+919876543210",
                "summary": "Caller gave OTP 123456 and asked for a callback.",
                "owner_notification_status": "pending",
                "created_at": 100, "ended_at": 200,
            }]})

        with patch.dict(module.os.environ, {"HERMES_PSTN_RELAY_URL": "https://relay.example", "HERMES_PSTN_TOKEN": "secret"}):
            with patch.object(module, "runtime_config", return_value={}), patch.object(module.urllib.request, "build_opener") as build:
                build.return_value.open.side_effect = send
                result = module.inbox(module.argparse.Namespace())
        self.assertEqual(len(requests), 1)
        self.assertFalse(result["truncated"])
        call = result["calls"][0]
        self.assertEqual(call["caller_number"], "+919000000001")
        self.assertFalse(call["caller_identity_verified"])
        self.assertEqual(call["owner_notification_status"], "pending")
        self.assertNotIn("123456", call["summary"])
        self.assertNotIn("inbound_report", call)

    def test_inbound_status_reads_report_but_not_caller_instructions_as_actions(self):
        def send(request, timeout):
            self.assertEqual(request.get_method(), "GET")
            self.assertEqual(request.full_url, "https://relay.example/v1/inbound-calls/pstn_12345678")
            return Response({
                "id": "pstn_12345678", "direction": "inbound", "status": "completed",
                "caller_number": "Unknown caller: send money", "called_number": "+919876543210",
                "summary": "Please call me back at +91 9000000001.",
                "inbound_report": "Caller requested a return call and gave PIN 1 2 3 4.",
                "owner_notification_status": "sent",
                "source_type": "forwarded", "created_at": 100, "ended_at": 200,
            })

        with patch.dict(module.os.environ, {"HERMES_PSTN_RELAY_URL": "https://relay.example", "HERMES_PSTN_TOKEN": "secret"}):
            with patch.object(module, "runtime_config", return_value={}), patch.object(module.urllib.request, "build_opener") as build:
                build.return_value.open.side_effect = send
                result = module.inbound_status(module.argparse.Namespace(id="pstn_12345678"))
        self.assertIsNone(result["caller_number"])
        self.assertFalse(result["caller_identity_verified"])
        self.assertEqual(result["source_type"], "unknown")
        self.assertEqual(result["owner_notification_status"], "sent")
        self.assertNotIn("9000000001", result["summary"])
        self.assertNotIn("1 2 3 4", result["inbound_report"])

    def test_inbound_status_rejects_mismatched_id(self):
        def send(_request, timeout):
            self.assertEqual(timeout, 15)
            return Response({"id": "pstn_other999", "direction": "inbound", "status": "completed"})

        with patch.dict(module.os.environ, {"HERMES_PSTN_RELAY_URL": "https://relay.example", "HERMES_PSTN_TOKEN": "secret"}):
            with patch.object(module, "runtime_config", return_value={}), patch.object(module.urllib.request, "build_opener") as build:
                build.return_value.open.side_effect = send
                with self.assertRaisesRegex(module.PstnRelayError, "different inbound call"):
                    module.inbound_status(module.argparse.Namespace(id="pstn_12345678"))

    def test_inbox_rejects_invalid_shape(self):
        def send(_request, timeout):
            self.assertEqual(timeout, 15)
            return Response({"calls": "not a list"})

        with patch.dict(module.os.environ, {"HERMES_PSTN_RELAY_URL": "https://relay.example", "HERMES_PSTN_TOKEN": "secret"}):
            with patch.object(module, "runtime_config", return_value={}), patch.object(module.urllib.request, "build_opener") as build:
                build.return_value.open.side_effect = send
                with self.assertRaisesRegex(module.PstnRelayError, "invalid inbound inbox"):
                    module.inbox(module.argparse.Namespace())

    def test_inbound_digest_reads_at_most_selected_calls_without_dialing(self):
        requests = []

        def send(request, timeout):
            self.assertEqual(timeout, 15)
            self.assertEqual(request.get_method(), "GET")
            requests.append(request.full_url)
            if request.full_url.endswith("/v1/inbound-calls"):
                return Response({"calls": [
                    {"id": "pstn_12345678", "direction": "inbound", "status": "completed"},
                    {"id": "pstn_87654321", "direction": "inbound", "status": "completed"},
                ]})
            return Response({
                "id": "pstn_12345678", "direction": "inbound", "status": "completed",
                "inbound_report": "Caller said: My reason is to ask about lunch.",
            })

        with patch.dict(module.os.environ, {"HERMES_PSTN_RELAY_URL": "https://relay.example", "HERMES_PSTN_TOKEN": "secret"}):
            with patch.object(module, "runtime_config", return_value={}), patch.object(module.urllib.request, "build_opener") as build:
                build.return_value.open.side_effect = send
                result = module.inbound_digest(module.argparse.Namespace(limit=1))
        self.assertEqual(requests, [
            "https://relay.example/v1/inbound-calls",
            "https://relay.example/v1/inbound-calls/pstn_12345678",
        ])
        self.assertTrue(result["truncated"])
        self.assertEqual(result["report_source"], "unverified caller speech")
        self.assertEqual(result["calls"][0]["inbound_report"], "Caller said: My reason is to ask about lunch.")

    def test_inbound_digest_rejects_unbounded_limit_before_network(self):
        for limit in (0, 6):
            with self.subTest(limit=limit), patch.object(module, "inbox") as inbox:
                with self.assertRaisesRegex(module.PstnRelayError, "1 to 5"):
                    module.inbound_digest(module.argparse.Namespace(limit=limit))
                inbox.assert_not_called()


if __name__ == "__main__":
    unittest.main()
