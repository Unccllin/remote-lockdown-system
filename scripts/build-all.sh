#!/bin/bash
# Top-level build orchestration for the remote-lockdown-system.
#
# Builds all buildable components in dependency order so that downstream
# packagers (notably Electron) can bundle the artifacts they need:
#
#   1. dashboard  -> dashboard/dist/         (React + Vite static bundle)
#   2. agent      -> agent/dist/             (PyInstaller standalone exes)
#   3. server deps-> server/node_modules/    (npm ci, no build step itself)
#   4. electron   -> electron/dist-electron/ (electron-builder installer)
#
# Usage:
#   ./scripts/build-all.sh                 # Build everything in order
#   ./scripts/build-all.sh --skip-electron # Skip the slow Electron packaging
#   ./scripts/build-all.sh --component dashboard
#   ./scripts/build-all.sh --component agent
#   ./scripts/build-all.sh --component server
#   ./scripts/build-all.sh --component electron
#
# Exit codes:
#   0  all requested builds succeeded
#   1  a build failed (fail-fast: stop on first failure)
#   2  missing prerequisites or bad arguments

set -euo pipefail

# Resolve the repository root (one level up from this script).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

# --- Output helpers ---------------------------------------------------------

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log()  { echo -e "${BLUE}[$(date +%H:%M:%S)]${NC} $*"; }
ok()   { echo -e "  ${GREEN}OK${NC}   $*"; }
warn() { echo -e "  ${YELLOW}WARN${NC} $*"; }
fail() { echo -e "  ${RED}FAIL${NC} $*" >&2; }

# --- Argument parsing -------------------------------------------------------

COMPONENT=""
SKIP_ELECTRON=false

print_usage() {
    cat <<EOF
Usage: $0 [options]

Options:
  --component <name>   Build a single component (dashboard|agent|server|electron)
  --skip-electron      Skip the Electron packaging step (faster dev builds)
  -h, --help           Show this help message
EOF
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --component)
            [[ $# -lt 2 ]] && { echo "Error: --component requires a value" >&2; exit 2; }
            COMPONENT="$2"
            shift 2
            ;;
        --skip-electron)
            SKIP_ELECTRON=true
            shift
            ;;
        -h|--help)
            print_usage
            exit 0
            ;;
        *)
            echo "Unknown argument: $1" >&2
            print_usage
            exit 2
            ;;
    esac
done

# Validate --component value if provided.
if [[ -n "$COMPONENT" ]]; then
    case "$COMPONENT" in
        dashboard|agent|server|electron) ;;
        *)
            echo "Error: unknown component '$COMPONENT'" >&2
            echo "Valid components: dashboard | agent | server | electron" >&2
            exit 2
            ;;
    esac
fi

# --- Prerequisite checks ----------------------------------------------------
# Fail fast before doing any work if the toolchain is missing.

check_prerequisites() {
    local missing=0
    log "Checking prerequisites..."

    command -v node  >/dev/null 2>&1 || { fail "node not found on PATH"; missing=1; }
    command -v npm   >/dev/null 2>&1 || { fail "npm not found on PATH";  missing=1; }
    command -v python3 >/dev/null 2>&1 || { fail "python3 not found on PATH"; missing=1; }
    command -v pip3  >/dev/null 2>&1 || { fail "pip3 not found on PATH";  missing=1; }

    if [[ $missing -ne 0 ]]; then
        echo "One or more prerequisites are missing. Install them and retry." >&2
        exit 2
    fi

    ok "node $(node --version)"
    ok "npm  $(npm --version)"
    ok "python3 $(python3 --version 2>&1)"
    ok "pip3 $(pip3 --version 2>&1)"
    echo ""
}

# --- Component builders -----------------------------------------------------
# Each builder is self-contained: it cds into its component dir, runs the
# build, and returns non-zero on failure. set -e handles the fail-fast.

build_dashboard() {
    log "Building dashboard (Vite)..."
    (
        cd "$ROOT_DIR/dashboard"
        if [[ ! -d node_modules ]]; then
            log "dashboard: installing dependencies (npm ci)..."
            npm ci
        fi
        npm run build
    )
    ok "dashboard built -> dashboard/dist/"
}

build_agent() {
    log "Building agent (PyInstaller)..."
    (
        cd "$ROOT_DIR/agent"
        # Delegate to the existing, well-tested agent build script.
        # It installs requirements, runs PyInstaller for all three specs,
        # and prints its own per-binary summary.
        bash ./build.sh
    )
    ok "agent built -> agent/dist/"
}

build_server() {
    log "Installing server dependencies (npm ci --omit=dev)..."
    (
        cd "$ROOT_DIR/server"
        npm ci --omit=dev
    )
    ok "server deps installed -> server/node_modules/"
}

build_electron() {
    log "Building Electron app (electron-builder)..."
    (
        cd "$ROOT_DIR/electron"
        if [[ ! -d node_modules ]]; then
            log "electron: installing dependencies (npm ci)..."
            npm ci
        fi
        # Rebuild native sqlite3 module against Electron's ABI, then package.
        npm run rebuild:native
        npx electron-builder
    )
    ok "electron built -> electron/dist-electron/"
}

# --- Build summary ----------------------------------------------------------

# Print a human-readable summary of the artifacts produced, with sizes.
# Missing artifacts are reported but do not fail the script here (the
# dedicated check-artifacts.sh script is the source of truth for that).
print_summary() {
    echo ""
    echo -e "${GREEN}=== Build Summary ===${NC}"

    local artifact
    local any_artifact=0

    # dashboard artifacts
    for artifact in dashboard/dist/index.html; do
        if [[ -f "$artifact" ]]; then
            ok "$(du -h "$artifact" | cut -f1)  $artifact"
            any_artifact=1
        fi
    done
    if [[ -d dashboard/dist/assets ]]; then
        ok "$(du -sh dashboard/dist/assets | cut -f1)  dashboard/dist/assets/"
        any_artifact=1
    fi

    # agent artifacts (Linux names; .exe variants on Windows)
    local agent_bins=("lockdown-agent" "lockdown-watchdog" "lockdown-recovery")
    for name in "${agent_bins[@]}"; do
        for artifact in "agent/dist/$name" "agent/dist/$name.exe"; do
            if [[ -f "$artifact" ]]; then
                ok "$(du -h "$artifact" | cut -f1)  $artifact"
                any_artifact=1
            fi
        done
    done

    # electron artifacts
    if [[ -d electron/dist-electron ]]; then
        ok "$(du -sh electron/dist-electron | cut -f1)  electron/dist-electron/"
        any_artifact=1
    fi

    if [[ $any_artifact -eq 0 ]]; then
        warn "No artifacts found — did the builds run?"
    fi
    echo ""
}

# --- Orchestration ----------------------------------------------------------

run_builds() {
    # If a single component was requested, build only that one.
    if [[ -n "$COMPONENT" ]]; then
        log "Single-component build requested: $COMPONENT"
        case "$COMPONENT" in
            dashboard) build_dashboard ;;
            agent)     build_agent ;;
            server)    build_server ;;
            electron)  build_electron ;;
        esac
        return
    fi

    # Full dependency-ordered build.
    # dashboard + agent must exist before electron bundles them.
    # server deps must exist before electron bundles server/node_modules.
    build_dashboard
    build_agent
    build_server

    if [[ "$SKIP_ELECTRON" = true ]]; then
        warn "Skipping Electron packaging (--skip-electron)"
    else
        build_electron
    fi
}

# --- Main -------------------------------------------------------------------

check_prerequisites
run_builds
print_summary

log "Done."
