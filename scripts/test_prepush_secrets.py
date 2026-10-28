#!/usr/bin/env python3
"""Tests for scripts/prepush_secrets.py — the publish-range secret scanner.

The scanner became a CI gate (`secrets` job in lint.yml) without ever having a
test, and it has already caused two real incidents:

  * it blocked a legitimate push on a fixture value, which is how the
    `.prepush-allow.txt` allow-list got introduced;
  * the allow-list's own justifications quoted the matched text, so the allow-list
    file became the finding — surfaced only by the full-history scan that a
    force-push triggers.

So the properties worth locking are not just "does it find a secret" but:
  * it never echoes the matched value (the S140 lesson: proving a leak by quoting
    it re-leaks it),
  * fixture/allow-list downgrades work and stay narrow,
  * `--all` sees history that a range scan does not.

Run: python3 scripts/test_prepush_secrets.py
"""

import os
import subprocess
import sys
import tempfile
from pathlib import Path

_SCRIPTS_DIR = Path(__file__).resolve().parent
SCANNER = _SCRIPTS_DIR / "prepush_secrets.py"

# Assembled at runtime so this test file does not itself trip the scanner when the
# scanner is run over the repository history.
AWS_KEY = "AKIA" + "QWERTYUIOPASDFGH"
PRIVATE_KEY_LINE = "-----BEGIN " + "RSA PRIVATE KEY-----"
ASSIGNED_SECRET = 'password = "' + "correct-horse-battery" + '"'

FAILED: list[str] = []


def check(name: str, condition, detail: str = "") -> None:
    if condition:
        print(f"  ✓ {name}")
    else:
        print(f"  ✗ {name} {detail}")
        FAILED.append(name)


def git(repo: Path, *args: str) -> str:
    return subprocess.run(
        ["git", *args], cwd=repo, capture_output=True, text=True, check=True
    ).stdout.strip()


def make_repo(files: dict[str, str], base_files: dict[str, str] | None = None) -> tuple[Path, str, str]:
    """Create a repo with an optional base commit. Returns (repo, base_sha, tip_sha)."""
    repo = Path(tempfile.mkdtemp(prefix="prepush-test-"))
    git(repo, "init", "-q", ".")
    git(repo, "config", "user.email", "test@example.com")
    git(repo, "config", "user.name", "test")

    (repo / "README.md").write_text("base\n")
    for name, body in (base_files or {}).items():
        path = repo / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(body)
    git(repo, "add", "-A")
    git(repo, "commit", "-qm", "base")
    base = git(repo, "rev-parse", "HEAD")

    for name, body in files.items():
        path = repo / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(body)
    git(repo, "add", "-A")
    git(repo, "commit", "-qm", "change")
    return repo, base, git(repo, "rev-parse", "HEAD")


def scan(repo: Path, *args: str) -> tuple[int, str]:
    proc = subprocess.run(
        [sys.executable, str(SCANNER), *args],
        cwd=repo,
        capture_output=True,
        text=True,
        env={**os.environ, "PREPUSH_FORBIDDEN": ""},
    )
    return proc.returncode, proc.stdout + proc.stderr


def test_clean_history_passes():
    repo, base, _ = make_repo({"src/app.js": "console.log('hello');\n"})
    code, out = scan(repo, "--base", base, "--head", "HEAD")
    check("clean change exits 0", code == 0, out[:200])


def test_vendor_token_fails_and_is_never_echoed():
    repo, base, _ = make_repo({"src/creds.js": f"const k = '{AWS_KEY}';\n"})
    code, out = scan(repo, "--base", base, "--head", "HEAD")
    check("vendor token exits 1", code == 1, out[:200])
    check("finding names the rule", "aws-access-key" in out, out[:200])
    check("the matched value is NOT printed", AWS_KEY not in out, "value leaked into output")


def test_private_key_block_fails_and_is_never_echoed():
    repo, base, _ = make_repo({"src/key.pem": f"{PRIVATE_KEY_LINE}\nMIIabc\n"})
    code, out = scan(repo, "--base", base, "--head", "HEAD")
    check("private key block exits 1", code == 1, out[:200])
    check("rule is reported", "private-key-block" in out, out[:200])
    check("key body is not echoed", "MIIabc" not in out, "key material leaked")


def test_assigned_secret_in_source_fails():
    repo, base, _ = make_repo({"src/app.js": ASSIGNED_SECRET + ";\n"})
    code, out = scan(repo, "--base", base, "--head", "HEAD")
    check("assigned secret in src/ exits 1", code == 1, out[:200])
    check("value is not echoed", "correct-horse-battery" not in out)


def test_fixture_paths_are_advisory_not_fatal():
    repo, base, _ = make_repo({"tests/thing.test.js": ASSIGNED_SECRET + ";\n"})
    code, out = scan(repo, "--base", base, "--head", "HEAD")
    check("same value under tests/ exits 0", code == 0, out[:200])
    check("but it is still reported as advisory", "[WARN]" in out, out[:200])


def test_placeholder_values_are_ignored_entirely():
    repo, base, _ = make_repo({"src/app.js": 'password = "test-placeholder-value";\n'})
    code, out = scan(repo, "--base", base, "--head", "HEAD")
    check("placeholder value is ignored", code == 0 and "[FAIL]" not in out, out[:200])


def test_allowlist_downgrades_one_rule_for_one_path():
    repo, base, _ = make_repo(
        {
            "src/app.js": ASSIGNED_SECRET + ";\n",
            ".prepush-allow.txt": "assigned-secret:src/app.js  # reviewed: fixture constant\n",
        }
    )
    code, out = scan(repo, "--base", base, "--head", "HEAD")
    check("allow-listed finding exits 0", code == 0, out[:300])
    check("downgraded finding is still reported", "[WARN]" in out, out[:300])


def test_allowlist_does_not_downgrade_other_rules():
    """An entry is scoped to one rule; a different rule on the same path still fails."""
    repo, base, _ = make_repo(
        {
            "src/creds.js": f"const k = '{AWS_KEY}';\n",
            ".prepush-allow.txt": "assigned-secret:src/creds.js  # reviewed\n",
        }
    )
    code, out = scan(repo, "--base", base, "--head", "HEAD")
    check("other rule on an allow-listed path still fails", code == 1, out[:300])


def test_matched_text_inside_the_allowlist_itself_fails():
    """Regression: quoting the pattern in .prepush-allow.txt makes that file the leak."""
    repo, base, _ = make_repo(
        {
            ".prepush-allow.txt": (
                "assigned-secret:src/app.js  # reviewed, see " + ASSIGNED_SECRET + "\n"
            ),
        }
    )
    code, out = scan(repo, "--base", base, "--head", "HEAD")
    check("allow-list quoting the pattern is a FAIL", code == 1, out[:300])
    check("the finding points at the allow-list", ".prepush-allow.txt" in out, out[:300])


def test_all_scans_history_that_the_range_does_not():
    """A secret that only exists in an older commit: range clean, --all fails."""
    repo = Path(tempfile.mkdtemp(prefix="prepush-all-"))
    git(repo, "init", "-q", ".")
    git(repo, "config", "user.email", "test@example.com")
    git(repo, "config", "user.name", "test")

    (repo / "creds.js").write_text(f"const k = '{AWS_KEY}';\n")
    git(repo, "add", "-A")
    git(repo, "commit", "-qm", "add leak")
    (repo / "creds.js").unlink()
    git(repo, "add", "-A")
    git(repo, "commit", "-qm", "remove leak")
    tip_parent = git(repo, "rev-parse", "HEAD~1")

    range_code, range_out = scan(repo, "--base", tip_parent, "--head", "HEAD")
    all_code, all_out = scan(repo, "--all")

    check("removal commit alone is clean", range_code == 0, range_out[:200])
    check("--all still finds the historical leak", all_code == 1, all_out[:200])


if __name__ == "__main__":
    print("=== test_prepush_secrets.py ===")
    tests = [(n, f) for n, f in sorted(globals().items()) if n.startswith("test_") and callable(f)]
    print(f"    {len(tests)} tests discovered")
    print()
    for _name, _fn in tests:
        _fn()
    print()
    if FAILED:
        print(f"  {len(FAILED)} check(s) FAILED: {', '.join(FAILED)}")
        sys.exit(1)
    print("  all checks passed")
    sys.exit(0)
