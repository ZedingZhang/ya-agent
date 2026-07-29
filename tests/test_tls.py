import unittest
from pathlib import Path
from unittest.mock import patch

from ya.tls import configure_frozen_macos_ca


class FrozenMacosTlsTests(unittest.TestCase):
    def test_frozen_macos_uses_existing_system_certificate_bundle(self):
        environment = {}
        cert_file = Path("/tmp/test-system-cert.pem")
        with patch.object(Path, "is_file", return_value=True):
            configured = configure_frozen_macos_ca(environment, "darwin", True, cert_file)
        self.assertEqual(configured, str(cert_file))
        self.assertEqual(environment["SSL_CERT_FILE"], str(cert_file))

    def test_explicit_certificate_override_is_preserved(self):
        environment = {"SSL_CERT_FILE": "/custom/ca.pem"}
        self.assertIsNone(configure_frozen_macos_ca(environment, "darwin", True))
        self.assertEqual(environment["SSL_CERT_FILE"], "/custom/ca.pem")

    def test_non_frozen_or_non_macos_never_changes_environment(self):
        for platform, frozen in (("darwin", False), ("linux", True)):
            environment = {}
            self.assertIsNone(configure_frozen_macos_ca(environment, platform, frozen))
            self.assertEqual(environment, {})
