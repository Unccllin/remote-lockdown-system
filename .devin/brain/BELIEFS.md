# BELIEFS.md — Generated View (do not edit; regenerate via `brain.py gen-view`)

Generated: 2026-09-18 09:50:49 — 23 beliefs

Evidence ladder: assumed < code-read < spec-checked < emulated < real-media < hardware

## agent/deadman

| ID | Status | Evidence | Statement |
|---|--------|----------|-----------|
| B-005 | confirmed | code-read | The deadman switch computes elapsed time from the wall clock — a clock rollback yields negative elapsed hours and the switch never triggers. |

## agent/update

| ID | Status | Evidence | Statement |
|---|--------|----------|-----------|
| B-006 | confirmed | code-read | Agent update verification trusts a channel-delivered SHA-256, not a detached signature — the server channel is the sole trust root; a compromised server serves both binary and matching hash. |

## architecture

| ID | Status | Evidence | Statement |
|---|--------|----------|-----------|
| B-020 | confirmed | code-read | Everything a UEFI application reads can be forged by earlier DXE/SMM code — the only trust anchors are TPM-sealed/measured state, server-side verdicts, and cross-layer disagreement. |
| B-021 | confirmed | code-read | A user-mode agent cannot defeat a kernel/admin adversary — it can only detect, delay, and re-assert; real anchors are TPM, PBL, and the server. |

## firmware/boot-flow

| ID | Status | Evidence | Statement |
|---|--------|----------|-----------|
| B-001 | confirmed | emulated | A non-success return from a BLOCK-intent Boot#### entry advances BDS to the next BootOrder entry — an error return is a bypass vector, not a halt. |
| B-002 | confirmed | emulated | PBL BLOCK-intent paths never return to BDS — PblBlockHalt() shows lock screen, requests MOR, resets via EfiResetShutdown, CpuDeadLoop fallback. |
| B-010 | confirmed | code-read | BootOrder is checked only for network-boot device-path subtypes — shell images in Boot####, BootNext overrides, and ESP shell binaries are not classified. |
| B-017 | confirmed | code-read | BootNext is never inspected — a one-shot shell or boot-manager override is invisible to PBL. |
| B-022 | confirmed | emulated | PBL chain-loads bootmgfw.efi only after SHA-256 hash match against policy BootMgrHash, and passes the hashed buffer to LoadImage — the loaded bytes are the hashed bytes (TOCTOU-safe). |

## firmware/mor

| ID | Status | Evidence | Statement |
|---|--------|----------|-----------|
| B-011 | refuted | spec-checked | MemoryOverwriteRequestControl lives under EFI_GLOBAL_VARIABLE. → see B-012 |
| B-012 | confirmed | spec-checked | MemoryOverwriteRequestControl lives under e20939be-32d4-41be-a150-897f85d49829 — Mor.c writes under EFI_GLOBAL_VARIABLE, so PBL's MOR write is a no-op decoy the real TcgMor handler never sees. |
| B-013 | refuted | spec-checked | Bit 1 of MemoryOverwriteRequestControl locks the MOR bit. → see B-014 |
| B-014 | confirmed | spec-checked | The MOR byte has only bit 0 (clear-memory) and bit 4 (disable-autodetect); locking is a separate variable, MemoryOverwriteRequestControlLock. |
| B-023 | proposed | assumed | PBL's MOR request actually reaches the platform TcgMor handler and causes a memory clear on BLOCK. |

## firmware/network

| ID | Status | Evidence | Statement |
|---|--------|----------|-----------|
| B-007 | refuted | code-read | Fast-boot firmware may never connect the NIC before PBL's HTTPS use. → see B-008 |
| B-008 | confirmed | code-read | PblHttpsPost sweeps ConnectController on all handles before HTTP use — the fast-boot NIC-connection gap is mitigated for already-dispatched drivers. |
| B-015 | confirmed | code-read | PblHttpsPost hardcodes QEMU static IP 10.0.2.15 with UseDefaultAddress=FALSE — no DHCP; the HTTPS path cannot work on real hardware as written. |
| B-016 | confirmed | code-read | PblHttpsPost accepts http:// URIs (marked temporary for QEMU, D-109) — plaintext fallback is live in the release build. |

## firmware/s3

| ID | Status | Evidence | Statement |
|---|--------|----------|-----------|
| B-009 | confirmed | code-read | On S3 resume PBL never runs — the platform-state digest has no resume-vs-cold-boot provenance; Decision.c checks S3 capability only. |

## firmware/variables

| ID | Status | Evidence | Statement |
|---|--------|----------|-----------|
| B-003 | confirmed | code-read | PBL variables PblMarkerTest and MemoryOverwriteRequestControl are written without authentication — any boot-time writer can spoof or erase them. |
| B-004 | confirmed | code-read | PblBootmgrSvn is attacker-writable — the SVN anti-rollback decision reads an unauthenticated variable any OS process or UEFI shell can plant. |

## meta/verification

| ID | Status | Evidence | Statement |
|---|--------|----------|-----------|
| B-018 | confirmed | code-read | Harnesses that check log output rather than security outcomes pass vulnerable code — the D-220 bypass and the MOR no-op both survived green harnesses. |

## threat-model

| ID | Status | Evidence | Statement |
|---|--------|----------|-----------|
| B-019 | confirmed | code-read | In-the-wild UEFI bootkits persist at three layers — SPI flash implants (LoJax, MosaicRegressor, MoonBounce, CosmicStrand), ESP-resident boot managers (BlackLotus, Bootkitty), and image-parser exploits (LogoFAIL). |
