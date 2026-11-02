# Session Capture — 2026-11-02 — sess-171

## Context
- Task: Mutation-audit the 10 verified-in-unit-test enforcement paths: reintroduce one semantic defect each and see whether the suite fails
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
- Built scripts/audit_test_teeth.py: one semantic mutation per enforcement path, run against the WHOLE agent suite, verdict keyed on pytest's exit code (0 passed / 1 failed / 4 usage / 5 none collected), not on output text.
- Result: 10/10 mutations killed after adding two missing tests. Two paths were unearned before: E-OFFLINE-QUEUE (no test referenced queue_offline/_queue_size/OFFLINE_QUEUE_DB at all - the whole suite stayed green with queue_offline as a no-op) and E-TRACK (every test patched scan_wifi_networks out, so the netsh/nmcli parsers were never executed).
- E-EFFECTIVENESS and E-RECOVERY first looked like survivors but were MY mapping errors: the aggregator lives in agent.py (covered by test_agent_ack_recovery/_encryption) and E-RECOVERY is covered by test_agent_config.py:94 test_handle_unlock_decrypts_and_removes_sentinel. Running the whole suite per mutation removed the error class.
- scripts/run-agent-tests.sh does 'cd agent' and always passes tests/, so repo-relative paths never resolve and pytest exits non-zero for a COLLECTION error - identical to a failing test. A harness must verify the test ran, not just that the command failed.
- With -x, pytest prints 'stopping after 1 failures' and no 'N failed' summary, so summary-text matching misreads a genuine kill as invalid; the exit code is the reliable signal.

## Mistakes / Corrections
- mistake: my audit tool's first run printed 'all 10 mutations killed' while every line was 'ERROR: file or directory not found' - zero tests ran. Caught only by reading the output text rather than trusting the summary.
- mistake: the second version used summary-text matching and marked a real kill as INVALID.
- mistake: mapped one suite per enforcement path, which produced two false 'survivor' findings I nearly wrote into the ledger as gaps.

## Open Questions
- <none recorded>

## File References
- scripts/audit_test_teeth.py
- agent/tests/test_offline_queue.py
- agent/tests/test_wifi_parsing.py
- .devin/graph/GRAPH-SPEC.yaml

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
