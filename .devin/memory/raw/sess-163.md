# Session Capture — 2026-10-30 — sess-163

## Context
- Task: Try to build an enrolled varstore offline so D-133's positive test and D-130's Step 6 can run
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
- virt-fw-vars: --add-db GUID cert.pem works fine; --set-dbx FILE requires an EFI_VARIABLE_AUTHENTICATION_2 blob (timestamp + PKCS#7 + ESL), because vars.py:279-280 assigns the file to authdata. A bare ESL gets parsed as an auth header and crashes on EFI_TIME with garbage years.
- Two different garbage years from the same input shape (22945 for an X509 ESL, 42130 for an X509_SHA256 one) is the signature of a misread header rather than a corrupt file — that diagnostic generalises.
- Writing dbx unsigned is only legal in SetupMode, but virt-fw-vars always routes it through the authenticated writer, so starting from the empty varstore does not help.
- The Microsoft Corporation UEFI CA 2011 cert extracted from OVMF_VARS_4M.ms.fd hashes to 48e99b991f57fc52f76149599bff0a58c47154229b9f8d603ac40d3500248507, matching the fingerprint compiled into firmware — an independent cross-check.
- Remaining route: an EFI helper that SetVariable's dbx from inside the guest in SetupMode, then enrols PK.

## Mistakes / Corrections
- Plannned 'try virt-fw-vars against the empty varstore' without reading what its write options require; ten minutes in vars.py would have replaced three runs.
- Nearly recorded 'the tool is broken' from two identical-looking failures instead of noticing that the failure value tracked the input.

## Open Questions
- <none recorded>

## File References
- docs/adr/PBL-DEBT-LEDGER.md

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
