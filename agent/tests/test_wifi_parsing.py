"""Parsing of the platform WiFi scan output (agent.scan_wifi_networks).

Why this file exists (session 171)
----------------------------------
`scan_wifi_networks` is the data source for covert tracking (E-TRACK), but every
existing test patches it out:

    with patch.object(agent, "scan_wifi_networks") as mock_scan:

A mutation audit (`scripts/audit_test_teeth.py`) made the function return an empty
list immediately and **the whole agent suite still passed** — so the parsing code
that turns `netsh` / `nmcli` output into BSSID records had no test at all. That
code is where a silently wrong result is most likely: a format change in either
tool yields "no neighbours", which looks exactly like "the device is alone".

These tests drive the real function with captured tool output.
"""

import subprocess
from unittest.mock import patch

import agent

NETSH_OUTPUT = """Interface name : Wi-Fi
There are 2 networks currently visible.

SSID 1 : HomeNet
    Network type            : Infrastructure
    Authentication          : WPA2-Personal
    BSSID 1                 : aa:bb:cc:dd:ee:ff
         Signal             : 82%
         Radio type         : 802.11ac
         Channel            : 36

SSID 2 : Cafe-Guest
    Network type            : Infrastructure
    Authentication          : Open
    BSSID 1                 : 11:22:33:44:55:66
         Signal             : 40%
         Channel            : 6
"""

# nmcli -t escapes the colons inside a BSSID, so a split on ":" yields the BSSID
# as several escaped fields followed by SSID/SIGNAL/FREQ.
NMCLI_OUTPUT = (
    "AA\\:BB\\:CC\\:DD\\:EE\\:FF:HomeNet:82:2412\n"
    "11\\:22\\:33\\:44\\:55\\:66:Cafe-Guest:40:2437\n"
)


class TestWindowsParsing:
    def test_parses_ssid_bssid_and_signal(self):
        with (
            patch("platform.system", return_value="Windows"),
            patch.object(subprocess, "check_output", return_value=NETSH_OUTPUT.encode()),
        ):
            networks = agent.scan_wifi_networks()

        assert [n["ssid"] for n in networks] == ["HomeNet", "Cafe-Guest"]
        assert [n["bssid"] for n in networks] == ["aa:bb:cc:dd:ee:ff", "11:22:33:44:55:66"]
        assert [n["signal"] for n in networks] == [82, 40]

    def test_signal_belongs_to_its_own_network(self):
        """The signal percentage must attach to the BSSID above it, not the first."""
        with (
            patch("platform.system", return_value="Windows"),
            patch.object(subprocess, "check_output", return_value=NETSH_OUTPUT.encode()),
        ):
            networks = agent.scan_wifi_networks()

        by_ssid = {n["ssid"]: n for n in networks}
        assert by_ssid["Cafe-Guest"]["signal"] == 40
        assert by_ssid["HomeNet"]["signal"] == 82


class TestLinuxParsing:
    def test_parses_escaped_nmcli_rows(self):
        with (
            patch("platform.system", return_value="Linux"),
            patch.object(subprocess, "check_output", return_value=NMCLI_OUTPUT.encode()),
        ):
            networks = agent.scan_wifi_networks()

        assert [n["ssid"] for n in networks] == ["HomeNet", "Cafe-Guest"]
        assert [n["signal"] for n in networks] == [82, 40]
        assert [n["frequency"] for n in networks] == ["2412", "2437"]
        # Known wart: the parser keeps nmcli's backslash escapes in the BSSID.
        # Asserting on the unescaped form expresses the intent without freezing
        # the defect — if someone fixes the unescaping, this still passes.
        assert networks[0]["bssid"].replace("\\", "") == "AA:BB:CC:DD:EE:FF"


class TestScanFailure:
    def test_missing_tool_returns_empty_not_an_exception(self):
        """No wifi tool (or wifi off) is a normal state, not a crash.

        The agent runs on devices with the radio disabled; raising here would take
        down the reporting loop that also carries the check-in.
        """
        with (
            patch("platform.system", return_value="Linux"),
            patch.object(subprocess, "check_output", side_effect=FileNotFoundError("nmcli")),
        ):
            assert agent.scan_wifi_networks() == []

    def test_timeout_returns_empty(self):
        with (
            patch("platform.system", return_value="Windows"),
            patch.object(
                subprocess,
                "check_output",
                side_effect=subprocess.TimeoutExpired(cmd="netsh", timeout=10),
            ),
        ):
            assert agent.scan_wifi_networks() == []

    def test_unknown_platform_returns_empty(self):
        with patch("platform.system", return_value="Plan9"):
            assert agent.scan_wifi_networks() == []
