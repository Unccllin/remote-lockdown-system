# NG-R2: Authenticated-variable options for PBL's shell-writable variables

> **Label:** `wayfinder:research` (AFK)
> **Status:** CLOSED (2026-09-18)
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

**RESOLVED 2026-09-18** — `docs/research/NOTE-PBL-VAR-AUTH.md`

Per-variable verdicts:

| Variable | Auth-feasible? | Verdict |
|---|---|---|
| `PblMarkerTest` | Yes (private TBA) | Diagnostic-only — keep unauthenticated, advisory; if a "PBL ran" canary is needed use a PCR-13 extend, not a var |
| `PblBootmgrSvn` | Conditionally | Preferred: stop trusting the var — parse SVN from `bootmgfw.efi`'s Authenticode cert table + SVN floor in signed `policy.cose` |
| `MemoryOverwriteRequestControl` | **No** | Spec-defined unauthenticated; TBA write breaks OS use. Correct hardening = spec's `MemoryOverwriteRequestControlLock` (0x01 = locked till reboot) |

Key findings:
- Counter-based `AUTHENTICATED_WRITE_ACCESS` is **dead** (deprecated + `EFI_UNSUPPORTED`); only TIME_BASED viable.
- Private TBA vars need **no** PK/KEK/db enrollment — first self-signed write binds `certdb`.
- Signing key can't live in PblApp.efi (ESP is shell-readable) — offline-signed AUTH2 payloads in signed `policy.cose` is the pattern; `Pkcs7Sign` is RSA-only in this edk2.
- Deletion caveat: unsigned delete allowed when `UserPhysicalPresent()` — TBA is spoof-resistance, not guaranteed existence.

**Critical side-finding (latent bug):** `Mor.c`/`PlatformState.c` use
`EFI_GLOBAL_VARIABLE` for `MemoryOverwriteRequestControl`, but the spec
GUID is `gEfiMemoryOverwriteControlDataGuid`
(`e20939be-32d4-41be-a150-897f85d49829`). PBL's MOR write is a **no-op
decoy** — the firmware's real TcgMor reads a different variable. Also the
"bit 1 = lock" comment is wrong; lock is a separate variable.

Graduated: **NG-T4 variable-hardening fix ticket** (MOR GUID bug is a
prerequisite functional fix inside it).
