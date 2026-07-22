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
for arg in "$@"; do
    case $arg in
        --clean)  CLEAN=true ;;
        --install) INSTALL=true ;;
        --agent-only) AGENT_ONLY=true ;;
        *) echo "Unknown argument: $arg"; exit 1 ;;
    esac
done

# Install PyInstaller if requested
if [ "$INSTALL" = true ]; then
    echo -e "${YELLOW}Installing PyInstaller...${NC}"
    pip3 install pyinstaller
    echo ""
fi

# Check PyInstaller is available
if ! python3 -c "import PyInstaller" 2>/dev/null; then
    echo -e "${RED}Error: PyInstaller is not installed.${NC}"
    echo "Run: ./build.sh --install"
    exit 1
fi

# Install agent dependencies
echo -e "${YELLOW}Installing agent dependencies...${NC}"
pip3 install -r requirements.txt --quiet
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
    if python3 -m PyInstaller "$spec" --noconfirm; then
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
