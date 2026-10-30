#!/usr/bin/env bash
# Install apt packages with retries, teeing everything to a log file.
#
# Why this exists
# ---------------
# PBL CI's "Install build dependencies" steps exited 100 on ubuntu-22.04 on
# every run, and the cause could not be named: job logs need admin rights on
# this repository, and the step logged straight to the console, so there was
# nothing left to annotate from. Exit 100 is apt's generic "something failed"
# and has three recurring causes on a hosted runner:
#
#   1. dpkg/apt lock held by the image's own unattended-upgrades or package
#      setup, still finishing when the job starts  -> retry after a pause
#   2. a transient mirror/fetch failure            -> Acquire::Retries
#   3. a genuinely missing or renamed package      -> must fail, and say which
#
# So: retry the transient cases with backoff, keep the full transcript in a log
# file that a following `if: failure()` step can annotate, and let the
# permanent case fail loudly with the package name visible in the log tail.
#
# Usage:
#   scripts/apt-install-retry.sh <log-file> <package> [package ...]
#   scripts/apt-install-retry.sh --update-only <log-file>
#
# Runs `sudo` itself when not already root, so the log file stays readable by
# the runner user who annotates it. Honours these env vars:
#   APT_INSTALL_ATTEMPTS  total attempts (default 3)
#   APT_INSTALL_DELAY     seconds before the first retry, doubled each time (default 15)

set -uo pipefail

ATTEMPTS="${APT_INSTALL_ATTEMPTS:-3}"
DELAY="${APT_INSTALL_DELAY:-15}"

# Acquire::Retries makes a single apt invocation retry individual fetches; the
# outer loop covers the lock and "Failed to fetch" cases it cannot. Recommend-
# handling is left at apt's default on purpose: `--no-install-recommends` would
# be a second, unrelated behaviour change on a job that was already red.
APT_OPTS=(
  -o Acquire::Retries=5
  -o Acquire::http::Timeout=30
  -o Dpkg::Options::=--force-confdef
  -o Dpkg::Options::=--force-confold
)

# An array, not a string: `run "$SUDO" apt-get ...` with SUDO empty passes an
# empty first argument and the pipeline tries to execute "" (status 127).
# In the container test below that turned every root run into a fake apt failure.
SUDO=()
if [ "$(id -u)" -ne 0 ]; then
  SUDO=(sudo)
fi

usage() {
  echo "usage: $0 <log-file> <package> [package ...]" >&2
  echo "       $0 --update-only <log-file>" >&2
  exit 2
}

[ "$#" -ge 2 ] || usage

UPDATE_ONLY=0
if [ "${1:-}" = "--update-only" ]; then
  UPDATE_ONLY=1
  shift
fi

LOG="$1"
shift

if [ "$UPDATE_ONLY" -eq 0 ] && [ "$#" -eq 0 ]; then
  usage
fi

# Truncate: the annotate step should show this run, not a previous one.
: >"$LOG"

say() {
  # Every line goes to both the console and the log, so the annotated tail is
  # exactly what the operator would have seen in the job output.
  printf '%s\n' "$*" | tee -a "$LOG" >&2
}

run() {
  say "\$ $*"
  "$@" 2>&1 | tee -a "$LOG"
  return "${PIPESTATUS[0]}"
}

install_once() {
  local status=0

  run "${SUDO[@]}" apt-get update "${APT_OPTS[@]}" || status=$?
  if [ "$status" -ne 0 ]; then
    say "apt-get update failed with status $status"
    return "$status"
  fi

  [ "$UPDATE_ONLY" -eq 1 ] && return 0

  # DEBIAN_FRONTEND keeps a prompt from turning into a silent hang.
  DEBIAN_FRONTEND=noninteractive run "${SUDO[@]}" apt-get install -y "${APT_OPTS[@]}" "$@" || status=$?
  if [ "$status" -ne 0 ]; then
    say "apt-get install failed with status $status"
    return "$status"
  fi
  return 0
}

attempt=1
delay="$DELAY"
status=1
while [ "$attempt" -le "$ATTEMPTS" ]; do
  say "=== apt attempt $attempt of $ATTEMPTS ==="
  if install_once "$@"; then
    say "=== apt succeeded on attempt $attempt ==="
    exit 0
  else
    # Must be captured in the `else` branch: the exit status of an `if` whose
    # condition failed and that has no `else` is 0, so the earlier
    # `status=$?` after `fi` reported success and exited 0 on a failed install.
    status=$?
  fi
  if [ "$attempt" -lt "$ATTEMPTS" ]; then
    # Name the likely cause in the log so the annotation is actionable rather
    # than just "apt exited 100".
    if grep -qE 'Unable to locate package|has no installation candidate' "$LOG"; then
      # PBL CI lost days to exactly this: `libuuid-dev` does not exist on jammy
      # (the package is `uuid-dev`), so the step exited 100 on every run while
      # the ``::error`` said nothing about a package name. A retry cannot fix a
      # name that does not exist, so name it and stop.
      say "=== cause: a requested package does not exist for this release; not retrying ==="
      exit "$status"
    fi
    if grep -qE 'Could not get lock|Unable to acquire the dpkg frontend lock|is another process using it' "$LOG"; then
      say "=== cause: apt/dpkg lock contention; retrying in ${delay}s ==="
    elif grep -qE 'Failed to fetch|Temporary failure resolving|Connection failed|Hash Sum mismatch' "$LOG"; then
      say "=== cause: mirror/network failure; retrying in ${delay}s ==="
    else
      say "=== cause: not a lock or network error — retrying in ${delay}s anyway ==="
    fi
    sleep "$delay"
    delay=$((delay * 2))
  fi
  attempt=$((attempt + 1))
done

say "=== apt failed after $ATTEMPTS attempt(s); log: $LOG ==="
exit "$status"
