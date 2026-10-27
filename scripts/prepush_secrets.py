#!/usr/bin/env python3
"""Scan a git range for credential-shaped content before it is published.

Two tiers, because a scanner that cries wolf gets disabled:

  FAIL  — high-confidence credentials: private-key blocks, and tokens in known
          vendor formats (AWS, GitHub, Slack, OpenAI-style `sk-`), plus
          keyword assignments like `password = "..."`. Also any literal listed
          in the forbidden-terms file/env (see below).

  WARN  — high-entropy tokens that are not known vendor formats and are not
          pure hex. This repo quotes SHA-256 artifact hashes in its docs, so
          pure-hex strings are ignored; anything else that looks like a
          credential is reported without failing the push.

The forbidden-terms mechanism exists because the S140 leak was a credential
quoted in a markdown log with no keyword next to it (`… -S '<value>' …`),
which no keyword rule can catch:

    PREPUSH_FORBIDDEN='value1,value2'   # never committed
    <git-dir>/prepush-forbidden.txt     # one value per line, never committed

Nothing in this file echoes a matched value. Findings print the rule, commit,
file and line number only — quoting the secret to prove it leaked is how S140
leaked it in the first place.
"""

import argparse
import fnmatch
import os
import re
import subprocess
import sys

FAIL_PATTERNS = [
    ("private-key-block", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
    ("aws-access-key", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    ("github-token", re.compile(r"\bgh[pousr]_[A-Za-z0-9]{36,}\b")),
    ("github-pat", re.compile(r"\bgithub_pat_[A-Za-z0-9_]{22,}\b")),
    ("slack-token", re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}\b")),
    ("openai-style-key", re.compile(r"\bsk-[A-Za-z0-9]{20,}\b")),
    (
        "assigned-secret",
        re.compile(
            r"(?i)\b(?:password|passwd|pwd|secret|token|api[_-]?key)\b"
            r"\s*['\"]?\s*(?<![!<>])(?::|=)(?!=)\s*['\"]([^'\"]{6,})['\"]"
        ),
    ),
]

# Placeholder *substrings*: example/test/changeme values are not credentials.
PLACEHOLDER = re.compile(
    r"(?i)(?:change[_-]?me|changeme|redacted|removed|placeholder|example|sample|"
    r"dummy|fake|test|todo|fixme|your[_-]|x{3,}|\*{2,}|<[^>]*>)"
)
SCRUBBED_MARKER = re.compile(r"\*\*\*(?:REMOVED|REDACTED)")

# Private keys and dummy credentials are expected in test fixtures, and
# placeholder examples are expected in docs/. Those are downgraded to advisory:
# failing there would block every push for values that are deliberately fake.
# Paths outside these (source, scripts, and especially the .devin/ session logs
# where S140 actually leaked) stay fatal.
FIXTURE_PATH = re.compile(
    r"(?:^|/)(?:tests?|__tests__|fixtures?|__mocks__|[\w.]+-test)/"
    r"|\.(?:test|spec)\.[jt]sx?$"
)
EXAMPLE_PATH = re.compile(r"(?:^|/)docs?/")

# Reviewable allow-list: `<rule>:<path-glob>  # justification`, one per line.
# Paths and rule names only — never values — so it cannot become the leak it is
# meant to prevent. An entry downgrades that rule for that path to advisory.
ALLOW_FILE = ".prepush-allow.txt"

# A token is "entropy-shaped" when it is long, mixes three character classes,
# and is not a plain hex digest (this repo stores SHA-256s in docs and
# fixtures). Opt-in only: across a long range this fires on ordinary code, and
# a noisy advisory trains people to ignore the tool.
PURE_HEX = re.compile(r"^[0-9a-fA-F]+$")
TOKEN = re.compile(r"[A-Za-z0-9_!@#$%^&*+=~-]{20,}")
ADDED_LINE = re.compile(r"^\+(?!\+\+)")


def git(*args):
    return subprocess.run(
        ["git", *args], capture_output=True, text=True, check=False
    ).stdout


def forbidden_terms(repo_root):
    terms = []
    env = os.environ.get("PREPUSH_FORBIDDEN", "")
    terms += [t.strip() for t in env.split(",") if t.strip()]

    git_dir = git("rev-parse", "--git-dir").strip() or ".git"
    path = os.path.join(repo_root, git_dir, "prepush-forbidden.txt")
    if os.path.isfile(path):
        try:
            with open(path, encoding="utf-8", errors="replace") as fh:
                terms += [line.strip() for line in fh if line.strip()]
        except OSError as exc:
            # A missing/unreadable hint file must not silently weaken the scan.
            print(
                f"[WARN] cannot read forbidden-terms file {path}: {exc}",
                file=sys.stderr,
            )
    # Longest first so a substring never shadows a longer term.
    return sorted(set(terms), key=len, reverse=True)


def entropy_candidates(line):
    """Long non-hex tokens spanning three character classes."""
    out = []
    for match in TOKEN.finditer(line):
        tok = match.group(0)
        if PURE_HEX.match(tok):
            continue
        classes = sum(
            [
                any(c.islower() for c in tok),
                any(c.isupper() for c in tok),
                any(c.isdigit() for c in tok),
                any(not c.isalnum() for c in tok),
            ]
        )
        if classes >= 3:
            out.append(tok)
    return out


def allow_rules(repo_root):
    """Read `<rule>:<path-glob>` allow entries (paths/rules only, no values)."""
    path = os.path.join(repo_root, ALLOW_FILE)
    entries = []
    if not os.path.isfile(path):
        return entries
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            for raw in fh:
                line = raw.split("#", 1)[0].strip()
                if not line or ":" not in line:
                    continue
                rule, _, glob = line.partition(":")
                entries.append((rule.strip(), glob.strip()))
    except OSError as exc:
        print(f"[WARN] cannot read {path}: {exc}", file=sys.stderr)
    return entries


def is_allowed(rule, path, entries):
    return any(
        fnmatch.fnmatch(rule, rule_glob) and fnmatch.fnmatch(path, path_glob)
        for rule_glob, path_glob in entries
    )


def scan_range(rev_range, terms, entropy=False, allowed=None):
    """Deduplicated scan of the added lines in a revision range.

    Findings are keyed by (rule, path, commit) so one bad file reports once per
    commit instead of once per line — an unreadable report is an ignored report.
    """
    fails = {}          # (rule, path, commit) -> subject
    advisory = {}       # (rule, path, commit) -> subject
    token_files = {}    # path -> count of high-entropy added lines

    commits = [c for c in git("rev-list", *rev_range, "--").splitlines() if c]
    for commit in commits:
        subject = git("log", "-1", "--format=%h %s", commit).strip()
        patch = git("show", "--format=", "--no-color", "--no-ext-diff", "-p", commit)
        current_file = "?"
        for line in patch.splitlines():
            if line.startswith("+++ b/"):
                current_file = line[6:]
                continue
            if not ADDED_LINE.match(line):
                continue
            body = line[1:]

            # A scrubbed value is not a secret; it is the tombstone.
            if SCRUBBED_MARKER.search(body):
                continue

            for rule, pattern in FAIL_PATTERNS:
                match = pattern.search(body)
                if not match:
                    continue
                if rule == "assigned-secret" and PLACEHOLDER.search(match.group(1)):
                    continue
                downgraded = (
                    is_allowed(rule, current_file, allowed or [])
                    or FIXTURE_PATH.search(current_file)
                    or EXAMPLE_PATH.search(current_file)
                )
                bucket = advisory if downgraded else fails
                bucket[(rule, current_file, commit)] = subject

            for term in terms:
                if term in body:
                    fails[("forbidden-term", current_file, commit)] = subject
                    break

            if entropy and entropy_candidates(body):
                token_files[current_file] = token_files.get(current_file, 0) + 1

    return fails, advisory, token_files


def main():
    ap = argparse.ArgumentParser(description="Scan a git range for secrets.")
    ap.add_argument("--base", help="exclusive lower bound (e.g. origin/master)")
    ap.add_argument("--head", default="HEAD", help="inclusive upper bound (default HEAD)")
    ap.add_argument("--all", action="store_true", help="scan every reachable commit")
    ap.add_argument("--verbose", action="store_true", help="list high-entropy files")
    ap.add_argument(
        "--entropy", action="store_true", help="also report high-entropy tokens"
    )
    ap.add_argument("--max-lines", type=int, default=25, help="cap on printed findings")
    args = ap.parse_args()

    if args.all or not args.base:
        rev_range = ["--all"] if args.all else ["HEAD"]
    else:
        rev_range = [f"{args.base}..{args.head}"]

    repo_root = git("rev-parse", "--show-toplevel").strip() or "."
    fails, advisory, token_files = scan_range(
        rev_range,
        forbidden_terms(repo_root),
        entropy=args.entropy,
        allowed=allow_rules(repo_root),
    )
    where = " ".join(rev_range)

    ordered = sorted(fails.items())
    for index, ((rule, path, _commit), subject) in enumerate(ordered):
        if index >= args.max_lines:
            print(f"... and {len(ordered) - index} more (raise --max-lines)")
            break
        print(f"[FAIL] {rule}: {path}  ({subject})")

    for (rule, path, _commit), subject in sorted(advisory.items())[:10]:
        print(f"[WARN] {rule} in fixture/example: {path}  ({subject})")

    if token_files:
        total = sum(token_files.values())
        print(
            f"[WARN] high-entropy tokens: {total} added line(s) across "
            f"{len(token_files)} file(s) — advisory only"
        )
        if args.verbose:
            for path, count in sorted(token_files.items(), key=lambda kv: -kv[1])[:20]:
                print(f"       {path} ({count})")

    if fails:
        print(
            f"\n{len(fails)} credential-shaped finding(s) in '{where}'.\n"
            "The value is deliberately not printed here. Inspect the commit\n"
            "above, remove the value, and rewrite that commit before pushing.\n"
            "If it is a false positive, put the value in the local\n"
            "forbidden-terms file rather than editing this scanner.",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
