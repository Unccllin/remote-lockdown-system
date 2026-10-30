# Session Capture — 2026-10-28 — sess-151

## Context
- Task: Take PBL CI: make its failures name their own cause, and give the three firmware TODOs their contract references
- Environment: <not specified>
- Duration: <not specified>

## Decisions Made
- <none recorded>

## Actions Taken
- <none recorded>

## Outcomes
- What worked: <not recorded>
- What failed: <not recorded>
- What was unexpected: <not recorded>

## Learnings
- PBL CI was red on every run because 'libuuid-dev' does not exist on Ubuntu 22.04 (the package is uuid-dev). Reproduced in 16s in a bare ubuntu:22.04 container; both build jobs named it, so it was never transient.
- A 'works locally, fails in CI' apt failure is answerable in seconds with 'docker run --rm ubuntu:22.04 bash -c <the exact job command>' - do that before theorising.
- The three PblApp TODOs were contract-sanctioned deferrals, not missing work: C1 §1.1 names Ed25519 preferred with ES256 as the explicit fallback, so BaseCryptLib having only Ed448 puts the firmware in the fallback term and EFI_UNSUPPORTED is correct per C1 §7.
- Moving a gate out of YAML into scripts/ is what makes it testable and reproducible; the old inline grep accepted any line containing the substring C1 (a hex literal passed), never accepted C5, and only globbed PblApp/*.c.
- Job ordering is a correctness property: the contract-reference gate sat after an apt step, so when apt failed the gate's verdict was never reported at all.
- PBL never populates PBL_PLATFORM_STATE.DeviceId and PblTpmReadAkName has no caller, so every verdict request carries a zero device_id that the server echoes back - the check compares zeros to zeros and passes silently. Filed as D-131.

## Mistakes / Corrections
- Wrote 'SUDO=""' then 'run "$SUDO" apt ...', which passes an empty first argument and executes "" (status 127). Use an array: SUDO=() / SUDO=(sudo) and "${SUDO[@]}".
- Captured '$?' after a failed 'if' compound with no 'else': the exit status of such an if is 0, so the retry helper reported success on a failed apt install. Capture $? in the else branch.
- Both of those bugs only appeared when the script ran for real in a container; reading it back suggested it was fine.
- Left 'scripts/test_ci_annotate.py' (added last session) without a __main__ block, so make test-scripts ran zero of its 13 tests and exited 0 - the same bug AGENTS.md records for test_memory.py. Conventions in prose recur; enforce them with a test.

## Open Questions
- <none recorded>

## File References
- .github/workflows/pbl-ci.yml
- scripts/apt-install-retry.sh
- scripts/check-firmware-todos.py
- scripts/script_test_runner.py
- scripts/test_check_firmware_todos.py
- scripts/ci-annotate.py
- firmware/PblPkg/PblApp/CoseVerify.c
- firmware/PblPkg/PblApp/TlsVerify.c
- firmware/PblPkg/PblApp/TpmClient.c
- docs/adr/PBL-DEBT-LEDGER.md
- Makefile
- AGENTS.md

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
