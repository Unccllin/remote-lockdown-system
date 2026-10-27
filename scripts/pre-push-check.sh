#!/usr/bin/env bash
# pre-push-check.sh — refuse to publish secrets, or to drop commits by accident.
#
# Two failures from session S140 motivated this:
#
#   1. A credential was committed, then re-committed inside the very log entry
#      that documented its removal. A whole-history scan had been run *before*
#      that commit existed, so it reported clean. The scan must cover exactly
#      the range being published, immediately before publishing.
#   2. A "force-push required" call was made from comparing ref SHAs without
#      asking whether the remote tip was an ancestor of HEAD. It was — the push
#      was a fast-forward, and forcing it would have been pure risk.
#
# Usage:
#   scripts/pre-push-check.sh                  # scan @{upstream}..HEAD
#   scripts/pre-push-check.sh --base origin/master
#   scripts/pre-push-check.sh --all            # scan every reachable commit
#   scripts/pre-push-check.sh --allow-rewrite  # permit a non-fast-forward
#   scripts/pre-push-check.sh --install        # install as .git/hooks/pre-push
#
# Exit codes: 0 clean, 1 secrets found, 2 non-fast-forward without permission.
#
# Forbidden terms (values that must never be published again) are read from
# $PREPUSH_FORBIDDEN (comma-separated) and <git-dir>/prepush-forbidden.txt.
# They are never stored in this repo — storing a leaked secret to grep for it
# just re-leaks it.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SCANNER="$SCRIPT_DIR/prepush_secrets.py"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
ok()   { printf "${GREEN}[OK]${NC} %s\n" "$1"; }
err()  { printf "${RED}[BLOCK]${NC} %s\n" "$1"; }
warn() { printf "${YELLOW}[WARN]${NC} %s\n" "$1"; }
info() { printf "${YELLOW}[..]${NC} %s\n" "$1"; }

BASE=""
ALLOW_REWRITE=0
SCAN_ALL=0
INSTALL=0

while [ $# -gt 0 ]; do
  case "$1" in
    --base)          BASE="${2:-}"; shift 2 ;;
    --allow-rewrite) ALLOW_REWRITE=1; shift ;;
    --all)           SCAN_ALL=1; shift ;;
    --install)       INSTALL=1; shift ;;
    -h|--help)       sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)               err "unknown argument: $1"; exit 2 ;;
  esac
done

cd "$PROJECT_ROOT" || { err "cannot cd to $PROJECT_ROOT"; exit 2; }

if ! command -v git >/dev/null 2>&1; then
  err "git not found"; exit 2
fi
if ! command -v python3 >/dev/null 2>&1; then
  err "python3 not found (needed by $SCANNER)"; exit 2
fi
if [ ! -f "$SCANNER" ]; then
  err "scanner missing: $SCANNER"; exit 2
fi

# --- --install: wire this script in as .git/hooks/pre-push ---------------------
if [ "$INSTALL" = "1" ]; then
  HOOK_DIR="$(git rev-parse --git-dir)/hooks"
  mkdir -p "$HOOK_DIR"
  cat > "$HOOK_DIR/pre-push" <<HOOK
#!/usr/bin/env bash
# Installed by scripts/pre-push-check.sh --install
exec "$SCRIPT_DIR/pre-push-check.sh" --base "\$(git rev-parse --abbrev-ref @{upstream} 2>/dev/null || echo origin/master)" "\$@"
HOOK
  chmod +x "$HOOK_DIR/pre-push"
  ok "installed $HOOK_DIR/pre-push"
  exit 0
fi

# --- resolve the base --------------------------------------------------------
if [ "$SCAN_ALL" = "1" ]; then
  info "scanning every reachable commit"
  python3 "$SCANNER" --all
  exit $?
fi

if [ -z "$BASE" ]; then
  if upstream="$(git rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' 2>/dev/null)"; then
    BASE="$upstream"
  elif git rev-parse --verify -q origin/HEAD >/dev/null 2>&1; then
    BASE="origin/HEAD"
  elif git rev-parse --verify -q refs/remotes/origin/master >/dev/null 2>&1; then
    BASE="origin/master"
  elif git rev-parse --verify -q refs/remotes/origin/main >/dev/null 2>&1; then
    BASE="origin/main"
  fi
fi

if [ -z "$BASE" ]; then
  # Do NOT silently fall back to scanning every commit: the result cannot be
  # interpreted as "what this push publishes", and on a long history it is
  # noisy enough to read as a false alarm. Refuse and say what to do.
  err "cannot determine the publish range: no upstream and no origin/* ref."
  echo "    Run 'git fetch origin' first, or pass --base <ref> explicitly."
  echo "    To audit the whole history on purpose: $0 --all"
  exit 2
fi

info "publish range: $BASE..HEAD"

# --- guard 1: is this actually a fast-forward? -------------------------------
if git rev-parse --verify -q "$BASE" >/dev/null 2>&1; then
  if ! git merge-base --is-ancestor "$BASE" HEAD 2>/dev/null; then
    AHEAD="$(git rev-list --count "HEAD..$BASE" 2>/dev/null || echo '?')"
    err "NOT a fast-forward: $AHEAD commit(s) on $BASE are not in HEAD."
    err "A plain push would be rejected; a forced push would DROP those commits."
    if [ "$ALLOW_REWRITE" != "1" ]; then
      echo "    If dropping them is truly intended, re-run with --allow-rewrite."
      echo "    If not, inspect with: git log --oneline HEAD..$BASE"
      exit 2
    fi
    warn "--allow-rewrite given — continuing with a non-fast-forward range."
  else
    ok "fast-forward ($(git rev-list --count "$BASE..HEAD") commit(s) to publish)"
  fi
else
  warn "base '$BASE' does not resolve — skipping the fast-forward check"
fi

# --- guard 2: scan exactly what would be published ----------------------------
if ! python3 "$SCANNER" --base "$BASE" --head HEAD; then
  err "push blocked — see findings above."
  exit 1
fi

ok "no credential-shaped content in $BASE..HEAD"
