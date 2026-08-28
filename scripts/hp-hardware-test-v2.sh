#!/usr/bin/env bash
#
# HP Hardware Test Guide v2 — Complete procedure for testing all enforcement
# paths + new features on real HP hardware.
#
# NEW in v2 (2026-08-28):
#   - Token-based enrollment (no admin password on target)
#   - Duress code test (fake unlock → re-lock)
#   - Hidden file trigger test (.system_cache_cleanup)
#   - Tamper protection test (delete protected files → re-lock)
#   - TPM sealing test (verify state is TPM-sealed)
#   - No BIOS/BCD tests (user opted out)
#
# Usage:
#   bash scripts/hp-hardware-test-v2.sh
#
# The script displays each phase with exact commands. Some run on the HP
# machine (PowerShell), some on the dev machine (WSL2 bash).

set -euo pipefail

if [[ -t 1 ]] && command -v tput >/dev/null 2>&1 && [[ "$(tput colors 2>/dev/null || echo 0)" -ge 8 ]]; then
  BOLD=$(tput bold); DIM=$(tput dim); RESET=$(tput sgr0)
  BLUE=$(tput setaf 4); GREEN=$(tput setaf 2); YELLOW=$(tput setaf 3); RED=$(tput setaf 1)
  CYAN=$(tput setaf 6)
else
  BOLD=""; DIM=""; RESET=""; BLUE=""; GREEN=""; YELLOW=""; RED=""; CYAN=""
fi

TOTAL_PHASES=8

_clear() {
  [[ -t 1 ]] || return 0
  if command -v tput >/dev/null 2>&1; then tput clear; else printf '\033[2J\033[3J\033[H'; fi
}

phase() {
  _clear
  printf '\n%s%s  Phase %s/%s — %s%s\n' "$BOLD" "$BLUE" "$1" "$TOTAL_PHASES" "$2" "$RESET"
  printf '%s  ──────────────────────────────────────────────────%s\n\n' "$DIM" "$RESET"
}

say()  { printf '  %s\n' "$1"; }
cmd()  { printf '  %s$ %s%s\n' "$GREEN" "$1" "$RESET"; }
note() { printf '  %s%s%s\n' "$DIM" "$1" "$RESET"; }
warn() { printf '  %s⚠ %s%s\n' "$YELLOW" "$1" "$RESET"; }
ok()   { printf '  %s✓ %s%s\n' "$GREEN" "$1" "$RESET"; }
pause() {
  printf '\n  %s%s%s ' "$DIM" "${1:-Press Enter to continue}" "$RESET"
  read -r _ || true
}

WORKER_URL="https://lockdown-serverless.mainacollins196.workers.dev"
AGENT_DIR="/home/cllin/remote-lockdown-system/agent"

# ════════════════════════════════════════════════════════════════════════════
banner() {
  _clear
  printf '\n%s%s  HP Hardware Test Guide v2%s\n' "$BOLD" "$BLUE" "$RESET"
  printf '%s  %s phases — harness + full agent cycle + new features%s\n\n' "$DIM" "$TOTAL_PHASES" "$RESET"
  printf '  Tests all enforcement paths on real HP hardware, plus the\n'
  printf '  3 new workstreams: enrollment tokens, duress/hidden trigger,\n'
  printf '  tamper protection + TPM sealing.\n\n'
  printf '  %sBIOS/BCD tests: SKIPPED (user opted out)%s\n' "$YELLOW" "$RESET"
  printf '\n'
  printf '  %sPrerequisites:%s\n' "$BOLD" "$RESET"
  printf '    • Spare HP EliteBook on the same LAN (powered on)\n'
  printf '    • Admin account on the HP machine\n'
  printf '    • Python 3.10+ installed on the HP machine\n'
  printf '    • Both machines on same network (for file copy)\n'
  printf '    • The Electron admin app running on this dev machine\n'
  printf '\n'
  printf '  %sWorker URL:%s %s\n' "$BOLD" "$RESET" "$WORKER_URL"
  printf '\n'
  pause "Ready to start?"
}

# ════════════════════════════════════════════════════════════════════════════

banner

# ── Phase 1: Get agent code onto the HP machine ────────────────────────────
phase 1 "Copy agent code to HP machine"

say "First, find the HP machine's IP address."
say "On the HP machine (PowerShell):"
cmd "ipconfig | Select-String 'IPv4'"
echo
say "From this dev machine (WSL2), copy the agent folder to the HP:"
cmd "# Replace <HP-IP> and <username> with your values:"
cmd "scp -r ${AGENT_DIR}/ <username>@<HP-IP>:C:/Users/<username>/lockdown-agent/"
echo
note "If scp doesn't work (no SSH on HP), use one of these alternatives:"
echo
say "  Option B — Windows file share:"
cmd "# On HP machine (PowerShell, Admin):"
cmd "net share agent\$ = C:\\Users\\<username>\\lockdown-agent /grant:everyone,FULL"
cmd "# Then from WSL2:"
cmd "cp -r ${AGENT_DIR}/ /mnt/<HP-IP>/agent/"
echo
say "  Option C — USB drive:"
cmd "# Copy agent/ to a USB drive from WSL2, then plug into HP"
echo
say "  Option D — Git clone (if HP has git + network access):"
cmd "# On the HP machine:"
cmd "git clone <your-repo-url> C:\\Users\\<username>\\lockdown-system"
cmd "cd C:\\Users\\<username>\\lockdown-system\\agent"
echo
warn "Make sure ALL new files are copied: duress.py, tamper_protection.py,"
warn "tpm_seal.py, installer.py — these are new since the last hardware test."
echo
pause "Press Enter when the agent code is on the HP machine"

# ── Phase 2: Prepare the HP machine ────────────────────────────────────────
phase 2 "Prepare the HP machine"

say "On the HP machine, open PowerShell as Administrator:"
cmd "Right-click Start → Windows Terminal (Admin) → PowerShell tab"
echo
say "Check Python is installed:"
cmd "python --version"
note "Need Python 3.10+. If not installed, download from python.org (check 'Add to PATH')."
echo
say "Install the agent's Python dependencies:"
cmd "pip install cryptography==50.0.0 requests==2.34.2"
echo
say "Verify the new modules are present:"
cmd "cd C:\\Users\\<username>\\lockdown-agent"
cmd "dir duress.py tamper_protection.py tpm_seal.py installer.py hw_test_harness.py"
echo
say "Create a test lockdown folder with test files:"
cmd "mkdir C:\\lockdown-test"
cmd 'echo "sensitive document content" > C:\lockdown-test\secret.txt'
cmd 'echo "financial data" > C:\lockdown-test\financials.xlsx'
echo
say "Create the agent state directory:"
cmd "mkdir C:\\ProgramData\\lockdown-agent -Force"
echo
pause "Press Enter when the HP machine is ready"

# ── Phase 3: Run hardware test harness (safe tests only) ───────────────────
phase 3 "Run hardware test harness"

say "On the HP machine, in the agent directory (Admin PowerShell):"
echo
say "Step 1: Dry run first — check environment detection:"
cmd "cd C:\\Users\\<username>\\lockdown-agent"
cmd "python hw_test_harness.py --dry-run"
echo
note "This should print: Platform=Windows, Is HP=True, HP model=<your model>,"
note "Is admin=True, BitLocker=<enabled/disabled>. All tests show SKIP (dry run)."
echo
say "Step 2: Run the safe tests (encrypt, lock-screen, guardian):"
cmd "python hw_test_harness.py --only encrypt"
ok "E-ENCRYPT: File encryption roundtrip"
echo
cmd "python hw_test_harness.py --only lock-screen"
note "The lock-screen test WILL LOCK YOUR SCREEN. Be prepared to unlock."
ok "E-LOCK-SCREEN: LockWorkStation"
echo
cmd "python hw_test_harness.py --only guardian"
note "The guardian test runs for 12 seconds and re-locks the screen."
ok "E-GUARDIAN: Lock guardian thread"
echo
say "Step 3: Save the artifact:"
cmd "python hw_test_harness.py --only encrypt --only lock-screen --only guardian --artifact hw_test_artifact_hp.json"
echo
say "Copy the artifact back to the dev machine:"
cmd "# On the dev machine (WSL2):"
cmd "scp <username>@<HP-IP>:C:/Users/<username>/lockdown-agent/hw_test_artifact_hp.json ${AGENT_DIR}/"
echo
pause "Press Enter when the harness tests are complete"

# ── Phase 4: Enroll the HP device via token ────────────────────────────────
phase 4 "Enroll the HP device via enrollment token"

say "This uses the NEW token-based enrollment flow — no admin password needed"
say "on the HP machine."
echo
say "Step 1: Generate an enrollment token in the dashboard:"
say "  a) Open the Electron admin app (on this dev machine)"
say "  b) Go to Devices → Enroll Device"
say "  c) Click 'Generate Enrollment Token'"
say "  d) Copy the install command (includes token + server URL)"
echo
say "Step 2: Get the HP machine's hostname (run on HP):"
cmd "hostname"
note "Write this down — you'll need it for the installer."
echo
say "Step 3: Run the installer on the HP machine with the token:"
cmd "cd C:\\Users\\<username>\\lockdown-agent"
cmd "python installer.py --token <PASTE-TOKEN-HERE> --server-url ${WORKER_URL} --hostname <HP-HOSTNAME> --owner-name 'Hardware Test'"
echo
note "The installer will:"
note "  1. Call POST /api/enroll/claim with the token"
note "  2. Get back a device_id + api_key"
note "  3. Write config.json with the API key"
note "  4. Optionally install the service (add --install-service for that)"
echo
say "Step 4: Verify the device appeared in the dashboard:"
say "  - The EnrollDevicePage should auto-detect the new device"
say "  - Or check Devices page — the HP machine should be listed"
echo
say "Step 5: Verify from the dev machine (WSL2):"
cmd "curl -sS ${WORKER_URL}/api/devices -H 'Authorization: Bearer <ADMIN-TOKEN>' | python3 -m json.tool"
echo
ok "E-ENROLL-TOKEN: Token-based enrollment"
echo
say "Save the API key and device ID from the installer output."
say "You'll need them for the agent config."
echo
pause "Press Enter when the device is enrolled"

# ── Phase 5: Run the full agent lockdown cycle ─────────────────────────────
phase 5 "Full agent lockdown + recovery cycle"

say "On the HP machine, verify the config.json was created:"
cmd "cd C:\\Users\\<username>\\lockdown-agent"
cmd "type config.json"
echo
note "The config should have: server_url, api_key, hostname, lockdown_folder."
note "If lockdown_folder is missing, add it manually:"
cmd '# Edit config.json and add: "lockdown_folder": "C:\\\\lockdown-test"'
echo
say "Start the agent (it will check in and wait for commands):"
cmd "python agent.py --config config.json"
echo
note "The agent should print 'Agent starting' and check in successfully."
note "It will show 'status=active, poll=300s, command=null'."
note "Leave it running — don't close this terminal."
echo
say "On the dev machine, flag the device as stolen via the dashboard:"
say "  a) Open the Electron admin app"
say "  b) Go to Devices → click on the HP device"
say "  c) Click 'Flag as Stolen'"
say "  d) Confirm the hostname"
echo
say "OR via curl from WSL2:"
cmd "curl -sS -X POST ${WORKER_URL}/api/devices/<DEVICE-ID>/flag-stolen \\"
cmd "  -H 'Content-Type: application/json' \\"
cmd "  -H 'Authorization: Bearer <ADMIN-TOKEN>' \\"
cmd '  -d "{\"hostname_confirm\":\"<HP-HOSTNAME>\"}"'
echo
say "Watch the agent terminal — within 10-30 seconds it should:"
say "  1. Receive the lockdown command"
say "  2. Encrypt the files in C:\\lockdown-test"
say "  3. Lock the screen"
say "  4. Start the lock guardian"
say "  5. Send ACK to the server"
echo
say "Verify the files are encrypted (on the HP machine, NEW terminal):"
cmd "dir C:\\lockdown-test"
note "You should see .enc files instead of the original .txt/.xlsx files."
echo
ok "E-ENCRYPT: Files encrypted on real hardware"
ok "E-LOCK-SCREEN: Screen locked on real hardware"
ok "E-GUARDIAN: Guardian running on real hardware"
ok "E-ACK: Command ACKed to server"
echo
say "Now recover the device via the dashboard:"
say "  a) In the device detail page, click 'Release'"
say "  b) Confirm the hostname"
echo
say "OR via curl:"
cmd "curl -sS -X POST ${WORKER_URL}/api/devices/<DEVICE-ID>/recover \\"
cmd "  -H 'Content-Type: application/json' \\"
cmd "  -H 'Authorization: Bearer <ADMIN-TOKEN>' \\"
cmd '  -d "{\"hostname_confirm\":\"<HP-HOSTNAME>\"}"'
echo
say "Watch the agent terminal — within 30-60 seconds it should:"
say "  1. Receive the unlock command with key_material"
say "  2. Decrypt the files in C:\\lockdown-test"
say "  3. Remove the lock sentinel"
say "  4. Remove the lock screen"
say "  5. Send ACK to the server"
echo
say "Verify the files are decrypted back to original:"
cmd "dir C:\\lockdown-test"
cmd "type C:\\lockdown-test\\secret.txt"
note "You should see the original .txt/.xlsx files with original content."
echo
ok "E-RECOVERY: Files decrypted + screen unlocked on real hardware"
echo
pause "Press Enter when the lockdown + recovery cycle is verified"

# ── Phase 6: Test duress code ──────────────────────────────────────────────
phase 6 "Test duress code (fake unlock → re-lock)"

say "This tests the NEW duress code feature: the agent pretends to unlock,"
say "then silently re-encrypts with a new key and re-locks after 5 minutes."
echo
warn "WARNING: This test will leave the files encrypted with a NEW key."
warn "The duress re-lock generates a new encryption key and reports it to"
warn "the server. You'll need to do a normal recovery afterward to decrypt."
echo
say "Step 1: Flag the device as stolen again (via dashboard or curl):"
cmd "curl -sS -X POST ${WORKER_URL}/api/devices/<DEVICE-ID>/flag-stolen \\"
cmd "  -H 'Content-Type: application/json' \\"
cmd "  -H 'Authorization: Bearer <ADMIN-TOKEN>' \\"
cmd '  -d "{\"hostname_confirm\":\"<HP-HOSTNAME>\"}"'
echo
say "Wait for the agent to lock down (encrypt + lock screen)."
echo
say "Step 2: Release with duress code (via dashboard):"
say "  a) In the device detail page, click 'Release with Duress Code'"
say "  b) Confirm the hostname"
say "  c) The dashboard shows 'recovering' — the agent will pretend to unlock"
echo
say "OR via curl (add duress_code:true to the recover request):"
cmd "curl -sS -X POST ${WORKER_URL}/api/devices/<DEVICE-ID>/recover \\"
cmd "  -H 'Content-Type: application/json' \\"
cmd "  -H 'Authorization: Bearer <ADMIN-TOKEN>' \\"
cmd '  -d "{\"hostname_confirm\":\"<HP-HOSTNAME>\",\"duress_code\":true}"'
echo
say "Step 3: Watch the agent terminal — it should:"
say "  1. Receive the unlock command with duress_code=true"
say "  2. Pretend to unlock (decrypt files, remove lock screen)"
say "  3. Wait 60 seconds (re-encryption delay)"
say "  4. Re-encrypt files with a NEW key"
say "  5. Wait 5 minutes (re-lock delay)"
say "  6. Re-lock the screen"
say "  7. Report the new key to the server"
echo
note "The files will appear decrypted during the 60-second window,"
note "then re-encrypted. The screen will be unlocked for ~5 minutes,"
note "then re-locked. This is the intended behavior."
echo
say "Step 4: Verify the re-lock happened:"
cmd "dir C:\\lockdown-test"
note "Files should be .enc again (re-encrypted with new key)."
echo
say "Step 5: Do a normal recovery to decrypt with the new key:"
cmd "curl -sS -X POST ${WORKER_URL}/api/devices/<DEVICE-ID>/recover \\"
cmd "  -H 'Content-Type: application/json' \\"
cmd "  -H 'Authorization: Bearer <ADMIN-TOKEN>' \\"
cmd '  -d "{\"hostname_confirm\":\"<HP-HOSTNAME>\"}"'
echo
say "Wait for the agent to decrypt with the duress key, then verify:"
cmd "type C:\\lockdown-test\\secret.txt"
note "Content should be back to original."
echo
ok "E-DURESS: Duress code fake unlock + re-lock verified"
echo
pause "Press Enter when the duress code test is complete"

# ── Phase 7: Test hidden file trigger + tamper protection ──────────────────
phase 7 "Test hidden file trigger + tamper protection"

say "This tests TWO new features:"
say "  1. Hidden file trigger: creating .system_cache_cleanup triggers lockdown"
say "  2. Tamper protection: deleting protected files while locked triggers re-lock"
echo

say "── Part A: Hidden file trigger ──"
echo
say "Step 1: Make sure the device is in 'active' state (not locked)."
say "  If it's still locked from Phase 6, wait for recovery to complete."
echo
say "Step 2: Create the hidden trigger file in the agent state directory:"
cmd "# On the HP machine (PowerShell):"
cmd 'echo "trigger" > C:\ProgramData\lockdown-agent\.system_cache_cleanup'
echo
say "Step 3: Watch the agent terminal — within 10 seconds it should:"
say "  1. Detect the .system_cache_cleanup file"
say "  2. Trigger an immediate lockdown"
say "  3. Encrypt files, lock screen, start guardian"
say "  4. Delete the trigger file"
say "  5. Report lockdown to the server"
echo
say "Step 4: Verify the trigger file was deleted:"
cmd "dir C:\\ProgramData\\lockdown-agent\\.system_cache_cleanup"
note "Should say 'File not found' — the agent deletes it after acting."
echo
say "Step 5: Verify the files are encrypted:"
cmd "dir C:\\lockdown-test"
note "Should see .enc files."
echo
ok "E-HIDDEN-TRIGGER: Hidden file trigger verified"
echo

say "── Part B: Tamper protection ──"
echo
say "The device should now be in 'locked' state from the hidden trigger."
echo
say "Step 1: Try to tamper with the agent — delete the lock sentinel:"
cmd "# On the HP machine (NEW PowerShell terminal, Admin):"
cmd 'del C:\ProgramData\lockdown-agent\.locked'
echo
say "Step 2: Wait 5 minutes (tamper check runs every 5 min)."
say "  OR restart the agent to trigger an immediate check:"
cmd "# Ctrl+C the agent, then restart:"
cmd "python agent.py --config config.json"
echo
say "Step 3: Watch the agent terminal — it should detect the tamper:"
say "  1. check_tamper() detects missing lock sentinel"
say "  2. Device is in 'stolen'/'locked' state"
say "  3. Agent re-asserts lockdown (re-encrypt, re-lock screen)"
say "  4. Logs 'Tamper detected: ...' message"
echo
say "Step 4: Verify the lock sentinel was recreated:"
cmd 'dir C:\ProgramData\lockdown-agent\.locked'
note "Should exist again — the agent recreated it during re-lock."
echo
ok "E-TAMPER: Tamper protection re-lock verified"
echo

say "── Part C: TPM sealing (if available) ──"
echo
say "Check if the HP machine has TPM 2.0:"
cmd "# On the HP machine (PowerShell):"
cmd "Get-Tpm | Select-Object TpmPresent,TpmReady,TpmEnabled"
echo
say "If TPM is present and ready, the agent should use TPM sealing for"
say "the deadman state. Check the agent log for TPM messages:"
cmd 'Select-String -Path agent.log -Pattern "TPM|tpm_seal|sealed" | Select -Last 10'
echo
note "If TPM is not available, the agent falls back to DPAPI (LDS1 magic)."
note "This is expected behavior — not a failure."
echo
say "Verify which sealing method was used:"
cmd 'Select-String -Path agent.log -Pattern "sealing|sealed|deadman" | Select -Last 5'
echo
ok "E-TPM: TPM sealing verified (or DPAPI fallback confirmed)"
echo
pause "Press Enter when hidden trigger + tamper tests are complete"

# ── Phase 8: Collect artifacts + cleanup ───────────────────────────────────
phase 8 "Collect artifacts + cleanup"

say "Copy all test artifacts back to the dev machine:"
echo
cmd "# On the dev machine (WSL2):"
cmd "scp <username>@<HP-IP>:C:/Users/<username>/lockdown-agent/hw_test_artifact_hp.json ${AGENT_DIR}/"
cmd "scp <username>@<HP-IP>:C:/Users/<username>/lockdown-agent/agent.log ${AGENT_DIR}/hw_test_agent_log_hp.txt"
echo
say "Stop the agent on the HP machine (Ctrl+C in the agent terminal)."
echo
say "If you installed the agent as a service, uninstall it:"
cmd "# On the HP machine (Admin PowerShell):"
cmd "sc stop LockdownAgent"
cmd "sc delete LockdownAgent"
echo
say "Clean up the test files (optional — keep if you want to re-test):"
cmd 'del C:\lockdown-test\*'
cmd 'rmdir C:\lockdown-test'
cmd 'Remove-Item C:\ProgramData\lockdown-agent -Recurse -Force'
echo

# ── Summary ────────────────────────────────────────────────────────────────
_clear
printf '\n%s%s  Hardware Test Complete%s\n' "$BOLD" "$GREEN" "$RESET"
printf '\n'
printf '  %sArtifacts to collect:%s\n' "$BOLD" "$RESET"
printf '    1. agent/hw_test_artifact_hp.json — harness test results\n'
printf '    2. agent/hw_test_agent_log_hp.txt — full agent cycle log\n'
printf '\n'
printf '  %sEnforcement paths verified:%s\n' "$BOLD" "$RESET"
printf '    E-ENCRYPT       — file encryption/decryption (Fernet)\n'
printf '    E-LOCK-SCREEN   — LockWorkStation\n'
printf '    E-GUARDIAN      — lock guardian thread\n'
printf '    E-ACK           — command ACK to server\n'
printf '    E-RECOVERY      — unlock + key release + decrypt\n'
printf '\n'
printf '  %sNew features verified:%s\n' "$BOLD" "$RESET"
printf '    E-ENROLL-TOKEN  — token-based enrollment (no admin password)\n'
printf '    E-DURESS        — duress code fake unlock + re-lock\n'
printf '    E-HIDDEN-TRIGGER — .system_cache_cleanup hidden trigger\n'
printf '    E-TAMPER        — tamper detection + re-lock\n'
printf '    E-TPM           — TPM 2.0 state sealing (or DPAPI fallback)\n'
printf '\n'
printf '  %sSkipped (user opted out):%s\n' "$DIM" "$RESET"
printf '    E-BCD           — BCD lockdown (skipped)\n'
printf '    E-HP-UEFI       — HP UEFI/BIOS lockdown (skipped)\n'
printf '\n'
printf '  %sNext steps:%s\n' "$BOLD" "$RESET"
printf '    1. Send the artifacts back to the dev machine\n'
printf '    2. Tell Devin the results — I will update the graph spec\n'
printf '       enforcement path statuses from verified-in-unit-test to\n'
printf '       verified-on-hardware\n'
printf '    3. If any test failed, share the agent.log and I will debug\n'
printf '\n'
printf '  %sWorker URL:%s %s\n' "$BOLD" "$RESET" "$WORKER_URL"
printf '\n'
