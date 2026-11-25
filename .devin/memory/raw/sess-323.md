# Session Capture — 2026-11-24 — sess-323

## Context
- Task: Produce the product handover package (everything except the codebase) and price it in local currency
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
- The non-code half is 20 key domains (7 critical), 9 accounts, 3 assets, 9 obligations, 5 acceptances. K-UPDATE-SIGN must transfer even if the database does not, because deployed agents pin its public key.
- A handover gate must parse the env examples, not trust a hand-written list: a new secret-shaped variable with no custody entry is exactly the failure a doc cannot catch.
- Local pricing (Kenya) moves only three lines materially: host (Angani KES 2,000-2,500/mo vs Hetzner KES ~2,630), pen test (KES 175k-300k local vs KES 644k at the US median), and day rate (KES 15k-35k vs KES 113k-170k). SOC 2 stays USD-priced everywhere.
- VAT 16% applies to imported digital services in Kenya, so a USD SaaS invoice carries a local tax cost; quote VAT-inclusive vs exclusive explicitly.

## Mistakes / Corrections
- mistake: the first gate version required every key to declare an env var and treated .github/workflows/* as a literal path, failing four checks on my own registry; correction: derive required fields from the domain, and make the self-test assert the REAL registry passes, not only that mutations fail
- mistake: Exa returned 429 and provider=brave needs an API key, so several price lookups failed; correction: fetch vendor pages directly and mark unmeasured cells [E] 'not measured' instead of dropping rows

## Open Questions
- <none recorded>

## File References
- docs/HANDOVER.md
- docs/handover-registry.json
- scripts/check_handover.py
- docs/artifacts/s347-handover-inventory-check.txt

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
