# harness-template — a scaffold, not the engine

**This directory is a template for standing up the node-graph harness in another repository. Nothing in
this repository runs it.** No Makefile target, CI workflow, script or document references it — verify with
`grep -rn harness-template --include='*' . | grep -v '^./harness-template/'`.

**Do not read these files as the current implementation.** They were forked from `.devin/graph/` and have
drifted a long way:

| file | here | live (`.devin/graph/`) |
|---|---|---|
| `graph_assert.py` | 640 lines | 1314 lines |
| `graph_loader.py` | 197 lines | 192 lines |
| `GRAPH-SPEC.yaml` | 396 lines | 1595 lines |

Concretely, the copy predates every check added since S326, including the two that compare a session
block against the debt ledgers (`assert_open_debt_list_matches_ledger`,
`assert_claimed_closures_are_real`) and the S328 lint fixes. A copied invariant engine that is missing
invariants is the worst kind of stale file, because it reads as authoritative.

Two honest options, neither taken unilaterally:

1. **Delete it.** Nothing references it and the live engine is the only one maintained. If no other repo
   has adopted this scaffold, the copy is pure drift.
2. **Keep it as a scaffold and re-sync it** from `.devin/graph/` when it is actually used to bootstrap a
   project — at which point this table should be deleted, because a template that tracks its source needs
   no disclaimer.
