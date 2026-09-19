"""tpm_clock.py — OS-side TPM clock/counter read for S1.4 resume detection.

Reads TPMS_TIME_INFO via TPM2_ReadClock through the Windows TPM Base
Services (TBS) API. This is the agent-side counterpart to the firmware's
PblTpmReadRestartCounter (TpmClient.c) — same command, different
privilege domain.

Why OS-side (S1.4): PBL never runs on an S3 resume (the PEI S3 path jumps
straight to the OS resume vector, bypassing DXE/BDS — research finding
F6). So the firmware cannot report a resume; only the OS-side agent can
observe the tell. On S3 resume the TPM is started with TPM2_Startup(STATE),
which increments restartCount but NOT resetCount (the boot_id). The server
compares the agent-reported restartCount against the last PBL-recorded
boot_id (resetCount):

    restartCount > last_boot_id   → a wake happened without a cold boot
                                    → S3 resume (downgrade the S1.2 alarm)
    restartCount == last_boot_id  → no wake since last cold boot; a stale
                                    last_boot_at is a genuine bypass signal

TPM2_ReadClock requires no authorization and no session, so the agent can
issue it unprivileged through TBS. Non-Windows (or no-TBS) returns None —
absence is a signal the server treats as "unknown", not "resume".

Wire format (TPM 2.0 Part 3 §23.4):
    command:  tag(2) + size(4) + cc(4) = TPM_ST_NO_SESSIONS(0x8001) +
             10 + TPM_CC_ReadClock(0x00000181)
    response: header(10) + TPMS_TIME_INFO
             TPMS_TIME_INFO  = time(8) + TPMS_CLOCK_INFO
             TPMS_CLOCK_INFO = clock(8) + resetCount(4) + restartCount(4)
                               + safe(1)

Copyright (c) 2026 Remote Lockdown System. All rights reserved.
"""

from __future__ import annotations

import logging
import struct
import sys

log = logging.getLogger(__name__)

# TPM 2.0 constants (Part 2)
TPM_ST_NO_SESSIONS = 0x8001
TPM_RC_SUCCESS = 0x00000000
TPM_CC_READ_CLOCK = 0x00000181

# TBS result codes
TBS_SUCCESS = 0x00000000


def _is_windows() -> bool:
    return sys.platform == "win32"


def _build_readclock_command() -> bytes:
    """Build the TPM2_ReadClock command buffer (10 bytes, no handles/params).

    Layout: tag(2) + commandSize(4) + commandCode(4), all big-endian.
    """
    return struct.pack(">HII", TPM_ST_NO_SESSIONS, 10, TPM_CC_READ_CLOCK)


def parse_readclock_response(resp: bytes) -> dict | None:
    """Parse a TPM2_ReadClock response into counter fields.

    Pure function — separated from the TBS submission so it is unit-testable
    without a TPM. Mirrors PblTpmReadRestartCounter's parse (TpmClient.c).

    Args:
        resp: raw response bytes including the 10-byte TPM response header.

    Returns:
        dict {reset_count, restart_count, clock_safe} on success; None on a
        short/malformed buffer or non-TPM_RC_SUCCESS response code.
    """
    # Minimum: header(10) + time(8) + clock(8) + resetCount(4)
    #          + restartCount(4) + safe(1) = 35 bytes.
    if not resp or len(resp) < 35:
        return None

    resp_code = struct.unpack_from(">I", resp, 6)[0]
    if resp_code != TPM_RC_SUCCESS:
        return None

    # Skip header(10) + time(8) + clock(8) → offset 26.
    reset_count, restart_count = struct.unpack_from(">II", resp, 26)
    clock_safe = resp[34] != 0
    return {
        "reset_count": reset_count,
        "restart_count": restart_count,
        "clock_safe": clock_safe,
    }


def read_tpm_counters() -> dict | None:
    """Read resetCount/restartCount/safe via TPM2_ReadClock through TBS.

    Returns:
        dict with keys ``reset_count``, ``restart_count``, ``clock_safe``
        on success; ``None`` when the TPM/TBS is unavailable or the command
        fails. Never raises — a TPM read failure must not break check-in.
    """
    if not _is_windows():
        return None

    try:
        import ctypes
        from ctypes import wintypes
    except ImportError:
        return None

    try:
        tbs = ctypes.windll.tbs
    except (OSError, AttributeError):
        log.debug("TBS (tbs.dll) not available")
        return None

    cmd = _build_readclock_command()
    resp_buf = (ctypes.c_ubyte * 128)()
    resp_size = wintypes.DWORD(len(resp_buf))

    # TbsSubmitBlockingCommand? No — the stable TBS 2.0 surface is
    # Tbsi_Submit_Command (XP-era) via tbs.dll's exported
    # Tbsi_Submit_Command / Tbsip_Submit_Command. On Windows 8+ the
    # documented entry is TbsSubmitCommand via the TBS context; the
    # simplest reliable path that avoids context management is
    # Tbsip_Submit_Command with the special "system" context.
    #
    # We use Tbsip_Submit_Command which takes a context handle of 0
    # (TBS_CONTEXT_LOCALITY_ZERO default) on modern Windows when called
    # through the documented Tbsi_Get_TCG_Log path... — but the simplest
    # supported approach is opening a real TBS context. We use
    # Tbsi_Context_Create + Tbsip_Submit_Command + Tbsip_Context_Close.
    context = ctypes.c_void_p(0)

    # TBS_CONTEXT_PARAMS2 (version 2) — but version-1 TBS_CONTEXT_PARAMS
    # suffices for a locality-0 command. version=1, reserved=0.
    class TBS_CONTEXT_PARAMS(ctypes.Structure):
        _fields_ = [("version", wintypes.DWORD), ("reserved", wintypes.DWORD)]

    params = TBS_CONTEXT_PARAMS(1, 0)

    create_ctx = tbs.Tbsi_Context_Create
    create_ctx.argtypes = [ctypes.POINTER(TBS_CONTEXT_PARAMS), ctypes.POINTER(ctypes.c_void_p)]
    create_ctx.restype = wintypes.DWORD

    rc = create_ctx(ctypes.byref(params), ctypes.byref(context))
    if rc != TBS_SUCCESS or not context:
        log.debug("Tbsi_Context_Create failed: rc=0x%08x", rc)
        return None

    try:
        submit = tbs.Tbsip_Submit_Command
        submit.argtypes = [
            ctypes.c_void_p,  # context
            wintypes.DWORD,  # locality (0)
            wintypes.DWORD,  # priority (NORMAL=200? use 0)
            ctypes.POINTER(ctypes.c_ubyte),  # cmd buffer
            wintypes.DWORD,  # cmd size
            ctypes.POINTER(ctypes.c_ubyte),  # resp buffer
            ctypes.POINTER(wintypes.DWORD),  # resp size in/out
        ]
        submit.restype = wintypes.DWORD

        TBS_LOCALITY_ZERO = 0
        TBS_PRIORITY_NORMAL = 300  # TBS_COMMAND_PRIORITY_NORMAL

        cmd_buf = (ctypes.c_ubyte * len(cmd)).from_buffer_copy(cmd)
        rc = submit(
            context,
            TBS_LOCALITY_ZERO,
            TBS_PRIORITY_NORMAL,
            cmd_buf,
            len(cmd),
            resp_buf,
            ctypes.byref(resp_size),
        )
        if rc != TBS_SUCCESS:
            log.debug("Tbsip_Submit_Command failed: rc=0x%08x", rc)
            return None
    finally:
        close_ctx = tbs.Tbsip_Context_Close
        close_ctx.argtypes = [ctypes.c_void_p]
        close_ctx.restype = wintypes.DWORD
        close_ctx(context)

    n = resp_size.value
    resp = bytes(resp_buf[:n])

    parsed = parse_readclock_response(resp)
    if parsed is None:
        log.debug("TPM2_ReadClock malformed/failed response (%d bytes)", n)
    return parsed


def read_restart_count() -> int | None:
    """Convenience: just the restart counter (S1.4 resume signal).

    Returns restartCount on success, None otherwise.
    """
    counters = read_tpm_counters()
    return counters["restart_count"] if counters else None
