---
name: verify-environment
description: Environment verification runbook. Use when verifying the build, running checks, or adding new verification steps.
---

# Skill: Environment Verification

## When to use this skill

- **After making changes** — run `make verify-env` to confirm nothing broke.
- **Before commits** — run `make full-verify` for a complete sweep.
- **In CI** — the `env-verify` job runs `verify-environment.sh --json`.
- **When adding a new verification check** — follow the pattern in
  `scripts/verify-environment.sh`.
- **When debugging a build or packaging issue** — run individual sections
  with `--agent`, `--nsis`, `--docker`, `--signing`, `--electron`,
  `--installers`, or `--secrets`.

## Overview

The environment verification system tests production-readiness items that
were previously "cannot verify in WSL" — PyInstaller builds, NSIS installer
compilation, platform installer syntax, code signing, Docker validation,
and Electron packaging. Each check degrades gracefully: if a tool is
missing, it reports SKIP rather than FAIL.

The main script is `scripts/verify-environment.sh` (~864 lines). It is
wrapped by Makefile targets and wired into CI.

## make verify-env — 61 checks across 7 sections

```bash
make verify-env
```

Runs `scripts/verify-environment.sh` with all sections enabled. Current
result: **61 PASS / 0 FAIL / 1 SKIP** (the 1 skip is the intentional
`installer-windows-execpolicy` by-design skip).

### Section 1: Agent PyInstaller Build
- `agent-build-pyinstaller` — builds all 3 binaries via `agent/build.sh --install`
- `agent-binary-lockdown-agent` — verifies ELF/executable file type
- `agent-binary-lockdown-watchdog` — verifies ELF/executable file type
- `agent-binary-lockdown-recovery` — verifies ELF/executable file type
- `agent-smoke-*` — `--version` or `--help` smoke test per binary

### Section 2: Docker Secrets Preflight
- `secrets-script-exists` — `scripts/generate-secrets.sh` found
- `secrets-directory` — `secrets/` has >= 4 secret files
- `secrets-script-syntax` — `bash -n` on generate-secrets.sh
- `secrets-dry-run` — dry-run generates valid secret names
- `secrets-gitignored` — `secrets/` in `.gitignore`

### Section 3: NSIS Installer Compilation + PE Validation
- `nsis-available` — makensis installed (PATH or `~/.local/nsis/`)
- `nsis-version` — version query succeeds
- `nsis-compile` — compiles a test installer via server's installer module; validates MZ header, PE signature, and embedded base64 config
- `nsis-pe-filetype` — `file` command confirms PE32/MS-DOS executable
- `nsis-certutil-decode` — certutil base64 decode on Windows (via WSL interop)

### Section 4: Platform Installer Script Syntax
- `installer-syntax-linux-install.sh` — `bash -n`
- `installer-syntax-linux-uninstall.sh` — `bash -n`
- `installer-syntax-macos-install.sh` — `bash -n`
- `installer-syntax-macos-uninstall.sh` — `bash -n`
- `installer-exec-*` — executable bit set
- `installer-windows-exists` — `install-service-enhanced.ps1` found
- `installer-windows-service` — creates Windows service (New-Service/sc.exe/nssm)
- `installer-windows-start` — starts service after install
- `installer-windows-encoding` — ASCII-only or UTF-8 with BOM (PowerShell 5.1 safe)
- `installer-windows-ps-syntax` — PowerShell parser via WSL interop (0 errors)
- `installer-windows-execpolicy` — **SKIP by design** (script uses `-ExecutionPolicy Bypass` at call site)
- `installer-systemd-unit` — `lockdown-agent.service` exists
- `installer-systemd-structure` — has [Unit], [Service], [Install]
- `installer-systemd-execstart` — has ExecStart
- `installer-macos-plist` — `com.lockdown.agent.plist` exists
- `installer-macos-plist-structure` — has Label + ProgramArguments

### Section 5: Code Signing Dry-Run
- `signing-script-setup-signing.sh` — exists + `bash -n`
- `signing-script-verify-signing.sh` — exists + `bash -n`
- `signing-verify-linux-skip` — gracefully skips on Linux
- `signing-ci-config` — signing env vars in `release.yml`
- `signing-docs` — `docs/CODE_SIGNING.md` exists
- `signing-self-signed-cert` — openssl generates test cert
- `signing-cert-valid` — cert is valid X.509

### Section 6: Docker Validation
- `docker-script` — `validate-docker.sh` exists + syntax OK
- `docker-config-validation` — non-live config validation passes
- `docker-daemon` — Docker daemon available (SKIP if not)
- `docker-live` — live validation (requires `.env.prod` + daemon)
- `docker-compose-*.yml` — each compose file exists
- `docker-dockerfile` — `Dockerfile.server` exists

### Section 7: Electron Packaging
- `electron-dir` — `electron/` directory exists
- `electron-package-json` — `package.json` found
- `electron-builder-config` — build config in package.json
- `electron-nsis-target` — NSIS target configured
- `electron-agent-bundle` — agent binaries in extraResources
- `electron-deps` — node_modules installed
- `electron-build-config-valid` — build config parses correctly
- `electron-agent-binaries` — agent binaries built and available

## The 1 known skip (by design)

- **`installer-windows-execpolicy`** — The PS1 script intentionally does
  NOT set `ExecutionPolicy` internally. The caller invokes it with
  `-ExecutionPolicy Bypass`. Hardcoding `Set-ExecutionPolicy` inside an
  installer is bad practice. The script's PowerShell syntax is validated
  separately (`installer-windows-ps-syntax`) and passes. This SKIP is
  expected and is NOT a failure.

## make full-verify — everything in order

```bash
make full-verify
```

Runs the complete verification sweep, stopping on first failure:
1. `graph-check` — graph invariant sweep (I1-I7), fastest gate
2. `lint` — eslint (server + dashboard) + ruff (agent)
3. `test` — all test suites (server Jest + agent pytest + dashboard Vitest)
4. `test-e2e` — API-level E2E tests (lockdown + recovery + agent-integration)
5. `verify-env` — environment verification (61 checks)
6. `check-artifacts` — build outputs exist and are non-empty

On success, prints "FULL VERIFICATION PASSED".

## make check-structure — structural checks

```bash
make check-structure
```

Runs `scripts/check-artifacts.sh --check-structure`. Non-fatal —
`electron/dist-electron` is expected to be missing locally (it requires
a full electron-builder run). Use this to check which build outputs exist
without failing the pipeline.

## Running individual sections

```bash
# Only agent PyInstaller build
scripts/verify-environment.sh --agent

# Only NSIS installer
scripts/verify-environment.sh --nsis

# Only Docker checks
scripts/verify-environment.sh --docker

# Only signing checks
scripts/verify-environment.sh --signing

# Only Electron packaging
scripts/verify-environment.sh --electron

# Only platform installer syntax
scripts/verify-environment.sh --installers

# Only secrets preflight
scripts/verify-environment.sh --secrets

# JSON output (for CI parsing)
scripts/verify-environment.sh --json
```

## Exit codes

- **0** — all checks passed (or skipped due to missing tools)
- **1** — one or more checks failed

## CI gates

The CI pipeline (`.github/workflows/ci.yml`) has 11 jobs. All depend on
`graph-check` (runs first — if graph invariants are violated, all
downstream jobs are skipped):

| CI Job | What it runs | Gate |
|--------|-------------|------|
| `graph-check` | `python3 .devin/graph/graph_assert.py` | All 7 invariants (I1-I7) |
| `server-tests` | `cd server && npm test` + `npm audit --audit-level=high` | 368 Jest tests pass, no high/critical vulns |
| `dashboard-tests` | `cd dashboard && npm test` + audit with exceptions | 84 Vitest tests pass |
| `agent-tests` | `cd agent && pytest tests/ -v` + `pip-audit` | 463+ pytest tests pass, no known vulns |
| `api-e2e` | `scripts/run-e2e.sh --agent-integration --verbose` | Lockdown + recovery + agent-integration E2E |
| `dashboard-e2e` | `cd dashboard && npx playwright test` | Playwright browser E2E (Chromium) |
| `electron-tests` | `cd electron && npm test` | 30 Jest tests pass |
| `serverless-tests` | `cd serverless && npm test` | 54 Vitest tests pass |
| `script-tests` | `python3 scripts/test_graph_session.py` + `test_memory.py` | Graph session + memory tooling tests |
| `hw-harness-dry-run` | `python3 hw_test_harness.py --mode dry-run` + `--mode check` | Harness structure + eligibility logic |
| `env-verify` | `scripts/verify-environment.sh --json` | 61 environment checks (with NSIS installed) |

All CI jobs run on `ubuntu-latest` with Python 3.12 and Node 20.

## How to add a new verification check

1. **Add a check function** in `scripts/verify-environment.sh` following
   the existing pattern:
   ```bash
   check_my_section() {
     printf "\n${CYAN}=== N. My Section ===${NC}\n"

     # Check if tool/file exists
     if [[ ! -f "$PROJECT_ROOT/path/to/file" ]]; then
       record_fail "my-check-name" "file not found"
       return
     fi

     # Run the check
     if some_command "$PROJECT_ROOT/path/to/file" 2>/dev/null; then
       record_pass "my-check-name" "check passed"
     else
       record_fail "my-check-name" "check failed"
     fi
   }
   ```

2. **Use the three record helpers**:
   - `record_pass "name" "detail"` — check passed
   - `record_fail "name" "detail"` — check failed (causes exit 1)
   - `record_skip "name" "detail"` — check skipped (tool missing, not a failure)

3. **Wire it into the run sequence** at the bottom of the script:
   ```bash
   [[ $RUN_MY_SECTION -eq 1 ]] && check_my_section
   ```

4. **Add argument parsing** for `--my-section` if you want to run it
   independently:
   ```bash
   case "$1" in
     --my-section) RUN_MY_SECTION=1; ALL=0; shift ;;
   esac
   ```

5. **Add to the ALL=1 block** if it should run by default:
   ```bash
   if [[ $ALL -eq 1 ]]; then
     RUN_MY_SECTION=1
   fi
   ```

6. **Update the help text** at the top of the script.

7. **Update AGENTS.md** — change the check count in the Diagnostic Sweep
   Results section (e.g., "61 PASS" -> "62 PASS").

8. **Do NOT duplicate build logic in the Makefile** — the Makefile wraps
   `scripts/verify-environment.sh`. All logic lives in the script.

## Environment notes

- Node.js lives at `~/.local/node/bin` (NOT on default PATH). The script
  uses `[[ -f "$HOME/.local/node/bin/node" ]]` as a fallback.
- Python 3.14 is the interpreter (`python3`).
- Docker is installed but may need `sudo chmod 666 /var/run/docker.sock`
  for socket access in the current session.
- PS1 files are PowerShell, not bash — do not `bash -n` them. The script
  uses WSL interop (`/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe`)
  for PowerShell syntax validation.
- Caddyfile and `Dockerfile.server` are NOT YAML — do not YAML-validate them.

## Key files

| File | Purpose |
|------|---------|
| `scripts/verify-environment.sh` | Main verification script (~864 lines, 61 checks) |
| `scripts/check-artifacts.sh` | Artifact verification (wrapped by `make check-artifacts`) |
| `scripts/validate-docker.sh` | Docker config + live validation |
| `scripts/setup-signing.sh` | Code signing setup script |
| `scripts/verify-signing.sh` | Code signing verification script |
| `scripts/generate-secrets.sh` | Secrets generation script |
| `Makefile` | `verify-env`, `full-verify`, `check-structure` targets |
| `.github/workflows/ci.yml` | CI pipeline with 11 jobs |
| `AGENTS.md` | Verification commands section + diagnostic sweep results |
