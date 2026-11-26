#!/bin/bash
# Build the lockdown agent and companion tools as standalone executables
# using PyInstaller.
#
# Produces three executables in dist/:
#   lockdown-agent     — the main agent (checkin, encryption, boot lockdown)
#   lockdown-watchdog  — process monitor that restarts the agent if it crashes
#   lockdown-recovery  — offline recovery tool for IT staff
#
# Usage:
#   ./build.sh              # Build all three for current platform
#   ./build.sh --clean      # Clean build directories and rebuild
#   ./build.sh --install    # Install PyInstaller first, then build
#   ./build.sh --agent-only # Build only the agent (skip watchdog/recovery)
#
# Requirements:
#   - Python 3.8+
#   - pip install pyinstaller
#   - pip install -r requirements.txt
#
# Output:
#   dist/lockdown-agent, dist/lockdown-watchdog, dist/lockdown-recovery

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}=== Remote Lockdown Agent Build ===${NC}"
echo "Platform: $(uname -s) $(uname -m)"
echo "Python:   $(python3 --version 2>&1)"
echo ""

# Parse arguments
CLEAN=false
INSTALL=false
AGENT_ONLY=false
USE_VENV=true  # Use venv by default to avoid PEP 668 (externally-managed-environment)
for arg in "$@"; do
    case $arg in
        --clean)  CLEAN=true ;;
        --install) INSTALL=true ;;
        --agent-only) AGENT_ONLY=true ;;
        --no-venv) USE_VENV=false ;;
        *) echo "Unknown argument: $arg"; exit 1 ;;
    esac
done

# --- Virtual environment setup ---
# PEP 668 (Debian/Ubuntu 23+) blocks pip install on system Python.
# We create/use a venv in .venv/ to isolate build dependencies.
PIP="pip3"
PYTHON="python3"

# Windows runners (release.yml builds the Windows agent binaries under Git Bash) provide `python`
# but not always `python3`, so pick whichever exists instead of failing at the first call. This is
# the same interpreter the rest of the script uses, so the stamp and PyInstaller cannot disagree.
if ! command -v python3 >/dev/null 2>&1 && command -v python >/dev/null 2>&1; then
    PYTHON="python"
    PIP="pip"
fi

if [ "$USE_VENV" = true ]; then
    VENV_DIR="$SCRIPT_DIR/.venv"
    if [ ! -d "$VENV_DIR" ]; then
        echo -e "${YELLOW}Creating virtual environment in .venv/...${NC}"
        # Try with pip first; fall back to --without-pip + get-pip.py
        if ! python3 -m venv "$VENV_DIR" 2>/dev/null; then
            echo -e "${YELLOW}venv without pip (ensurepip missing) — bootstrapping pip...${NC}"
            python3 -m venv --without-pip "$VENV_DIR"
            curl -sS https://bootstrap.pypa.io/get-pip.py | "$VENV_DIR/bin/python"
        fi
    fi
    PIP="$VENV_DIR/bin/pip"
    PYTHON="$VENV_DIR/bin/python"
    echo "Using venv: $VENV_DIR"
    echo ""
fi

# Install PyInstaller if requested
if [ "$INSTALL" = true ]; then
    echo -e "${YELLOW}Installing PyInstaller...${NC}"
    $PIP install pyinstaller
    echo ""
fi

# Check PyInstaller is available
if ! $PYTHON -c "import PyInstaller" 2>/dev/null; then
    echo -e "${RED}Error: PyInstaller is not installed.${NC}"
    echo "Run: ./build.sh --install"
    exit 1
fi

# Install agent dependencies
echo -e "${YELLOW}Installing agent dependencies...${NC}"
$PIP install -r requirements.txt --quiet
echo ""

# Stamp the build identity before PyInstaller runs.
#
# This path builds the Linux and macOS agent binaries that release.yml bundles into the Electron
# release, and it used to build them without stamping -- so those binaries reported
# `build=unknown.unknown` while the Windows ones carried an identity (S286/S359/S361). The
# computation lives in scripts/stamp_buildinfo.py so all three build entry points share one
# implementation rather than one of them owning a copy.
if ! "$PYTHON" "$SCRIPT_DIR/../scripts/stamp_buildinfo.py" --agent-dir "$SCRIPT_DIR"; then
    echo -e "${RED}FAIL${NC} could not stamp the build identity"
    exit 1
fi
echo ""

# Clean build directories if requested
if [ "$CLEAN" = true ]; then
    echo -e "${YELLOW}Cleaning build directories...${NC}"
    rm -rf build/ dist/ *.spec.bak
    echo ""
fi

# Build the executables
SPECS=("agent.spec")
if [ "$AGENT_ONLY" = false ]; then
    SPECS+=("watchdog.spec" "offline_recovery.spec")
fi

BUILT_OK=()
BUILT_FAIL=()

for spec in "${SPECS[@]}"; do
    name=$(basename "$spec" .spec)
    echo -e "${YELLOW}Building ${name} with PyInstaller...${NC}"
    if $PYTHON -m PyInstaller "$spec" --noconfirm; then
        BUILT_OK+=("$name")
    else
        BUILT_FAIL+=("$name")
    fi
    echo ""
done

# Summary
echo -e "${GREEN}=== Build Summary ===${NC}"
if [ ${#BUILT_OK[@]} -gt 0 ]; then
    for name in "${BUILT_OK[@]}"; do
        bin="dist/lockdown-${name#agent}"
        [ "$name" = "agent" ] && bin="dist/lockdown-agent"
        if [ -f "$bin" ]; then
            echo -e "  ${GREEN}OK${NC}  $bin ($(du -h "$bin" | cut -f1))"
        fi
    done
fi
if [ ${#BUILT_FAIL[@]} -gt 0 ]; then
    for name in "${BUILT_FAIL[@]}"; do
        echo -e "  ${RED}FAIL${NC}  $name.spec"
    done
    echo -e "${RED}One or more builds failed.${NC}"
    exit 1
fi

echo ""
echo "Test the builds:"
echo "  ./dist/lockdown-agent --version"
echo "  ./dist/lockdown-agent --help"
echo ""
echo "To deploy with a config file:"
echo "  ./dist/lockdown-agent --config /path/to/agent-config.json"
echo ""
echo "To run the watchdog (place it next to lockdown-agent):"
echo "  ./dist/lockdown-watchdog"
