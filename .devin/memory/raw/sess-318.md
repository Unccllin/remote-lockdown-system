# Session Capture — 2026-11-20 — sess-318

## Context
- Task: Resume S342: fix the brain.py store race left open by S341, with tests
- Environment: repo remote-lockdown-system, branch master, python 3.14.8, scripts/brain.py store
- Duration: <not specified>

## Decisions Made
- lock applied by a @mutating decorator over the 4 mutating commands, not four with-blocks, so a future command cannot forget it
- tests drive the real CLI against a copy of brain.py in a temp repo root (its paths derive from __file__), so no production change was needed to make it testable
- hand-rolled check() runner instead of pytest: the analysis interpreter has no pytest, and this suite needs only subprocesses

## Actions Taken
- added store_lock() (flock/msvcrt) + mutating decorator to scripts/brain.py
- wrote scripts/test_brain.py (7 tests, 16 checks), proved it fails 5/5 with the decorators removed
- corrected a test that asserted a refusal argparse makes unreachable; now pins lock-release-on-error instead
- chmod +x on the new suite so its shebang stops being a finding

## Outcomes
- What worked: - measuring the defect at N=12 writers: it loses a third to a half of writes, which is why one observed lost belief was not a fluke
- reading every save_store call site first, so the decorator covered refute (which allocates an id AND mutates a second record)
- What failed: - first teeth experiment was void: the patch script asserted the wrong count and aborted before writing, so the three no-lock rounds actually ran WITH the lock
- What was unexpected: - 12 concurrent writers kept only 6-8 of 12 beliefs, far worse than the single lost belief S341 saw
- cmd_confirm/cmd_refute's own missing-argument [ERROR] branches are unreachable: argparse requires those flags

## Learnings
- atomic_write (tmp+rename) prevents a torn file but never a lost update; read-modify-write needs a lock, and max-id allocation makes every writer collide
- brain.py resolves its store from __file__, so a copied script in a temp tree is a complete test fixture with zero production changes
- a test file with a shebang that is not executable is a standing EXE001 finding; chmod +x is the clean fix for a new file

## Mistakes / Corrections
- mistake: wrote the artifact's 'what the lost updates looked like' section from an earlier experiment's numbers rather than the run printed above; correction: corrected the section to state only the measured range

## Open Questions
- <none recorded>

## File References
- scripts/brain.py
- scripts/test_brain.py
- docs/artifacts/s342-brain-store-lock.txt
- AGENTS.md

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
