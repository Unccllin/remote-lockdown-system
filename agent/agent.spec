# -*- mode: python ; coding: utf-8 -*-
"""
PyInstaller spec file for the Remote Lockdown Agent.

Builds a single-file executable that includes all Python dependencies
(cryptography, requests) and the agent's helper modules.

Usage:
    pyinstaller agent.spec

Output:
    dist/lockdown-agent (Linux/macOS) or dist/lockdown-agent.exe (Windows)

The resulting executable:
  - Reads config from --config <path>, config.json, config.ini, or
    system config directories (see agent.py _CONFIG_SEARCH_PATHS)
  - Runs as a standalone binary (no Python installation required)
  - Supports --silent, --version, --config flags

Note: Boot lockdown modules (hp_uefi_lockdown, bcd_lockdown) are
Windows-only and imported lazily. On Linux, they're excluded from
the bundle automatically (ImportError is caught at runtime).
"""

import sys
from PyInstaller.utils.hooks import collect_submodules

block_cipher = None

# Collect all submodules from cryptography (it has many internal modules
# that PyInstaller might miss)
hiddenimports = collect_submodules('cryptography') + [
    'requests',
    'urllib3',
    'certifi',
    'charset_normalizer',
    'idna',
    'sqlite3',  # Phase 5: offline queue database
]

# Boot lockdown modules (Windows-only, but include if available)
if sys.platform == 'win32':
    hiddenimports += ['hp_uefi_lockdown', 'bcd_lockdown']

# State crypto modules (Layer 2/3: TPM sealing + DPAPI encryption)
# These are imported lazily by agent.py, so PyInstaller needs them listed.
hiddenimports += ['state_crypto', 'tpm_seal']

# New feature modules (imported lazily by agent.py with import guards)
# duress: duress code + hidden file trigger
# tamper_protection: 5-layer tamper detection (Windows-only, lazy import)
# watchdog: process monitor (Windows-only, lazy import)
# lock_screen: fullscreen topmost overlay that blocks desktop interaction
hiddenimports += ['duress', 'tamper_protection', 'watchdog', 'lock_screen']

# Data files to include (config template)
datas = [
    ('config.ini.example', '.'),
]

# Binaries (none additional needed)
binaries = []

a = Analysis(
    ['agent.py'],
    pathex=[],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        # Exclude test/dev modules to reduce bundle size
        'pytest',
        'unittest',
        'pydoc',
        'doctest',
        'pdb',
        'IPython',
        'matplotlib',
        'numpy',
        'PIL',
        'tkinter',
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
    name='lockdown-agent',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    # UPX can significantly reduce the executable size, but may trigger
    # false positives in some antivirus software. Enable with caution.
    upx_exclude=[
        'vcruntime140.dll',
        'python3.dll',
        'VCRUNTIME140_1.dll',
    ],
    runtime_tmpdir=None,
    # console=True + hide_console='hide-late' keeps stdout/stderr working
    # when launched from cmd/PowerShell (--version, --debug work) but hides
    # the console window when double-clicked or launched by the scheduler.
    # This fixes the "no output" bug where console=False made sys.stdout
    # None, causing --version to silently fail and crash tracebacks to be
    # invisible.
    console=True,
    hide_console='hide-late',
    disable_windowed_traceback=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    # icon='agent-icon.ico',  # Add icon file when available
)
