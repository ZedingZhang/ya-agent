import json
import unittest

from ya.config import ModelConfig
from ya.deepseek import DeepSeekClient


class _Response:
    def __init__(self, payload):
        self.payload = payload

    def read(self):
        return json.dumps(self.payload).encode("utf-8")

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


class DeepSeekTests(unittest.TestCase):
    def test_thinking_payload_is_explicit(self):
        seen = {}

        def opener(request, timeout):
            seen.update(json.loads(request.data.decode("utf-8")))
            return _Response({"choices": [{"message": {"content": "ok"}}]})

        client = DeepSeekClient("test-key", opener=opener)
        reply = client.complete([{"role": "user", "content": "hello"}], ModelConfig(), 100)
        self.assertEqual(reply.content, "ok")
        self.assertEqual(seen["model"], "deepseek-v4-flash")
        self.assertEqual(seen["thinking"], {"type": "enabled"})
        self.assertEqual(seen["reasoning_effort"], "high")

    def test_disabled_thinking_omits_effort(self):
        seen = {}

        def opener(request, timeout):
            seen.update(json.loads(request.data.decode("utf-8")))
            return _Response({"choices": [{"message": {"content": "ok"}}]})

        config = ModelConfig(thinking_enabled=False)
        DeepSeekClient("test-key", opener=opener).complete([], config, 100)
        self.assertEqual(seen["thinking"], {"type": "disabled"})
        self.assertNotIn("reasoning_effort", seen)
