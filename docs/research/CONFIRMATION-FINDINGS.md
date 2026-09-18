# Confirmation Pass — Findings Verified Against Code

Date: 2026-09-18. Method: each synthesis finding (SYNTHESIS-NEXT-GEN-DESIGN.md §2)
checked against source + EDK II spec headers. No claim below is asserted from
documentation alone — every row names the file/line evidence.

Evidence levels: `code-read` = verified by reading source;
`spec-checked` = verified against authoritative header/spec in tree;
`emulated` = verified in QEMU/swtpm harness; `hardware` = needs real hardware.

## Ratified findings

| # | Finding | Verdict | Evidence (file:line) | Level |
|---|---------|---------|----------------------|-------|
| F1 | Error return from BLOCK-intent Boot#### advances BDS to next boot option → live bypass | **CONFIRMED + FIXED (D-220)** | `PblApp.c:297` `PblBlockHalt()`; called at :417, :483, :850, :861, :878. Binary `44c44e64…` contains halt strings | emulated |
| F2 | PBL variables unauthenticated, shell-writable | **CONFIRMED** | `MarkerTest.c:31` SetVariable w/o `TIME_BASED_AUTHENTICATED`; `Svn.c:43` security decision reads unsigned `PblBootmgrSvn`; `Mor.c:66` same | code-read |
| F3 | Deadman trusts wall clock | **CONFIRMED** | `agent.py:2906` `elapsed=(time.time()-last_seen)/3600`; clock rollback → negative → never fires; no `now<last_seen` tamper check. File is TPM-sealed — but sealing protects the blob, not the clock | code-read |
| F4 | Update verifies channel-delivered SHA-256, not a signature | **CONFIRMED** | `agent.py:3028` sha256+URL from same `/api/agent/update` response; `:3077` compares binary to that channel hash; no detached sig / pinned key | code-read |
| F5 | Fast-boot may never connect NIC | **KILLED — mitigated** | `HttpsClient.c:171-184` ConnectController sweep on all handles before HTTP use, comment cites exactly this gap | code-read |
| F6 | S3 resume bypasses PBL entirely | **CONFIRMED (architectural)** | `Decision.c:248` checks S3 *capability* only; on a real resume PBL never runs; no resume-vs-cold-boot provenance in digest | code-read |
| F7 | Signed UEFI shell = signed bypass, undetected | **CONFIRMED** | `PlatformState.c` `PblCollectBootOrderState` flags only network subtypes (MAC/IP/URI); no shell filename check, no `BootNext` inspection | code-read |
| MOR | `MemoryOverwriteRequestControl` written under wrong GUID | **CONFIRMED — latent bug** | `Mor.c:18` uses `EFI_GLOBAL_VARIABLE`; spec GUID is `e20939be-32d4-41be-a150-897f85d49829` (`MdePkg/Include/Guid/MemoryOverwriteControl.h:19`). PBL's MOR write is a no-op decoy vs. the real `TcgMor` handler | spec-checked |

## Bonus defects surfaced during the pass

| # | Defect | Evidence | Severity |
|---|--------|----------|----------|
| B1 | MOR comment wrong: "Bit 1 = lock" — spec byte has only bit 0 (clear) + bit 4 (disable-autodetect); locking is a *separate* variable `MemoryOverwriteRequestControlLock` | `Mor.c:10` vs `MemoryOverwriteControl.h:35-41`, `TcgMorLock.c` | docs/logic |
| B2 | Hardcoded QEMU static IP `10.0.2.15` / `UseDefaultAddress=FALSE` — no DHCP; HTTPS path dead on real hardware as written | `HttpsClient.c:213-219` | D-129 blocker |
| B3 | `http://` accepted "temporarily for QEMU" (D-109) — plaintext fallback live in release build | `HttpsClient.c:132-136` | security |
| B4 | No `BootNext` inspection — attacker sets one-shot shell boot | `PlatformState.c` (absent) | F7-adjacent |
| B5 | `PblBootmgrSvn` is attacker-writable — SVN anti-rollback reads a var any OS/shell can plant | `Svn.c:43-49` | F2-subsumed |

## Verification-blind-spot pattern (meta-finding)

Two confirmed bugs (D-220 bypass, MOR GUID no-op) survived green harnesses.
Both harnesses checked *outputs* (serial lines) not *outcomes* (did Windows
boot? did TcgMor see the variable?). Rule for all future harnesses:
**assert the security outcome, not the log line.**

## Status of synthesis law-check

| Law | Holds in code? |
|-----|----------------|
| Indicators, not roots | Yes — but `Svn.c` violates it (trusts writable var) |
| Fail-secure is the product | Mostly — F1 violated it until D-220; F3 clock-rollback open |
| Agent can't beat admin | Architecture matches; F4 update trust is the weak point |
| Persistence cuts both ways | F7 unaddressed — no shell/Computrace detection |
| No timer without non-RTC anchor | F3 violated — deadman uses bare `time.time()` |
