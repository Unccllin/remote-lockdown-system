# NG-T2: Fetch Tier-1/2 sources from FETCH-LIST.md

> **Label:** `wayfinder:task` (HITL)
> **Status:** OPEN
> **Blocks:** HeciClient design (fog), UEFI Shell re-mine, partition-binding
> (partial), D-127 (Sure Admin)
> **Blocked by:** none — human action required (browser access)

## Question

`docs/reference/FETCH-LIST.md` lists everything the agent cannot reach.
This ticket resolves when the Tier-1 and Tier-2 items are downloaded into
the repo (or ruled unobtainable) and the checklist table is marked.

## Work (for the human)

Tier 1 (~30 min, pure downloads):
- UEFI spec, PI spec, **UEFI Shell spec** → `docs/reference/specs/`
- TCG PC Client Firmware Profile, TPM 2.0 Library Parts 3–4 →
  `docs/reference/specs/`
- VU#718077 advisory → `docs/reference/vendor-docs/`
- "Harnessing the UEFI Shell" 2e — check degruyterbrill.com for legal
  free download first → `docs/reference/books/`

Tier 2:
- Intel AMT Implementation & Reference Guide (the `HeciClient.c`
  prerequisite) → `docs/reference/vendor-docs/`
- Intel TXT MLE guide, PTT white paper, Intel AT briefs → same dir
- HP Sure Admin + BIOS WMI docs, one BIOS softpaq →
  `docs/reference/vendor-docs/` / `docs/reference/artifacts/firmware/`
- MS Learn: BCD WMI provider, BitLocker CSP, SGRA →
  `docs/reference/vendor-docs/`

Mark each landed item in `FETCH-LIST.md`'s checklist table.

## Resolution

Record which items landed (paths) and which were unobtainable. Graduated
tickets: UEFI Shell re-mine (if the book lands), HeciClient design (if
AMT guide lands).
