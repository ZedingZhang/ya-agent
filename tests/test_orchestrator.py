import unittest

from ya.config import ModelConfig
from ya.orchestrator import should_use_web, single_agent


class _Client:
    def __init__(self):
        self.streamed = []

    def complete_stream(self, messages, config, max_tokens, on_content):
        from ya.deepseek import ModelReply

        on_content("answer")
        self.streamed.append(True)
        return ModelReply("answer", None, [], {}, {"role": "assistant", "content": "answer"})


class OrchestratorTests(unittest.TestCase):
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
