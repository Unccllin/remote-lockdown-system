# -*- mode: python ; coding: utf-8 -*-
"""
PyInstaller spec for the CLI agent installer (installer.py).

Builds dist/lockdown-installer.exe — the program the generic NSIS installer
delegates to (see installer/generic/lockdown-installer.nsi). It is the same
installer a per-device deployment runs, so enrollment, config generation,
the lockdown folder, persistence and check-in verification all live in one
Python path instead of being reimplemented in the .nsi script.

It carries both directions:
  * install   — enrol with an enrollment token (POST /api/enroll/claim),
                write config.json, install the scheduled task + run key,
                apply tamper protection, verify check-in
  * uninstall — verify a backend-issued uninstall token and remove that
                persistence (service_installer.uninstall)

Usage:
    py -m PyInstaller installer.spec

Output:
    dist/lockdown-installer.exe

Unlike installer_gui.spec this bundle does NOT download anything: the NSIS
wrapper stages lockdown-agent.exe (and, when present, lockdown-watchdog.exe and
lockdown-lockscreen.exe) beside it, which is why console=True — the .nsi script
captures its exit code and log output through nsExec.
"""

import sys
from PyInstaller.utils.hooks import collect_submodules

block_cipher = None

# installer.py imports service_installer and tamper_protection lazily inside
# functions, so PyInstaller cannot see them by scanning imports. Missing them
# is not a build failure — it is a silent install that skips persistence and a
# silent uninstall that leaves the task behind, so they are listed explicitly.
hiddenimports = collect_submodules('cryptography') + [
    'requests',
    'urllib3',
    'certifi',
    'charset_normalizer',
    'idna',
    'service_installer',
    'tamper_protection',
]

a = Analysis(
    ['installer.py'],
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
        # The CLI installer never opens a window; tkinter would add ~10MB.
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
    name='lockdown-installer',
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
    # console=True so nsExec captures the install log and the exit code the
    # NSIS wrapper gates success on. hide_console='hide-late' keeps the window
    # out of the way when an operator double-clicks the exe directly.
    console=True,
    hide_console='hide-late',
    disable_windowed_traceback=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    uac_admin=True,
    # icon='lockdown-icon.ico',  # Add icon when available
)
