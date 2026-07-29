"""PyInstaller-safe native GUI entrypoint."""

from ya.tls import configure_frozen_macos_ca
from ya.gui import main


configure_frozen_macos_ca()
raise SystemExit(main())
