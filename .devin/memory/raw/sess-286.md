# Session Capture — 2026-11-18 — sess-286

## Context
- Task: S283: run the lock -> recover acceptance on MOLE with PBA off and record what actually happened
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
- Data path passed on hardware: escrow-before-arm, EFS encrypt, decrypt from the server key, sentinel + recovery-key cleanup.
- Logon hold passed: lock holds the last CONSOLE user (Newark User), not labadmin, which is why SSH survived; unlock releases it before looking at the key.
- Boot lock failed on both layers and was reported honestly (boot_lock_status=partial, lockdown_effective=0): BCD rolled back on 'CRITICAL: WinRE disable failed', HP UEFI rolled back on 3/3 critical BIOS writes refused.
- Root cause of the BCD rollback is idempotency: reagentc /disable exits non-zero when WinRE is already disabled (MOLE reports 'Windows RE status: Disabled'), and apply_bcd_lockdown treats that as critical.
- MOLE's deployed lockdown-agent.exe (built 2026-11-17 10:41, sha256 bb32c3d2...) predates the S271-era BIOS-restore reporting fixes: it logged 'Restored 0 BIOS settings to pre-lockdown state' and still claimed the BIOS was restored.

## Mistakes / Corrections
- mistake: first assumed the deployed agent matched the tree; correction: agent_version reads 1.0.0 for both, so identify the build by strings/sha256, not by version.
- mistake: peeked at the exe for new strings with an ASCII scan, which PyInstaller-packed binaries defeat; correction: use the log lines the binary emits, which are unambiguous.

## Open Questions
- <none recorded>

## File References
- docs/artifacts/s283-lock-recover-acceptance.txt
- agent/bcd_lockdown.py
- agent/agent.py
- .devin/graph/trace.md
- .devin/brain/beliefs.yaml

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
