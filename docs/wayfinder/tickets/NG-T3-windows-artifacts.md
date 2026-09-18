# NG-T3: Generate Windows artifacts — BitLocker image + BCD exports + UEFI dumps

> **Label:** `wayfinder:task` (HITL)
> **Status:** OPEN
> **Blocks:** D-120 real-media validation, partition-level FVE binding
> (fog), disk boot-structure baseline testing, shell-detection tuning
> **Blocked by:** none — needs a Windows machine / VM with TPM

## Question

The three artifact classes in `FETCH-LIST.md` §Tier-3 that only a real
Windows/UEFI environment can produce. Resolves when the artifacts exist in
`docs/reference/artifacts/` (or the user rules them unobtainable).

## Work (for the human)

1. **BCD exports** (any Windows box, ~5 min):
   `bcdedit /export C:\bcd-export` + `bcdedit /enum all /v > bcd-enum.txt`
   → `docs/reference/artifacts/bcd/` — from 2 machines if possible.
2. **BitLocker test image** (highest value — Win11 VM with vTPM, BitLocker
   on OS volume): export VHD/VMDK, or `manage-bde -status` +
   `-protectors -get C:` output + 1MB sector dump of the encrypted volume
   → `docs/reference/artifacts/fve/`.
3. **UEFI dumps** (target hardware, UEFI shell): `dmpstore -all -sfo
   vars.txt`, `bcfg boot dump -v > boot.txt`, `map -r > map.txt` →
   `docs/reference/artifacts/uefi-dumps/<model>/`.

## Resolution

Record what landed. Graduates: D-120 real-media validation (fog),
partition-binding (with NG-R1), shell/Boot####-detection tuning.
