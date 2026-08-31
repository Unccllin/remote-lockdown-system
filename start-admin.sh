#!/bin/bash
# start-admin.sh — Launch the Remote Lockdown Admin desktop app (Electron)
#
# Usage:
#   ./start-admin.sh          # dev mode (Vite dev server + Electron)
#   ./start-admin.sh --prod   # production mode (built dashboard + static server)
#
# Prerequisites:
#   - /dev/dri must exist (WSLg GPU rendering). If missing, run from Windows:
#       wsl --shutdown
#       wsl --update
#     Then reopen WSL and check: ls /dev/dri/

set -euo pipefail

ROOT="/home/cllin/remote-lockdown-system"
export PATH="/home/cllin/.local/node/bin:$PATH"
export DISPLAY=:0
export WAYLAND_DISPLAY=wayland-0
export XDG_RUNTIME_DIR=/run/user/1000

# WSLg libraries (libnspr4, libnss3, libasound2) extracted locally
LIBS_DIR="/tmp/electron-libs/extracted/usr/lib/x86_64-linux-gnu"
if [ -d "$LIBS_DIR" ]; then
  export LD_LIBRARY_PATH="$LIBS_DIR:${LD_LIBRARY_PATH:-}"
fi

# Use X11 (Xwayland) instead of Wayland to avoid /dev/dri requirement.
# Electron 41's Wayland backend needs DRM render nodes for buffer management,
# which don't exist when WSL's dxg driver hasn't initialized properly.
# X11 mode works without /dev/dri — only needs a non-fatal "dri3 not supported" warning.
unset WAYLAND_DISPLAY
echo "[start-admin] Display: $DISPLAY (X11 mode — Wayland disabled to avoid /dev/dri requirement)"

MODE="${1:-dev}"

if [ "$MODE" = "--prod" ]; then
  echo "[start-admin] Production mode — using built dashboard"
  export ELECTRON_IS_DEV=0
  cd "$ROOT/electron"
  exec ./node_modules/electron/dist/electron . --no-sandbox --disable-gpu --ozone-platform=x11
else
  echo "[start-admin] Dev mode — starting Vite dev server + Electron"

  # Start Vite dev server if not already running
  if ! curl -s http://localhost:5173 >/dev/null 2>&1; then
    echo "[start-admin] Starting Vite dev server..."
    cd "$ROOT/dashboard"
    npx vite --host >/tmp/vite-dev.log 2>&1 &
    VITE_PID=$!
    echo "[start-admin] Vite PID: $VITE_PID"

    # Wait for Vite to be ready
    for i in $(seq 1 15); do
      if curl -s http://localhost:5173 >/dev/null 2>&1; then
        echo "[start-admin] Vite ready on http://localhost:5173"
        break
      fi
      sleep 1
    done
  else
    echo "[start-admin] Vite already running on http://localhost:5173"
  fi

  # Launch Electron via X11
  cd "$ROOT/electron"
  echo "[start-admin] Launching Electron (X11 mode)..."
  exec ./node_modules/electron/dist/electron . --no-sandbox --disable-gpu --ozone-platform=x11 --enable-logging
fi
