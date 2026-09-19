"""Tests for the TPM clock/counter module (S1.4 resume detection).

Covers:
- TPM2_ReadClock command buffer construction
- Response parsing (pure function — no TPM needed)
- Graceful degradation on non-Windows / no-TBS
- Malformed/short/non-success responses return None

All TBS calls are mocked — no real TPM access in tests.
"""

import struct
import sys
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent.parent))
import tpm_clock


def _make_response(reset_count, restart_count, safe=1, resp_code=0, time_=0, clock=0):
    """Build a well-formed TPM2_ReadClock response buffer."""
    # header(10): tag(2) + size(4) + responseCode(4)
    header = struct.pack(">HII", tpm_clock.TPM_ST_NO_SESSIONS, 35, resp_code)
    # TPMS_TIME_INFO: time(8) + TPMS_CLOCK_INFO(clock(8)+reset(4)+restart(4)+safe(1))
    body = struct.pack(">QQII B", time_, clock, reset_count, restart_count, safe)
    return header + body


class TestCommandBuild:
    def test_command_layout(self):
        cmd = tpm_clock._build_readclock_command()
        assert len(cmd) == 10
        tag, size, cc = struct.unpack(">HII", cmd)
        assert tag == tpm_clock.TPM_ST_NO_SESSIONS
        assert size == 10
        assert cc == tpm_clock.TPM_CC_READ_CLOCK


class TestParseResponse:
    def test_parses_counters(self):
        resp = _make_response(reset_count=5, restart_count=12, safe=1)
        out = tpm_clock.parse_readclock_response(resp)
        assert out == {"reset_count": 5, "restart_count": 12, "clock_safe": True}

    def test_safe_zero(self):
        resp = _make_response(reset_count=1, restart_count=1, safe=0)
        out = tpm_clock.parse_readclock_response(resp)
        assert out["clock_safe"] is False

    def test_short_buffer_returns_none(self):
        assert tpm_clock.parse_readclock_response(b"\x00" * 10) is None
        assert tpm_clock.parse_readclock_response(b"") is None
        assert tpm_clock.parse_readclock_response(None) is None

    def test_non_success_code_returns_none(self):
        resp = _make_response(reset_count=5, restart_count=12, resp_code=0x00000100)
        assert tpm_clock.parse_readclock_response(resp) is None

    def test_big_endian_decode(self):
        # reset=0x01020304, restart=0x05060708 — verify byte order.
        resp = _make_response(reset_count=0x01020304, restart_count=0x05060708)
        out = tpm_clock.parse_readclock_response(resp)
        assert out["reset_count"] == 0x01020304
        assert out["restart_count"] == 0x05060708


class TestGracefulDegradation:
    def test_read_counters_none_on_non_windows(self):
        with patch.object(tpm_clock, "_is_windows", return_value=False):
            assert tpm_clock.read_tpm_counters() is None

    def test_read_restart_count_none_on_non_windows(self):
        with patch.object(tpm_clock, "_is_windows", return_value=False):
            assert tpm_clock.read_restart_count() is None

    def test_read_restart_count_returns_counter(self):
        fake = {"reset_count": 3, "restart_count": 9, "clock_safe": True}
        with patch.object(tpm_clock, "read_tpm_counters", return_value=fake):
            assert tpm_clock.read_restart_count() == 9

    def test_read_restart_count_propagates_none(self):
        with patch.object(tpm_clock, "read_tpm_counters", return_value=None):
            assert tpm_clock.read_restart_count() is None
