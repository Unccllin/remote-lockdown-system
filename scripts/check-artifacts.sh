#!/bin/bash
# Artifact verification for the remote-lockdown-system.
#
# Verifies that build outputs exist and are non-empty. Used both during
# local development (quick structural check) and in CI (strict verify).
#
# Modes:
#   --check-structure   Verify expected dist directories exist.
#                       Non-destructive: does NOT fail if artifacts are
#                       missing (useful before any build has run).
#   --verify            Strict check: every expected artifact must exist
#                       AND be non-empty. Fails on missing/empty files.
#   --json              Emit machine-readable JSON instead of human text.
#                       Combine with --verify for CI integration.
#
# Exit codes:
#   0  all good (or, in --check-structure mode, structure is fine)
#   1  one or more expected artifacts are missing
#   2  one or more artifacts exist but are empty (0 bytes)

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

# --- Argument parsing -------------------------------------------------------

MODE=""
JSON_OUTPUT=false

print_usage() {
    cat <<EOF
Usage: $0 [--check-structure | --verify] [--json]

Modes:
  --check-structure   Verify dist directories exist (non-fatal if missing)
  --verify            Verify every expected artifact exists and is non-empty
  --json              Emit JSON output (for CI integration)

At least one mode is required. --json may be combined with either mode.
EOF
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --check-structure) MODE="structure"; shift ;;
        --verify)          MODE="verify";    shift ;;
        --json)            JSON_OUTPUT=true; shift ;;
        -h|--help)         print_usage; exit 0 ;;
        *) echo "Unknown argument: $1" >&2; print_usage; exit 2 ;;
    esac
done

if [[ -z "$MODE" ]]; then
    echo "Error: a mode is required (--check-structure or --verify)" >&2
    print_usage
    exit 2
fi

# --- Expected artifacts -----------------------------------------------------
# Mirrors the build outputs documented in the skill domain knowledge base.
# Directories are checked for existence; files are checked for existence
# and (in --verify mode) non-zero size.

EXPECTED_DIRS=(
    "dashboard/dist"
    "agent/dist"
    "electron/dist-electron"
)

# Files that must exist and be non-empty after a full build.
# On Windows the agent binaries have a .exe suffix; we check both.
EXPECTED_FILES=(
    "dashboard/dist/index.html"
    "agent/dist/lockdown-agent"
    "agent/dist/lockdown-watchdog"
    "agent/dist/lockdown-recovery"
)

# --- Helpers ----------------------------------------------------------------

# Track results for JSON output and exit-code determination.
MISSING_DIRS=()
MISSING_FILES=()
EMPTY_FILES=()
PRESENT_FILES=()

# Colors (disabled in JSON mode).
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# --- Structure check (non-destructive) --------------------------------------

check_structure() {
    local dir
    for dir in "${EXPECTED_DIRS[@]}"; do
        if [[ -d "$dir" ]]; then
            if [[ "$JSON_OUTPUT" = false ]]; then
                echo -e "  ${GREEN}OK${NC}   dir  $dir"
            fi
        else
            MISSING_DIRS+=("$dir")
            if [[ "$JSON_OUTPUT" = false ]]; then
                echo -e "  ${YELLOW}MISS${NC} dir  $dir (not built yet)"
            fi
        fi
    done
}

# --- Verify (strict) --------------------------------------------------------

verify() {
    local f

    # First, check the dist directories exist.
    check_structure

    # Then check each expected file: exists AND non-empty.
    for f in "${EXPECTED_FILES[@]}"; do
        if [[ ! -e "$f" ]]; then
            MISSING_FILES+=("$f")
            if [[ "$JSON_OUTPUT" = false ]]; then
                echo -e "  ${RED}MISS${NC} file $f"
            fi
            continue
        fi
        # -s: exists and has size > 0
        if [[ ! -s "$f" ]]; then
            EMPTY_FILES+=("$f")
            if [[ "$JSON_OUTPUT" = false ]]; then
                echo -e "  ${RED}EMPTY${NC} file $f (0 bytes)"
            fi
        else
            PRESENT_FILES+=("$f")
            if [[ "$JSON_OUTPUT" = false ]]; then
                echo -e "  ${GREEN}OK${NC}   file $f ($(du -h "$f" | cut -f1))"
            fi
        fi
    done
}

# --- JSON output ------------------------------------------------------------

emit_json() {
    # Emit a single JSON object summarizing the verification run.
    # Built manually to avoid a jq dependency.
    local i
    local first

    printf '{'
    printf '"mode":"%s",' "$MODE"

    # missing_dirs
    printf '"missing_dirs":['
    first=true
    if [[ ${#MISSING_DIRS[@]} -gt 0 ]]; then
        for i in "${!MISSING_DIRS[@]}"; do
            $first || printf ','
            printf '"%s"' "${MISSING_DIRS[$i]}"
            first=false
        done
    fi
    printf '],'

    # missing_files
    printf '"missing_files":['
    first=true
    if [[ ${#MISSING_FILES[@]} -gt 0 ]]; then
        for i in "${!MISSING_FILES[@]}"; do
            $first || printf ','
            printf '"%s"' "${MISSING_FILES[$i]}"
            first=false
        done
    fi
    printf '],'

    # empty_files
    printf '"empty_files":['
    first=true
    if [[ ${#EMPTY_FILES[@]} -gt 0 ]]; then
        for i in "${!EMPTY_FILES[@]}"; do
            $first || printf ','
            printf '"%s"' "${EMPTY_FILES[$i]}"
            first=false
        done
    fi
    printf '],'

    # present_files
    printf '"present_files":['
    first=true
    if [[ ${#PRESENT_FILES[@]} -gt 0 ]]; then
        for i in "${!PRESENT_FILES[@]}"; do
            $first || printf ','
            printf '"%s"' "${PRESENT_FILES[$i]}"
            first=false
        done
    fi
    printf '],'

    # exit_code
    local code
    if [[ ${#EMPTY_FILES[@]} -gt 0 ]]; then
        code=2
    elif [[ ${#MISSING_FILES[@]} -gt 0 ]]; then
        code=1
    else
        code=0
    fi
    printf '"exit_code":%d' "$code"

    printf '}\n'
}

# --- Run --------------------------------------------------------------------

if [[ "$JSON_OUTPUT" = false ]]; then
    if [[ "$MODE" = "structure" ]]; then
        echo "Checking artifact structure (non-destructive)..."
    else
        echo "Verifying artifacts (strict)..."
    fi
fi

if [[ "$MODE" = "structure" ]]; then
    check_structure
    # Structure mode never fails — it's informational.
    EXIT_CODE=0
else
    verify
    if [[ ${#EMPTY_FILES[@]} -gt 0 ]]; then
        EXIT_CODE=2
    elif [[ ${#MISSING_FILES[@]} -gt 0 ]]; then
        EXIT_CODE=1
    else
        EXIT_CODE=0
    fi
fi

if [[ "$JSON_OUTPUT" = true ]]; then
    emit_json
else
    echo ""
    if [[ "$MODE" = "structure" ]]; then
        if [[ ${#MISSING_DIRS[@]} -gt 0 ]]; then
            echo -e "${YELLOW}${#MISSING_DIRS[@]} dist directory(ies) not found.${NC}"
        else
            echo -e "${GREEN}All expected dist directories present.${NC}"
        fi
    else
        if [[ $EXIT_CODE -eq 0 ]]; then
            echo -e "${GREEN}All artifacts present and non-empty.${NC}"
        elif [[ $EXIT_CODE -eq 1 ]]; then
            echo -e "${RED}${#MISSING_FILES[@]} artifact(s) missing.${NC}" >&2
        elif [[ $EXIT_CODE -eq 2 ]]; then
            echo -e "${RED}${#EMPTY_FILES[@]} artifact(s) empty (0 bytes).${NC}" >&2
        fi
    fi
fi

exit $EXIT_CODE
