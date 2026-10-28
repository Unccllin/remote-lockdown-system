#!/usr/bin/env python3
"""Emit a GitHub Actions error annotation carrying the tail of a log file.

Why this exists
---------------
The repository is public, so workflow *runs*, *jobs* and *check runs* can be
read anonymously — but **job logs cannot**: `GET /actions/jobs/{id}/logs`
answers `403 Must have admin rights to Repository` without a token. On the
machine that runs these sessions there is no `gh` and no token, so a red CI job
used to be a dead end: the job name was visible, the reason was not.

Annotations are the exception. GitHub renders them from the check run, and
`GET /repos/{owner}/{repo}/check-runs/{id}/annotations` works unauthenticated on
a public repository. So a job that annotates the tail of its own failing output
becomes diagnosable from anywhere — no credentials, no log download.

Usage (inside a workflow step):

    - run: |
        set -o pipefail
        npm run test:coverage 2>&1 | tee /tmp/ci-output.log
    - if: failure()
      run: python3 ../scripts/ci-annotate.py /tmp/ci-output.log "coverage output"

The annotation is percent-escaped the way the workflow-command protocol
requires (`%` -> `%25`, CR -> `%0D`, LF -> `%0A`); other characters stay
literal, which keeps stack traces and coverage tables readable.
"""

from __future__ import annotations

import os
import sys

DEFAULT_LINES = 80
MAX_MESSAGE = 60_000  # GitHub truncates far above this; stay well clear.


def escape(message: str) -> str:
    """Escape a message for a GitHub Actions workflow command."""
    return message.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")


def tail(text: str, lines: int = DEFAULT_LINES) -> str:
    """Return the last ``lines`` lines of ``text``, keeping order."""
    if lines <= 0:
        return ""
    return "\n".join(text.splitlines()[-lines:])


def build_annotation(log_text: str, title: str, lines: int = DEFAULT_LINES) -> str:
    """Build the `::error::` workflow command for a log tail."""
    body = tail(log_text, lines)
    if len(body) > MAX_MESSAGE:
        body = body[-MAX_MESSAGE:]
    return f"::error title={title}::{escape(body)}"


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print("usage: ci-annotate.py <logfile> [title] [lines]", file=sys.stderr)
        return 2

    path = argv[1]
    title = argv[2] if len(argv) > 2 else os.path.basename(path)
    lines = int(argv[3]) if len(argv) > 3 else DEFAULT_LINES

    try:
        with open(path, encoding="utf-8", errors="replace") as handle:
            text = handle.read()
    except OSError as exc:
        print(f"::error title=ci-annotate::cannot read {path}: {exc}")
        return 0  # never mask the real failure with a diagnostics failure

    print(build_annotation(text, title, lines))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
