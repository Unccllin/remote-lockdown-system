# -*- mode: python ; coding: utf-8 -*-
"""
PyInstaller spec for the Lockdown Setup Wizard (GUI installer).

Builds a single-file .exe with no console window. The wizard:
  1. Auto-elevates to admin (UAC prompt)
  2. Collects enrollment token + hardware IDs
  3. Enrolls the device, installs the agent, starts the service
  4. Optionally runs hardware self-tests

Usage:
    pyinstaller installer_gui.spec

Output:
    dist/lockdown-setup.exe  (Windows GUI app, no console)

Note: The agent binary (lockdown-agent.exe) must be placed next to
this installer for it to copy during installation. Build the agent
first with `pyinstaller agent.spec`, then build this installer.
"""

import sys
from PyInstaller.utils.hooks import collect_submodules

block_cipher = None

hiddenimports = collect_submodules('cryptography') + [
    'requests',
    'urllib3',
    'certifi',
    'charset_normalizer',
    'idna',
    'sqlite3',
    'service_installer',
    'tamper_protection',
    'state_crypto',
    'tpm_seal',
    'duress',
    'watchdog',
]

# Data files
datas = []

# Binaries — the agent exe is NOT bundled in the installer.
# Instead, the installer downloads it from the Worker at install time
# (GET /api/download/agent). This keeps the installer small enough to
# serve from Cloudflare KV (< 25MB) and allows updating the agent
# without rebuilding the installer.
binaries = []

a = Analysis(
    ['installer_gui.py'],
    pathex=[],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        'pytest',
        'unittest',
        'pydoc',
        'doctest',
        'pdb',
        'IPython',
        'matplotlib',
        'numpy',
        'PIL',
    ],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name='lockdown-setup',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[
        'vcruntime140.dll',
        'python3.dll',
        'VCRUNTIME140_1.dll',
    ],
    runtime_tmpdir=None,
    console=False,  # GUI app — no console window
    disable_windowed_traceback=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    # Request admin privileges via UAC
    uac_admin=True,
    # icon='lockdown-icon.ico',  # Add icon when available
)
