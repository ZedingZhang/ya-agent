import unittest
import os
import tempfile
from unittest.mock import patch

from ya.config import ModelConfig
from ya.memory import create_candidate, set_status
from ya.orchestrator import _messages, should_use_web, single_agent


class _Client:
    def __init__(self):
        self.streamed = []

    def complete_stream(self, messages, config, max_tokens, on_content):
        from ya.deepseek import ModelReply

        on_content("answer")
        self.streamed.append(True)
        return ModelReply("answer", None, [], {}, {"role": "assistant", "content": "answer"})


class OrchestratorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.previous_home = os.environ.get("YA_HOME")
        os.environ["YA_HOME"] = self.temp.name

    def tearDown(self):
        if self.previous_home is None:
            os.environ.pop("YA_HOME", None)
        else:
            os.environ["YA_HOME"] = self.previous_home
        self.temp.cleanup()

    def test_auto_web_policy_is_conservative(self):
        self.assertFalse(should_use_web("Explain recursion", "auto"))
        self.assertTrue(should_use_web("What is the latest weather forecast?", "auto"))
        self.assertTrue(should_use_web("Explain recursion", "on"))
        self.assertFalse(should_use_web("latest weather", "off"))

    def test_simple_single_agent_can_stream_without_web(self):
        client = _Client()
        output = []
        result = single_agent(client, "Explain recursion", ModelConfig(), web_mode="auto", on_content=output.append)
        self.assertEqual(result.content, "answer")
        self.assertEqual(output, ["answer"])
        self.assertEqual(client.streamed, [True])

    def test_messages_include_only_relevant_memory(self):
        matching = create_candidate("Use PostgreSQL indexes", "evidence")
        unrelated = create_candidate("Use dark terminal themes", "evidence")
        set_status(matching.id, "approved")
        set_status(unrelated.id, "approved")

        messages = _messages("Explain PostgreSQL indexes")

        self.assertIn(matching.text, messages[0]["content"])
        self.assertNotIn(unrelated.text, messages[0]["content"])
