"""Guards that stop a gate from reporting success when it verified nothing.

S318 found the shape in the secret scanner (an unresolvable base made the range empty), S319 in two
hand-rolled test suites (a discovery bug made "0 failed" read as success), and S320 in the environment
and artifact gates (zero checks, or an emptied expectation list, both printed PASS).

The tests here are deliberately of two kinds, and each says which it is:

* **behavioural** — the script is copied with its scope emptied and executed, so the assertion is about
  what the gate does, not about what its source contains;
* **source** — a grep for the guard, used only where running the real thing costs minutes
  (`verify-environment.sh` runs the whole toolchain). A source assertion is weaker and is labelled.
"""

import subprocess
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent


def _run(cmd: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, cwd=SCRIPTS.parent, capture_output=True, text=True, timeout=900)


def test_check_artifacts_refuses_an_empty_expectation_list(tmp_path):
    """BEHAVIOURAL: with nothing declared, --verify must refuse rather than print 'all present'."""
    source = (SCRIPTS / "check-artifacts.sh").read_text()
    for line in [
        '    "dashboard/dist"',
        '    "agent/dist"',
        '    "electron/dist-electron"',
        '    "dashboard/dist/index.html"',
        '    "agent/dist/lockdown-agent"',
        '    "agent/dist/lockdown-watchdog"',
        '    "agent/dist/lockdown-recovery"',
    ]:
        source = source.replace(line + "\n", "")

    copy = tmp_path / "check-artifacts-empty.sh"
    copy.write_text(source)
    copy.chmod(0o755)

    proc = _run(["bash", str(copy), "--verify"])

    assert proc.returncode == 3, (
        "an empty expectation list must exit 3, not report success: "
        f"rc={proc.returncode} out={proc.stdout[:200]} err={proc.stderr[:200]}"
    )
    assert "refusing to report success" in (proc.stdout + proc.stderr)


def test_verify_env_source_carries_the_zero_pass_guard():
    """SOURCE (grep): running verify-environment.sh costs minutes, so this only checks the guard exists.

    The behaviour was proven once by hand in S320 — every check recounted as SKIP produced
    'PASS: 0 FAIL: 0 SKIP: 61' and exit 1 with the message below.
    """
    text = (SCRIPTS / "verify-environment.sh").read_text()
    assert "if [[ $PASS -eq 0 ]]" in text, "the zero-PASS guard was removed"
    assert "No check ran successfully" in text


def test_the_hand_rolled_test_suites_refuse_zero_discovery():
    """SOURCE (grep): S319's guard, kept here so it is asserted from a suite that cannot be emptied."""
    for name in ("test_graph_session.py", "test_prepush_secrets.py"):
        text = (SCRIPTS / name).read_text()
        assert "NO TESTS DISCOVERED" in text, f"{name} lost its zero-discovery guard"


def test_the_secret_scanner_refuses_an_unresolvable_base():
    """SOURCE (grep): S318's guard — an unresolvable base must scan everything, not nothing."""
    text = (SCRIPTS / "prepush_secrets.py").read_text()
    assert "does not resolve" in text, "the unresolvable-base guard was removed"
    assert '"--all"' in text


if __name__ == "__main__":
    from script_test_runner import run

    raise SystemExit(run(__file__))
