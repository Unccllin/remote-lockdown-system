# -*- mode: python ; coding: utf-8 -*-
"""
PyInstaller spec file for the Offline Recovery Tool.

Builds a single-file executable that IT staff can use to recover a locked
device when the server is unavailable. Uses the RSA-wrapped recovery key
file combined with IT's offline master private key.

Usage:
    pyinstaller offline_recovery.spec

Output:
    dist/lockdown-recovery (Linux/macOS) or dist/lockdown-recovery.exe (Windows)

The resulting executable:
  - Reads a recovery key file (.recovery_key or .deadman_key)
  - Decrypts the Fernet data key using an RSA private key
  - Decrypts the locked folder
  - Optionally prints a wrapped BIOS password
  - No server connection required — works on a mounted disk image
"""

import sys
from PyInstaller.utils.hooks import collect_submodules

block_cipher = None

# Collect all submodules from cryptography (it has many internal modules
# that PyInstaller might miss)
hiddenimports = collect_submodules('cryptography')

binaries = []
datas = []

a = Analysis(
    ['offline_recovery.py'],
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
        'requests',  # offline_recovery doesn't make HTTP requests
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
    name='lockdown-recovery',
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
