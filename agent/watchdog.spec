# -*- mode: python ; coding: utf-8 -*-
"""
PyInstaller spec file for the Lockdown Agent Watchdog.

Builds a single-file executable that monitors and restarts the lockdown-agent
binary. Expects the lockdown-agent binary to be in the same directory as
this executable at runtime.

Usage:
    pyinstaller watchdog.spec

Output:
    dist/lockdown-watchdog (Linux/macOS) or dist/lockdown-watchdog.exe (Windows)
"""

import sys
from PyInstaller.utils.hooks import collect_submodules

block_cipher = None

hiddenimports = []

binaries = []
datas = []

a = Analysis(
    ['watchdog.py'],
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
        'tkinter',
        'cryptography',  # watchdog doesn't use crypto
        'requests',      # watchdog doesn't make HTTP requests
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
    name='lockdown-watchdog',
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
    console=True,
    disable_windowed_traceback=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
