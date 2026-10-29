"""Regression tests for the Hermes mesh-approval bridge.

Two protocol bugs made approvals time out (and therefore default to deny):

* the presentation message used ``no_reply: True`` without a ``reply_to``; the hub now
  ignores that flag (it only marks the closing message of a dialogue) and would wake the
  agent, which must never be able to approve itself -- the message has to be ``silent``;
* the poll read the oldest 20 unread items, so once the inbox backlog passed 20 the
  user's fresh reply was never seen -- it now asks for ``order=desc``.

Run from the repository root:

    python -m unittest discover -s plugins/mesh-approval -p 'test_*.py'
"""

from __future__ import annotations

import importlib.util
import os
import sys
import types
import unittest

# The real host module only exists inside Hermes; stub just the names the plugin uses.
if "hermes_cli" not in sys.modules:
    hermes = types.ModuleType("hermes_cli")
    approval_transport = types.ModuleType("hermes_cli.approval_transport")

    class ApprovalDecision:
        def __init__(self, request_id, digest, choice):
            self.request_id = request_id
            self.digest = digest
            self.choice = choice

    approval_transport.ApprovalDecision = ApprovalDecision
    hermes.approval_transport = approval_transport
    sys.modules["hermes_cli"] = hermes
    sys.modules["hermes_cli.approval_transport"] = approval_transport


PLUGIN_FILE = os.path.join(os.path.dirname(__file__), "__init__.py")


def load_plugin(name: str):
    spec = importlib.util.spec_from_file_location(name, PLUGIN_FILE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class FakeRequest:
    request_id = "req-12345678-aaaa"
    digest = "digest"
    command = "rm -rf /tmp/example"
    description = "dangerous command"
    pattern_key = "rm"
    timeout_seconds = 5
    allowed_choices = ("once", "always", "session", "deny")


class ApprovalTransportContract(unittest.TestCase):
    def setUp(self):
        self.plugin = load_plugin("mesh_approval_under_test")
        self.plugin.POLL_SECONDS = 0
        self.plugin._token = lambda: "test-token"
        self.plugin._gateway_session = lambda: False

    def test_present_sends_silent_and_polls_newest(self):
        calls = []
        request = FakeRequest()

        def fake_call(method, path, token, payload=None):
            calls.append({"method": method, "path": path, "payload": payload})
            if method == "GET":
                return {"messages": [{"id": "reply-1", "body": "approve " + request.request_id}]}
            return {}

        self.plugin._call = fake_call
        decision = self.plugin.present(request)

        send = next(call for call in calls if call["path"] == "/api/send")
        self.assertIs(send["payload"].get("silent"), True)
        self.assertNotIn("no_reply", send["payload"])

        poll = next(call for call in calls if call["method"] == "GET")
        self.assertIn("order=desc", poll["path"])
        self.assertEqual(decision.choice, "once")

    def test_unanswered_request_is_denied(self):
        request = FakeRequest()
        request.timeout_seconds = 0.01

        def fake_call(method, path, token, payload=None):
            if method == "GET":
                return {"messages": []}
            return {}

        self.plugin._call = fake_call
        decision = self.plugin.present(request)
        self.assertEqual(decision.choice, "deny")


if __name__ == "__main__":
    unittest.main()
