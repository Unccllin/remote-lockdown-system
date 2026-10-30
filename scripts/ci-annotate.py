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


def build_annotation(
    log_text: str, title: str, lines: int = DEFAULT_LINES, level: str = "error"
) -> str:
    """Build the `::<level>::` workflow command for a log tail.

    ``level`` is ``error`` or ``warning``. The default stays ``error`` because
    the tool's original purpose is to explain a job that failed; ``warning``
    exists so a step that is deliberately advisory but still produces output
    (cppcheck in PBL CI) can surface its findings on the check run instead of
    writing them to a log nobody can read without admin rights.
    """
    body = tail(log_text, lines)
    if len(body) > MAX_MESSAGE:
        body = body[-MAX_MESSAGE:]
    return f"::{level} title={title}::{escape(body)}"


def main(argv: list[str]) -> int:
    level = "error"
    args = list(argv[1:])
    if args and args[0] == "--warning":
        level = "warning"
        args = args[1:]

    if len(args) < 1:
        print(
            "usage: ci-annotate.py [--warning] <logfile> [title] [lines]",
            file=sys.stderr,
        )
        return 2

    path = args[0]
    title = args[1] if len(args) > 1 else os.path.basename(path)
    try:
        lines = int(args[2]) if len(args) > 2 else DEFAULT_LINES
    except ValueError:
        # A malformed line count must not produce a traceback: the tool's own
        # failure would then be the only thing the check run shows.
        print(f"usage: invalid line count: {args[2]}", file=sys.stderr)
        return 2

    try:
        with open(path, encoding="utf-8", errors="replace") as handle:
            text = handle.read()
    except OSError as exc:
        print(f"::error title=ci-annotate::cannot read {path}: {exc}")
        return 0  # never mask the real failure with a diagnostics failure

    print(build_annotation(text, title, lines, level))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
