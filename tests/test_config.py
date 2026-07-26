import os
import tempfile
import unittest

from ya.config import ModelConfig, load_config, model_id, save_config


class ConfigTests(unittest.TestCase):
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

    def test_defaults_are_flash_with_thinking(self):
        config = load_config()
        self.assertEqual(config.model, "deepseek-v4-flash")
        self.assertTrue(config.thinking_enabled)
        self.assertEqual(config.reasoning_effort, "high")

    def test_config_round_trip(self):
        config = ModelConfig(model=model_id("pro"), reasoning_effort="max")
        save_config(config)
        self.assertEqual(load_config(), config)

    def test_legacy_model_is_rejected(self):
        with self.assertRaises(ValueError):
            ModelConfig(model="deepseek-chat").validate()
