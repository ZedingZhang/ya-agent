"""TLS configuration for frozen desktop builds."""

from __future__ import annotations

import os
from pathlib import Path
import sys


MACOS_SYSTEM_CERT_FILE = Path("/private/etc/ssl/cert.pem")


def configure_frozen_macos_ca(
    environ: dict[str, str] | None = None,
    platform: str | None = None,
    frozen: bool | None = None,
    cert_file: Path = MACOS_SYSTEM_CERT_FILE,
) -> str | None:
    """Use the macOS system CA bundle for frozen GUI applications.

    PyInstaller's embedded Python can otherwise use a separate CA bundle that
    omits a locally trusted proxy root. An explicit user override always wins.
    """
    values = os.environ if environ is None else environ
    current_platform = sys.platform if platform is None else platform
    is_frozen = bool(getattr(sys, "frozen", False)) if frozen is None else frozen
    if current_platform != "darwin" or not is_frozen or values.get("SSL_CERT_FILE"):
        return None
    if not cert_file.is_file():
        return None
    values["SSL_CERT_FILE"] = str(cert_file)
    return str(cert_file)
