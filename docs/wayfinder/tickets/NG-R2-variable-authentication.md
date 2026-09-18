# NG-R2: Authenticated-variable options for PBL's shell-writable variables

> **Label:** `wayfinder:research` (AFK)
> **Status:** OPEN
> **Blocks:** variable-hardening fix ticket (fog — finding F2)
> **Blocked by:** none

## Question

F2 (synthesis): `PblMarkerTest`, `PblBootmgrSvn`, `MemoryOverwriteRequestControl`
are written via plain `gRT->SetVariable` — spoofable/erasable by any
reachable UEFI shell (`setvar`/`dmpstore -d`). Before the fix ticket
exists, we need to know which hardening options are actually viable per
variable.

Research: for each variable —
1. Can it carry `EFI_VARIABLE_AUTHENTICATED_WRITE_ACCESS` or
   `TIME_BASED_AUTHENTICATED_WRITE_ACCESS`? What are the key-enrollment
   prerequisites (does it need PK/KEK, a custom cert in `db`, or can
   PBL self-sign with an embedded key)?
2. MOR specifically is a **spec-defined** variable — Windows writes/
   expects it unauthenticated; can it be authenticated without breaking
   the OS's use of it, or must it stay advisory?
3. Alternatives where authentication is impossible: TPM-sealed state,
   PCR-extended evidence (can't be unextended), digest-covered reads
   treated as advisory-only, or moving state into the signed ESP blob.

## Research question for the subagent

Check the local edk2 tree (`/home/cllin/.local/src/edk2`) +
`STUDY-UEFI-SPEC-2.10.md` + `STUDY-EDK2.md` for authenticated-variable
write rules, `AuthVarLib` usage patterns, key-format requirements (PKCS7 /
X509), and whether an application-created authenticated variable needs a
custom GUID namespace. Cross-check the three PBL variables' actual
semantics in `MarkerTest.c`, `Svn.c`, `Mor.c`.

Deliverable: a per-variable table (var → auth-feasible? → recommended
hardening → code changes needed) written as `docs/research/NOTE-PBL-VAR-AUTH.md`.

## Resolution

The per-variable table becomes the fix ticket's implementation spec;
graduates the variable-hardening ticket from fog.
