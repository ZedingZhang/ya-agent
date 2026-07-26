import os
import unittest
from unittest.mock import patch

from ya.keychain import load_api_key, save_api_key


class KeychainTests(unittest.TestCase):
    def test_non_macos_loads_key_from_environment(self):
        with patch.dict(os.environ, {"DEEPSEEK_API_KEY": "test-key"}, clear=True):
            with patch("ya.keychain._macos_keychain_available", return_value=False):
                self.assertEqual(load_api_key(), "test-key")

    def test_non_macos_without_environment_key_returns_none(self):
        with patch.dict(os.environ, {}, clear=True):
            with patch("ya.keychain._macos_keychain_available", return_value=False):
                self.assertIsNone(load_api_key())

    def test_non_macos_auth_explains_environment_variable(self):
        with patch("ya.keychain._macos_keychain_available", return_value=False):
            with self.assertRaisesRegex(ValueError, "DEEPSEEK_API_KEY"):
                save_api_key("test-key")
