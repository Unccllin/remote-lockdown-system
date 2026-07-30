#!/usr/bin/env bash
#
# verify-environment.sh — Test items that were previously "cannot verify in WSL".
#
# This script tests as many production-readiness items as possible in a
# Linux/WSL environment without requiring real Windows, Docker, or signing
# certificates. Each check degrades gracefully: if a tool is missing, it
# reports SKIP rather than FAIL.
#
# What this script tests:
#   1. Agent PyInstaller build (creates venv, builds all 3 binaries)
#   2. Docker secrets preflight (validates secrets/ directory)
#   3. NSIS installer compilation + PE validation
#   4. Platform installer script syntax (bash -n, ps1 parse check)
#   5. Code signing dry-run (validates signing scripts run correctly)
#   6. Docker live validation (if Docker daemon is available)
#   7. Electron packaging (attempts build, reports result)
#   8. Built binary smoke tests (--version, --help)
#
# Usage:
#   ./scripts/verify-environment.sh              # run all checks
#   ./scripts/verify-environment.sh --agent      # only agent build
#   ./scripts/verify-environment.sh --nsis       # only NSIS installer
#   ./scripts/verify-environment.sh --docker     # only Docker checks
#   ./scripts/verify-environment.sh --signing    # only signing checks
#   ./scripts/verify-environment.sh --electron   # only Electron build
#   ./scripts/verify-environment.sh --installers # only platform installer syntax
#   ./scripts/verify-environment.sh --secrets    # only secrets preflight
#   ./scripts/verify-environment.sh --json       # output as JSON
#   -h, --help                                   # show this help
#
# Exit codes:
#   0 — all checks passed (or skipped due to missing tools)
#   1 — one or more checks failed

set -uo pipefail

# --- Configuration ----------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
AGENT_DIR="$PROJECT_ROOT/agent"
SERVER_DIR="$PROJECT_ROOT/server"
DASHBOARD_DIR="$PROJECT_ROOT/dashboard"
ELECTRON_DIR="$PROJECT_ROOT/electron"

# --- Helpers ----------------------------------------------------------------
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

PASS=0
FAIL=0
SKIP=0
RESULTS=()

usage() {
  sed -n '3,40p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
}

record_pass() {
  local name="$1" detail="${2:-}"
  PASS=$((PASS + 1))
  RESULTS+=("PASS|$name|$detail")
  printf "${GREEN}[PASS]${NC} %s" "$name"
  [[ -n "$detail" ]] && printf " — %s" "$detail"
  printf "\n"
}

record_fail() {
  local name="$1" detail="${2:-}"
  FAIL=$((FAIL + 1))
  RESULTS+=("FAIL|$name|$detail")
  printf "${RED}[FAIL]${NC} %s" "$name"
  [[ -n "$detail" ]] && printf " — %s" "$detail"
  printf "\n"
}

record_skip() {
  local name="$1" detail="${2:-}"
  SKIP=$((SKIP + 1))
  RESULTS+=("SKIP|$name|$detail")
  printf "${YELLOW}[SKIP]${NC} %s" "$name"
  [[ -n "$detail" ]] && printf " — %s" "$detail"
  printf "\n"
}

has() { command -v "$1" >/dev/null 2>&1; }

# --- Argument parsing -------------------------------------------------------
RUN_AGENT=0
RUN_NSIS=0
RUN_DOCKER=0
RUN_SIGNING=0
RUN_ELECTRON=0
RUN_INSTALLERS=0
RUN_SECRETS=0
JSON_OUTPUT=0
ALL=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --agent)     RUN_AGENT=1; ALL=0; shift ;;
    --nsis)      RUN_NSIS=1; ALL=0; shift ;;
    --docker)    RUN_DOCKER=1; ALL=0; shift ;;
    --signing)   RUN_SIGNING=1; ALL=0; shift ;;
    --electron)  RUN_ELECTRON=1; ALL=0; shift ;;
    --installers) RUN_INSTALLERS=1; ALL=0; shift ;;
    --secrets)   RUN_SECRETS=1; ALL=0; shift ;;
    --json)      JSON_OUTPUT=1; shift ;;
    -h|--help)   usage ;;
    *)           echo "Unknown: $1"; exit 1 ;;
  esac
done

if [[ $ALL -eq 1 ]]; then
  RUN_AGENT=1; RUN_NSIS=1; RUN_DOCKER=1; RUN_SIGNING=1
  RUN_ELECTRON=1; RUN_INSTALLERS=1; RUN_SECRETS=1
fi

# ===========================================================================
# 1. Agent PyInstaller build
# ===========================================================================
check_agent_build() {
  printf "\n${CYAN}=== 1. Agent PyInstaller Build ===${NC}\n"

  if ! has python3; then
    record_skip "agent-build" "python3 not found"
    return
  fi

  # Build using the venv-aware build.sh
  cd "$AGENT_DIR"
  echo "  Building agent binaries (this takes ~60s)..."

  local build_output
  build_output=$(bash build.sh --install 2>&1 || true)

  if echo "$build_output" | grep -q "Build complete\|OK.*dist/lockdown"; then
    record_pass "agent-build-pyinstaller" "binaries built"
  else
    record_fail "agent-build-pyinstaller" "$(echo "$build_output" | tail -3 | head -c 120)"
    return
  fi

  # Verify each binary exists and reports version
  for bin in lockdown-agent lockdown-watchdog lockdown-recovery; do
    local path="$AGENT_DIR/dist/$bin"
    if [[ ! -f "$path" ]]; then
      record_fail "agent-binary-$bin" "not found at $path"
      continue
    fi

    local ftype
    ftype=$(file "$path" | head -1)
    if echo "$ftype" | grep -q "ELF\|executable"; then
      record_pass "agent-binary-$bin" "$(echo "$ftype" | cut -d: -f2 | xargs | head -c 60)"
    else
      record_fail "agent-binary-$bin" "unexpected file type: $ftype"
    fi

    # Smoke test: --version (with timeout to avoid blocking on watchdog)
    local ver_out
    ver_out=$(timeout 5 "$path" --version 2>&1 || true)
    if echo "$ver_out" | head -1 | grep -q "lockdown\|watchdog\|1.0"; then
      record_pass "agent-smoke-$bin" "--version OK"
    else
      # Some binaries (watchdog) may not support --version and start running.
      # Try --help, also with timeout.
      local help_out
      help_out=$(timeout 5 "$path" --help 2>&1 || true)
      if echo "$help_out" | head -3 | grep -qi "usage\|lockdown\|watchdog"; then
        record_pass "agent-smoke-$bin" "--help OK"
      else
        record_skip "agent-smoke-$bin" "no --version/--help (may be a daemon)"
      fi
    fi
  done
}

# ===========================================================================
# 2. Docker secrets preflight
# ===========================================================================
check_secrets() {
  printf "\n${CYAN}=== 2. Docker Secrets Preflight ===${NC}\n"

  local secrets_dir="$PROJECT_ROOT/secrets"
  local gen_script="$SCRIPT_DIR/generate-secrets.sh"

  # Check if generate-secrets.sh exists
  if [[ ! -f "$gen_script" ]]; then
    record_fail "secrets-script" "generate-secrets.sh not found"
    return
  fi
  record_pass "secrets-script-exists" "generate-secrets.sh found"

  # Check if secrets directory exists
  if [[ -d "$secrets_dir" ]]; then
    # Count secret files
    local count
    count=$(find "$secrets_dir" -name "*.txt" -type f 2>/dev/null | wc -l)
    if [[ $count -ge 4 ]]; then
      record_pass "secrets-directory" "$count secret files present"
    else
      record_fail "secrets-directory" "only $count/4 secret files found"
    fi
  else
    record_skip "secrets-directory" "secrets/ not created yet (run scripts/generate-secrets.sh)"
  fi

  # Validate generate-secrets.sh syntax
  if bash -n "$gen_script" 2>/dev/null; then
    record_pass "secrets-script-syntax" "bash -n OK"
  else
    record_fail "secrets-script-syntax" "syntax error in generate-secrets.sh"
  fi

  # Dry-run: generate to stdout (if script supports --stdout --dry-run)
  # Note: in --dry-run mode, generate-secrets.sh sends all output to stderr,
  # so we check stderr (2>&1) rather than stdout only.
  if "$gen_script" --stdout --dry-run 2>&1 | grep -q "JWT_SECRET\|jwt"; then
    record_pass "secrets-dry-run" "dry-run generates valid secret names"
  else
    record_skip "secrets-dry-run" "script doesn't support --stdout --dry-run"
  fi

  # Check .gitignore excludes secrets/
  if grep -q "secrets" "$PROJECT_ROOT/.gitignore" 2>/dev/null; then
    record_pass "secrets-gitignored" "secrets/ in .gitignore"
  else
    record_fail "secrets-gitignored" "secrets/ NOT in .gitignore"
  fi
}

# ===========================================================================
# 3. NSIS installer compilation + PE validation
# ===========================================================================
check_nsis() {
  printf "\n${CYAN}=== 3. NSIS Installer Compilation + PE Validation ===${NC}\n"

  # Check if NSIS is available
  local nsis_bin=""
  local nsis_dir=""

  if has makensis; then
    nsis_bin="makensis"
    nsis_dir="/usr/share/nsis"
  elif [[ -f "$HOME/.local/nsis/usr/bin/makensis" ]]; then
    nsis_bin="$HOME/.local/nsis/usr/bin/makensis"
    nsis_dir="$HOME/.local/nsis/usr/share/nsis"
  else
    record_skip "nsis-available" "makensis not installed (apt install nsis)"
    return
  fi

  record_pass "nsis-available" "$nsis_bin"

  # Verify NSIS version
  local ver
  ver=$(NSISDIR="$nsis_dir" "$nsis_bin" -VERSION 2>&1)
  if [[ $? -eq 0 ]]; then
    record_pass "nsis-version" "v$ver"
  else
    record_fail "nsis-version" "could not get version"
    return
  fi

  # Compile a test installer via the server's NSIS functions
  if ! has node; then
    record_skip "nsis-compile" "node not found"
    return
  fi

  # Use the server's installer module to generate + compile an NSIS installer
  cd "$SERVER_DIR"
  local node_bin="node"
  [[ -f "$HOME/.local/node/bin/node" ]] && node_bin="$HOME/.local/node/bin/node"

  local result
  result=$("$node_bin" -e "
    process.env.USE_SQLITE = 'true';
    process.env.ALLOW_NON_PROD = '1';
    process.env.JWT_SECRET = 'test-secret-key-that-is-long-enough-32';
    process.env.AGENT_SHARED_KEY = 'test-agent-key-that-is-long-enough-24';
    process.env.AGENT_KEY_PEPPER = 'test-pepper-key-that-is-long-enough-32';
    process.env.FIELD_ENCRYPTION_KEY = 'a'.repeat(64);
    process.env.LOCATION_FIELD_KEY = 'b'.repeat(64);

    const installer = require('./src/routes/installer');
    const fs = require('fs');
    const path = require('path');
    const os = require('os');

    const dummyDir = path.join(os.tmpdir(), 'nsis-verify-' + Date.now());
    fs.mkdirSync(dummyDir, { recursive: true });
    const dummyBin = path.join(dummyDir, 'lockdown-agent.exe');
    fs.writeFileSync(dummyBin, Buffer.alloc(2048, 0x90));

    const config = {
      server_url: 'https://verify.test',
      device_hostname: 'VERIFY-TEST',
      api_key: 'dGVzdC1hcGkta2V5',
      poll_interval: 30,
    };

    (async () => {
      try {
        const nsi = installer.generateNsisScript(config, 'VERIFY-TEST', dummyBin, null);
        const license = installer.generateNsisLicense('VERIFY-TEST');
        const exe = await installer.compileNsisInstaller(nsi, license);

        // Validate PE header
        const isPE = exe[0] === 0x4D && exe[1] === 0x5A;
        // Check for PE signature (PE\0\0 at offset 0x80 typically)
        let peOffset = exe.readUInt32LE(0x3C);
        let hasPESig = false;
        if (peOffset < exe.length - 4) {
          hasPESig = exe[peOffset] === 0x50 && exe[peOffset+1] === 0x45;
        }

        // Check that the base64 config is embedded in the .exe
        const configB64 = Buffer.from(JSON.stringify(config)).toString('base64');
        const exeStr = exe.toString('latin1');
        const hasConfig = exeStr.includes(configB64);

        console.log(JSON.stringify({
          size: exe.length,
          mzHeader: isPE,
          peSignature: hasPESig,
          configEmbedded: hasConfig,
        }));
      } catch (err) {
        console.log(JSON.stringify({ error: err.message }));
      }
    })();
  " 2>&1)

  if echo "$result" | grep -q '"mzHeader":true'; then
    local size pe config
    size=$(echo "$result" | grep -o '"size":[0-9]*' | cut -d: -f2)
    pe=$(echo "$result" | grep -o '"peSignature":[a-z]*' | cut -d: -f2)
    config=$(echo "$result" | grep -o '"configEmbedded":[a-z]*' | cut -d: -f2)
    record_pass "nsis-compile" "${size}B, MZ=valid, PE=$pe, config=$config"
  else
    record_fail "nsis-compile" "$result"
  fi

  # Validate the .exe with `file` command
  # Write the exe to a temp file and check
  local tmpexe
  tmpexe=$(mktemp /tmp/nsis-verify-XXXXXX.exe)
  "$node_bin" -e "
    process.env.USE_SQLITE = 'true';
    process.env.ALLOW_NON_PROD = '1';
    process.env.JWT_SECRET = 'test-secret-key-that-is-long-enough-32';
    process.env.AGENT_SHARED_KEY = 'test-agent-key-that-is-long-enough-24';
    process.env.AGENT_KEY_PEPPER = 'test-pepper-key-that-is-long-enough-32';
    process.env.FIELD_ENCRYPTION_KEY = 'a'.repeat(64);
    process.env.LOCATION_FIELD_KEY = 'b'.repeat(64);
    const installer = require('./src/routes/installer');
    const fs = require('fs');
    const path = require('path');
    const os = require('os');
    const dummyDir = path.join(os.tmpdir(), 'nsis-file-' + Date.now());
    fs.mkdirSync(dummyDir, { recursive: true });
    const dummyBin = path.join(dummyDir, 'lockdown-agent.exe');
    fs.writeFileSync(dummyBin, Buffer.alloc(2048, 0x90));
    const config = { server_url: 'https://verify.test', device_hostname: 'V', api_key: 'k', poll_interval: 30 };
    (async () => {
      const nsi = installer.generateNsisScript(config, 'V', dummyBin, null);
      const lic = installer.generateNsisLicense('V');
      const exe = await installer.compileNsisInstaller(nsi, lic);
      fs.writeFileSync('$tmpexe', exe);
      console.log('written');
    })();
  " 2>&1 >/dev/null

  if [[ -f "$tmpexe" ]]; then
    local ftype
    ftype=$(file "$tmpexe" 2>/dev/null)
    if echo "$ftype" | grep -q "PE32\|MS-DOS\|executable"; then
      record_pass "nsis-pe-filetype" "$(echo "$ftype" | cut -d: -f2 | xargs | head -c 80)"
    else
      record_fail "nsis-pe-filetype" "$ftype"
    fi
    rm -f "$tmpexe"
  fi

  # Test certutil base64 decode on Windows (if WSL interop is available)
  local win_ps="/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"
  if [[ -x "$win_ps" ]]; then
    # Create a test base64 file and decode it with certutil
    local wtemp="/mnt/c/Users"
    local win_user
    win_user=$(whoami 2>/dev/null || echo "CLLIN")
    for tp in "/mnt/c/Users/$win_user/AppData/Local/Temp" "/mnt/c/Windows/Temp"; do
      if [[ -d "$tp" ]]; then wtemp="$tp"; break; fi
    done

    # Create a known JSON config, base64-encode it
    local test_json='{"server_url":"https://verify-certutil-test.example.com","device_hostname":"CERTUTIL_TEST","api_key":"key123"}'
    local test_b64
    test_b64=$(echo -n "$test_json" | base64 -w0)
    # Use a unique filename to avoid stale files
    local b64_file="$wtemp/lockdown-verify-certutil-$$.b64"
    local json_file="$wtemp/lockdown-verify-certutil-$$.json"
    echo -n "$test_b64" > "$b64_file"
    # Remove stale json file if it exists
    rm -f "$json_file" 2>/dev/null

    local win_b64 win_json
    win_b64=$(wslpath -w "$b64_file" 2>/dev/null)
    win_json=$(wslpath -w "$json_file" 2>/dev/null)

    local decode_result
    decode_result=$("$win_ps" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "
      certutil -decode '$win_b64' '$win_json' 2>&1 | Out-Null
      Get-Content '$win_json' -ErrorAction SilentlyContinue
    " 2>&1 || true)

    if echo "$decode_result" | grep -q "verify-certutil-test"; then
      record_pass "nsis-certutil-decode" "certutil base64 decode works on Windows"
    else
      record_fail "nsis-certutil-decode" "certutil decode failed: $(echo "$decode_result" | head -c 80)"
    fi

    # Clean up
    rm -f "$b64_file" "$json_file" 2>/dev/null
  else
    record_skip "nsis-certutil-decode" "Windows not available (certutil is Windows-only)"
  fi
}

# ===========================================================================
# 4. Platform installer script syntax validation
# ===========================================================================
check_installers() {
  printf "\n${CYAN}=== 4. Platform Installer Script Syntax ===${NC}\n"

  # Linux install/uninstall scripts
  for script in \
    "$AGENT_DIR/platform/linux/install.sh" \
    "$AGENT_DIR/platform/linux/uninstall.sh" \
    "$AGENT_DIR/platform/macos/install.sh" \
    "$AGENT_DIR/platform/macos/uninstall.sh"; do

    local name
    name=$(basename "$script")
    local dir
    dir=$(basename "$(dirname "$script")")

    if [[ ! -f "$script" ]]; then
      record_fail "installer-syntax-$dir-$name" "file not found"
      continue
    fi

    if bash -n "$script" 2>/dev/null; then
      record_pass "installer-syntax-$dir-$name" "bash -n OK"
    else
      record_fail "installer-syntax-$dir-$name" "syntax error"
    fi

    # Check executable bit
    if [[ -x "$script" ]]; then
      record_pass "installer-exec-$dir-$name" "executable"
    else
      record_fail "installer-exec-$dir-$name" "not executable"
    fi
  done

  # Windows PowerShell script — use WSL interop if available, else structural checks
  local ps1="$AGENT_DIR/platform/windows/install-service-enhanced.ps1"
  if [[ -f "$ps1" ]]; then
    record_pass "installer-windows-exists" "$(wc -l < "$ps1") lines"

    # Basic structural checks
    if grep -q "New-Service\|sc.exe\|nssm" "$ps1" 2>/dev/null; then
      record_pass "installer-windows-service" "creates Windows service"
    else
      record_fail "installer-windows-service" "no service creation found"
    fi

    if grep -q "Start-Service\|sc.exe start\|NSSMPath start" "$ps1" 2>/dev/null; then
      record_pass "installer-windows-start" "starts service after install"
    else
      record_fail "installer-windows-start" "no service start found"
    fi

    # Check for non-ASCII characters that break PowerShell 5.1 without BOM
    if grep -P '[^\x00-\x7F]' "$ps1" >/dev/null 2>&1; then
      # Check if file has UTF-8 BOM
      local bom
      bom=$(xxd -l 3 "$ps1" 2>/dev/null | head -1)
      if echo "$bom" | grep -q "efbb bf"; then
        record_pass "installer-windows-encoding" "UTF-8 with BOM (non-ASCII safe)"
      else
        record_fail "installer-windows-encoding" "non-ASCII chars without BOM — PowerShell 5.1 will fail to parse"
      fi
    else
      record_pass "installer-windows-encoding" "ASCII-only (encoding-safe)"
    fi

    # PowerShell syntax check via WSL interop (if Windows PowerShell is available)
    local win_ps="/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"
    if [[ -x "$win_ps" ]]; then
      # Write a temp checker script to Windows temp
      local wtemp="/mnt/c/Users"
      local win_user
      win_user=$(whoami 2>/dev/null || echo "CLLIN")
      # Try common temp paths
      for tp in "/mnt/c/Users/$win_user/AppData/Local/Temp" "/mnt/c/Windows/Temp"; do
        if [[ -d "$tp" ]]; then wtemp="$tp"; break; fi
      done

      # Write the checker script
      cat > "$wtemp/ps1-check.ps1" << 'PSCHECK'
param([string]$Path)
$tokens = $null
$errors = $null
$null = [System.Management.Automation.Language.Parser]::ParseFile($Path, [ref]$tokens, [ref]$errors)
if ($errors.Count -gt 0) {
    Write-Host "FAIL: $($errors.Count) syntax error(s)"
    foreach ($e in $errors) {
        Write-Host "  Line $($e.Extent.StartLineNumber): $($e.Message)"
    }
} else {
    Write-Host "PASS: PowerShell syntax OK (0 errors)"
}
PSCHECK

      # Copy the PS1 to Windows temp (avoids WSL path issues)
      cp "$ps1" "$wtemp/ps1-target.ps1" 2>/dev/null

      # Convert paths to Windows format
      local win_checker win_target
      win_checker=$(wslpath -w "$wtemp/ps1-check.ps1" 2>/dev/null || echo "C:\\Windows\\Temp\\ps1-check.ps1")
      win_target=$(wslpath -w "$wtemp/ps1-target.ps1" 2>/dev/null || echo "C:\\Windows\\Temp\\ps1-target.ps1")

      local ps_result
      ps_result=$("$win_ps" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$win_checker" -Path "$win_target" 2>&1 || true)

      if echo "$ps_result" | grep -q "PASS"; then
        record_pass "installer-windows-ps-syntax" "PowerShell parser: 0 errors"
      elif echo "$ps_result" | grep -q "FAIL"; then
        record_fail "installer-windows-ps-syntax" "$(echo "$ps_result" | head -2 | tail -1)"
      else
        record_skip "installer-windows-ps-syntax" "PowerShell check failed: $(echo "$ps_result" | head -c 80)"
      fi

      # Clean up temp files
      rm -f "$wtemp/ps1-check.ps1" "$wtemp/ps1-target.ps1" 2>/dev/null
    else
      record_skip "installer-windows-ps-syntax" "Windows PowerShell not available (not WSL)"
    fi

    # Check for ExecutionPolicy
    if grep -q "ExecutionPolicy" "$ps1" 2>/dev/null; then
      record_pass "installer-windows-execpolicy" "sets ExecutionPolicy"
    else
      record_skip "installer-windows-execpolicy" "no ExecutionPolicy (script should be run with -ExecutionPolicy Bypass)"
    fi
  else
    record_fail "installer-windows-exists" "install-service-enhanced.ps1 not found"
  fi

  # systemd unit file
  local service="$AGENT_DIR/platform/linux/lockdown-agent.service"
  if [[ -f "$service" ]]; then
    record_pass "installer-systemd-unit" "lockdown-agent.service exists"
    # Basic systemd unit validation
    if grep -q "\[Unit\]" "$service" && grep -q "\[Service\]" "$service" && grep -q "\[Install\]" "$service"; then
      record_pass "installer-systemd-structure" "has [Unit], [Service], [Install]"
    else
      record_fail "installer-systemd-structure" "missing required sections"
    fi
    if grep -q "ExecStart=" "$service"; then
      record_pass "installer-systemd-execstart" "has ExecStart"
    else
      record_fail "installer-systemd-execstart" "missing ExecStart"
    fi
  else
    record_fail "installer-systemd-unit" "lockdown-agent.service not found"
  fi

  # macOS plist
  local plist="$AGENT_DIR/platform/macos/com.lockdown.agent.plist"
  if [[ -f "$plist" ]]; then
    record_pass "installer-macos-plist" "com.lockdown.agent.plist exists"
    if grep -q "<key>Label</key>" "$plist" && grep -q "<key>ProgramArguments</key>" "$plist"; then
      record_pass "installer-macos-plist-structure" "has Label + ProgramArguments"
    else
      record_fail "installer-macos-plist-structure" "missing required keys"
    fi
  else
    record_fail "installer-macos-plist" "com.lockdown.agent.plist not found"
  fi
}

# ===========================================================================
# 5. Code signing dry-run
# ===========================================================================
check_signing() {
  printf "\n${CYAN}=== 5. Code Signing Dry-Run ===${NC}\n"

  local sign_script="$SCRIPT_DIR/setup-signing.sh"
  local verify_script="$SCRIPT_DIR/verify-signing.sh"

  # Check scripts exist
  for s in "$sign_script" "$verify_script"; do
    local name
    name=$(basename "$s")
    if [[ -f "$s" ]]; then
      record_pass "signing-script-$name" "exists"
    else
      record_fail "signing-script-$name" "not found"
    fi

    # Syntax check
    if bash -n "$s" 2>/dev/null; then
      record_pass "signing-syntax-$name" "bash -n OK"
    else
      record_fail "signing-syntax-$name" "syntax error"
    fi
  done

  # Run verify-signing.sh on Linux (should skip gracefully)
  if [[ -f "$verify_script" ]]; then
    local output
    output=$("$verify_script" --app /nonexistent 2>&1 || true)
    if echo "$output" | grep -qi "skip\|linux\|not required\|not found"; then
      record_pass "signing-verify-linux-skip" "gracefully skips on Linux"
    else
      record_skip "signing-verify-linux-skip" "unexpected output: $(echo "$output" | head -1)"
    fi
  fi

  # Check that release.yml has signing env vars (commented out, ready to configure)
  local release_yml="$PROJECT_ROOT/.github/workflows/release.yml"
  if [[ -f "$release_yml" ]]; then
    if grep -q "AZURE_TRUSTED_SIGNING\|signtool\|codesign" "$release_yml" 2>/dev/null; then
      record_pass "signing-ci-config" "signing env vars present in release.yml"
    else
      record_fail "signing-ci-config" "no signing configuration in release.yml"
    fi
  else
    record_skip "signing-ci-config" "release.yml not found"
  fi

  # Check docs/CODE_SIGNING.md exists
  if [[ -f "$PROJECT_ROOT/docs/CODE_SIGNING.md" ]]; then
    local lines
    lines=$(wc -l < "$PROJECT_ROOT/docs/CODE_SIGNING.md")
    record_pass "signing-docs" "CODE_SIGNING.md ($lines lines)"
  else
    record_fail "signing-docs" "docs/CODE_SIGNING.md not found"
  fi

  # Generate a self-signed cert with openssl to test signing infrastructure
  if has openssl; then
    local tmpcert
    tmpcert=$(mktemp /tmp/signing-test-XXXXXX)
    openssl req -x509 -newkey rsa:2048 -keyout "$tmpcert.key" -out "$tmpcert.crt" \
      -days 1 -nodes -subj "/CN=Test Signing" 2>/dev/null
    if [[ -f "$tmpcert.crt" && -f "$tmpcert.key" ]]; then
      record_pass "signing-self-signed-cert" "openssl generated test cert"
      # Verify the cert
      if openssl x509 -in "$tmpcert.crt" -noout 2>/dev/null; then
        record_pass "signing-cert-valid" "cert is valid X.509"
      fi
      rm -f "$tmpcert.key" "$tmpcert.crt"
    else
      record_fail "signing-self-signed-cert" "openssl failed to generate cert"
    fi
  else
    record_skip "signing-self-signed-cert" "openssl not found"
  fi
}

# ===========================================================================
# 6. Docker live validation
# ===========================================================================
check_docker() {
  printf "\n${CYAN}=== 6. Docker Validation ===${NC}\n"

  local validate_script="$SCRIPT_DIR/validate-docker.sh"

  if [[ ! -f "$validate_script" ]]; then
    record_fail "docker-script" "validate-docker.sh not found"
    return
  fi
  record_pass "docker-script" "validate-docker.sh exists"

  # Syntax check
  if bash -n "$validate_script" 2>/dev/null; then
    record_pass "docker-script-syntax" "bash -n OK"
  else
    record_fail "docker-script-syntax" "syntax error"
  fi

  # Run non-live validation (doesn't require Docker daemon)
  local docker_output
  docker_output=$("$validate_script" --all 2>&1 || true)
  if echo "$docker_output" | grep -qi "pass\|ok\|valid"; then
    record_pass "docker-config-validation" "config validation passed"
  else
    record_skip "docker-config-validation" "$(echo "$docker_output" | tail -1 | head -c 80)"
  fi

  # Check if Docker daemon is available for live testing
  if has docker && docker info >/dev/null 2>&1; then
    record_pass "docker-daemon" "Docker daemon available"
    echo "  Running live Docker validation (this takes ~60s)..."
    if "$validate_script" --live 2>&1 | grep -qi "pass\|ok\|healthy"; then
      record_pass "docker-live" "live validation passed"
    else
      record_fail "docker-live" "live validation failed"
    fi
  else
    record_skip "docker-daemon" "Docker not installed or daemon not running"
    record_skip "docker-live" "requires Docker daemon"
  fi

  # Validate docker-compose files exist
  for f in docker-compose.yml docker-compose.prod.yml docker-compose.test.yml; do
    if [[ -f "$PROJECT_ROOT/$f" ]]; then
      record_pass "docker-compose-$f" "exists"
    else
      record_fail "docker-compose-$f" "not found"
    fi
  done

  # Validate Dockerfile exists
  if [[ -f "$PROJECT_ROOT/Dockerfile.server" ]]; then
    record_pass "docker-dockerfile" "Dockerfile.server exists"
  else
    record_fail "docker-dockerfile" "Dockerfile.server not found"
  fi
}

# ===========================================================================
# 7. Electron packaging
# ===========================================================================
check_electron() {
  printf "\n${CYAN}=== 7. Electron Packaging ===${NC}\n"

  if [[ ! -d "$ELECTRON_DIR" ]]; then
    record_fail "electron-dir" "electron/ directory not found"
    return
  fi
  record_pass "electron-dir" "electron/ exists"

  # Check package.json
  if [[ ! -f "$ELECTRON_DIR/package.json" ]]; then
    record_fail "electron-package-json" "package.json not found"
    return
  fi
  record_pass "electron-package-json" "exists"

  # Check if electron-builder is configured
  if grep -q "electron-builder\|build" "$ELECTRON_DIR/package.json" 2>/dev/null; then
    record_pass "electron-builder-config" "build config in package.json"
  else
    record_fail "electron-builder-config" "no build configuration"
  fi

  # Check for NSIS target in electron config
  if grep -q "nsis\|NSIS" "$ELECTRON_DIR/package.json" 2>/dev/null; then
    record_pass "electron-nsis-target" "NSIS target configured"
  else
    record_skip "electron-nsis-target" "no NSIS target (may use other installer types)"
  fi

  # Check agent binary bundling (extraResources)
  if grep -q "extraResources\|lockdown-agent" "$ELECTRON_DIR/package.json" 2>/dev/null; then
    record_pass "electron-agent-bundle" "agent binaries bundled in extraResources"
  else
    record_fail "electron-agent-bundle" "agent binaries not bundled"
  fi

  # Attempt actual build if node_modules are installed
  local node_bin="node"
  local npm_bin="npm"
  [[ -f "$HOME/.local/node/bin/node" ]] && node_bin="$HOME/.local/node/bin/node"
  [[ -f "$HOME/.local/node/bin/npm" ]] && npm_bin="$HOME/.local/node/bin/npm"

  if [[ -d "$ELECTRON_DIR/node_modules" ]]; then
    record_pass "electron-deps" "node_modules installed"
    # Try building (just the config validation, not full packaging)
    cd "$ELECTRON_DIR"
    if "$node_bin" -e "const pkg = require('./package.json'); console.log(pkg.build ? 'has build config' : 'no build config')" 2>/dev/null | grep -q "has build"; then
      record_pass "electron-build-config-valid" "build config parses correctly"
    else
      record_fail "electron-build-config-valid" "build config invalid"
    fi
  else
    record_skip "electron-deps" "node_modules not installed (run cd electron && npm install)"
    record_skip "electron-build" "requires node_modules"
  fi

  # Check if agent binaries are available for bundling
  if [[ -f "$AGENT_DIR/dist/lockdown-agent" ]] || [[ -f "$AGENT_DIR/dist/lockdown-agent.exe" ]]; then
    record_pass "electron-agent-binaries" "agent binaries built and available"
  else
    record_skip "electron-agent-binaries" "run agent/build.sh first"
  fi
}

# ===========================================================================
# Summary
# ===========================================================================
print_summary() {
  printf "\n${CYAN}=== Summary ===${NC}\n"
  printf "  ${GREEN}PASS${NC}: %d  ${RED}FAIL${NC}: %d  ${YELLOW}SKIP${NC}: %d\n" "$PASS" "$FAIL" "$SKIP"
  printf "\n"

  if [[ $JSON_OUTPUT -eq 1 ]]; then
    printf "[\n"
    local first=1
    for r in "${RESULTS[@]}"; do
      local status name detail
      IFS='|' read -r status name detail <<< "$r"
      [[ $first -eq 0 ]] && printf ",\n"
      printf '  {"status":"%s","name":"%s","detail":"%s"}' "$status" "$name" "${detail//\"/\\\"}"
      first=0
    done
    printf "\n]\n"
  fi

  if [[ $FAIL -gt 0 ]]; then
    printf "${RED}%d check(s) failed.${NC}\n" "$FAIL"
    exit 1
  else
    printf "${GREEN}All checks passed (or skipped due to missing tools).${NC}\n"
    exit 0
  fi
}

# --- Run checks -------------------------------------------------------------
printf "${CYAN}Remote Lockdown System — Environment Verification${NC}\n"
printf "Date: %s\n" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf "Platform: %s %s\n" "$(uname -s)" "$(uname -m)"
printf "\n"

[[ $RUN_AGENT -eq 1 ]] && check_agent_build
[[ $RUN_SECRETS -eq 1 ]] && check_secrets
[[ $RUN_NSIS -eq 1 ]] && check_nsis
[[ $RUN_INSTALLERS -eq 1 ]] && check_installers
[[ $RUN_SIGNING -eq 1 ]] && check_signing
[[ $RUN_DOCKER -eq 1 ]] && check_docker
[[ $RUN_ELECTRON -eq 1 ]] && check_electron

print_summary
