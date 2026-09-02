# -*- mode: python ; coding: utf-8 -*-
"""
PyInstaller spec for the Lockdown Lock Screen overlay.

Builds a standalone .exe that creates a fullscreen topmost window
blocking all desktop interaction. The agent launches this as a
separate process during lockdown so it can't be killed by
terminating the agent.

Usage:
    pyinstaller lock_screen.spec --noconfirm

Output:
    dist/lockdown-lockscreen.exe (Windows)
"""

import sys
from PyInstaller.utils.hooks import collect_submodules

block_cipher = None

hiddenimports = collect_submodules('ctypes') + [
    'ctypes.wintypes',
    'winreg',
]

a = Analysis(
    ['lock_screen.py'],
    pathex=[],
    binaries=[],
    datas=[],
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
        'requests',
        'urllib3',
        'cryptography',
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
    name='lockdown-lockscreen',
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
    console=True,  # Temporarily True to debug — change back to False after fix
    disable_windowed_traceback=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
