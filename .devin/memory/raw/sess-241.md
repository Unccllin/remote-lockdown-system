# Session Capture — 2026-11-05 — sess-241

## Context
- Task: Session 241: resolve 'Update verification: SHA-256 only — unauthenticated' for the first device.
- Environment: FRANKENSTEIN 192.168.1.119 (Windows 11, agent as service, tamper protection active); server WSL at http://192.168.1.43:3001 with UPDATE_PUBLIC_KEY_PEM set; keys generated into gitignored agent/dist
- Duration: <not specified>

## Decisions Made
- Pin at the installed path, never the staging path, because the agent fails closed on a configured-but-unreadable key.
- Rebuild the agent rather than work around it when source and binary disagree about a mode.
- Clear the tamper DENY with takeown+grant for this legitimate upgrade, and record that the product needs a sanctioned upgrade path rather than doing it silently every time.

## Actions Taken
- Generated the Ed25519 update keypair, set UPDATE_PUBLIC_KEY_PEM, staged the .pub beside the installer, and confirmed generated configs bake the pin.
- Fixed run_headless to use install_update_public_key() (with a regression test), rebuilt and reinstalled the agent after finding it stale, and unlocked the tamper-protected files to complete the upgrade.
- Verified the device now reports update_verification 'signature'.

## Outcomes
- What worked: - Running the staged source on the device against the same config isolated 'stale binary' from 'bad config' in one command.
- icacls named the exact reason the copy failed, twice, including that removing DENY was not enough.
- What failed: - The staging-path bug was mine (S214) and would have been invisible until the first update was refused.
- What was unexpected: - Tamper protection blocks the installer's own reinstall; the security feature and the upgrade path collide.

## Learnings
- A pin must name a path that outlives the installer run.
- Security features that harden files need a sanctioned way to be updated.
- Pinning changes behaviour: unsigned updates are now refused, so the pipeline must sign.

## Mistakes / Corrections
- mistake: pinned the installer's staging path in run_headless; correction: call install_update_public_key() and assert the installed path in a test.

## Open Questions
- <none recorded>

## File References
- agent/installer_gui.py
- agent/tests/test_installer_gui.py
- server/.env
- agent/dist/update_signing.pub
- agent/dist/update_signing.key
- .devin/brain/beliefs.yaml

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
