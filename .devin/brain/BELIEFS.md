# BELIEFS.md — Generated View (do not edit; regenerate via `brain.py gen-view`)

Generated: 2026-11-03 15:01:25 — 56 beliefs

Evidence ladder: assumed < code-read < spec-checked < emulated < real-media < hardware

## agent/deadman

| ID | Status | Evidence | Statement |
|---|--------|----------|-----------|
| B-005 | refuted | code-read | The deadman switch computes elapsed time from the wall clock — a clock rollback yields negative elapsed hours and the switch never triggers. → see B-030 |
| B-030 | confirmed | emulated | Deadman last_seen is server-anchored via checkin server_time; local clock rollback beyond 300s tolerance is detected and treated as stolen + expired (fail-secure); forward clock fires early — both directions hostile to an attacker. |

## agent/tpm

| ID | Status | Evidence | Statement |
|---|--------|----------|-----------|
| B-040 | confirmed | code-read | On S3 resume the TPM restartCount bumps (TPM2_Startup STATE) but resetCount (boot_id) does not, AND PBL never runs — so the OS agent (not firmware) must report restartCount. resetCount==restartCount baseline + stale last_boot_at = bypass; restartCount>resetCount = resume. |

## agent/update

| ID | Status | Evidence | Statement |
|---|--------|----------|-----------|
| B-006 | refuted | code-read | Agent update verification trusts a channel-delivered SHA-256, not a detached signature — the server channel is the sole trust root; a compromised server serves both binary and matching hash. → see B-036 |
| B-036 | confirmed | code-read | Agent updates are authenticity-pinned by a detached Ed25519 signature over "v1:{version}:{sha256}" verified against a device-pinned update_public_key — a compromised server serving binary+hash cannot forge the signature; key domain is separate from recovery escrow; configured-but-broken signing key fails closed (HTTP 500); agents with a pinned key refuse unsigned/invalid updates |
| B-048 | confirmed | code-read | Update authenticity is end-to-end only when a signing key is provisioned: every config generator (agent/installer.py, agent/installer_gui.py, server routes/installer.js, the Worker's generated script and the generic NSIS installer) names update_public_key only when update_signing.pub is actually staged, and both installers copy it into C:\ProgramData\LockdownAgent and pin that installed path — never the staging/download folder, because the agent fails closed on a configured-but-unreadable key and would refuse every future update. Unpinned agents accept SHA-256-only updates and report update_verification (signature \| sha256-only \| key-unreadable) at check-in; both backends store it (Express COALESCE, Worker merge) and the dashboard shows it per device and per row. |
| B-049 | confirmed | code-read | Agent release metadata is produced by scripts/sign-release-metadata.py with one detached Ed25519 signature PER PLATFORM, because the signed message is 'v1:{version}:{sha256}' and therefore binds exactly one hash: a single top-level signature cannot be valid for both a Windows and a Linux build. CI (release.yml publish-agent-release-metadata) signs with the UPDATE_SIGNING_KEY secret, skips the companion binaries (the glob matches lockdown-agent-windows-x64-watchdog.exe before .exe), and attaches agent-release.json to the release; without the secret it publishes unsigned metadata behind a warning annotation, which a pinned agent refuses. The Worker serves platforms[<X-Agent-Platform>].signature first and falls back to the top-level signature only for metadata published before per-platform signing. |
| B-053 | confirmed | code-read | The Worker's update path was structurally broken until S198: /api/agent/update advertised download_url '/api/agent/download?platform=...' while the Worker only implemented '/api/download/agent', so every serverless update download 404'd; and agent.py's download_update called tmp_file.unlink() in its except handler although tmp_file is created only after requests.get() returns, so any pre-response failure raised UnboundLocalError (not in the except tuple) and escaped check_for_update. Both were found only when an end-to-end test followed the advertised URL. Fixes: an agent-authenticated /api/agent/download route serving binary:agent:<platform> with a shared binary:agent fallback (plus x-content-sha256), and a guarded cleanup. The Worker requires full HMAC auth (all four X- headers) unlike Express's transition-tolerant hmacAuth. |

## architecture

| ID | Status | Evidence | Statement |
|---|--------|----------|-----------|
| B-020 | confirmed | code-read | Everything a UEFI application reads can be forged by earlier DXE/SMM code — the only trust anchors are TPM-sealed/measured state, server-side verdicts, and cross-layer disagreement. |
| B-021 | confirmed | code-read | A user-mode agent cannot defeat a kernel/admin adversary — it can only detect, delay, and re-assert; real anchors are TPM, PBL, and the server. |

## deployment/windows

| ID | Status | Evidence | Statement |
|---|--------|----------|-----------|
| B-047 | confirmed | code-read | The one-click Windows installer runs on the target with native Windows facilities only (certutil, sc.exe, registry, the frozen lockdown-agent.exe/watchdog exe). No WSL, no Python, no NSSM on the target; makensis is a server-side Linux build dependency only. The IT-admin alternative agent/install_service.ps1 does require Python + NSSM on the target, so it is not interchangeable with the one-click path. |

## firmware/bcd

| ID | Status | Evidence | Statement |
|---|--------|----------|-----------|
| B-038 | confirmed | emulated | BCD osdevice/device element (0x21000001/0x11000001) packet type 6 is a partition device: PartitionID@0x20 (GPT GUID / MBR u64 byte offset), TableType@0x34 (0=GPT,1=MBR — INVERTED vs WMI PartitionStyle), DiskID@0x38 (GPT disk GUID / MBR u32 sig). Same identity as UEFI HD() device-path node — partition-level FVE binding needs no disk reads. |
| B-039 | confirmed | spec-checked | HARDDRIVE_DEVICE_PATH's signature-kind selector is SignatureType (0x01=MBR sig, 0x02=GPT GUID), NOT MBRType (which is partition format 0x01/0x02). Easy field-name trap when binding to a partition. |

## firmware/boot-flow

| ID | Status | Evidence | Statement |
|---|--------|----------|-----------|
| B-001 | confirmed | emulated | A non-success return from a BLOCK-intent Boot#### entry advances BDS to the next BootOrder entry — an error return is a bypass vector, not a halt. |
| B-002 | confirmed | emulated | PBL BLOCK-intent paths never return to BDS — PblBlockHalt() shows lock screen, requests MOR, resets via EfiResetShutdown, CpuDeadLoop fallback. |
| B-010 | refuted | code-read | BootOrder is checked only for network-boot device-path subtypes — shell images in Boot####, BootNext overrides, and ESP shell binaries are not classified. → see B-033 |
| B-017 | refuted | code-read | BootNext is never inspected — a one-shot shell or boot-manager override is invisible to PBL. → see B-034 |
| B-022 | confirmed | emulated | PBL chain-loads bootmgfw.efi only after SHA-256 hash match against policy BootMgrHash, and passes the hashed buffer to LoadImage — the loaded bytes are the hashed bytes (TOCTOU-safe). |
| B-033 | confirmed | emulated | Boot#### loader paths are classified: MEDIA_FILEPATH_DP nodes are walked and basename-matched against 'shell' — hits set ShellEntryMask (BootOrder position bits) + PBL_BPF_SHELL_IN_BOOT_ENTRY; ESP volumes are scanned for *shell* files → PBL_BPF_SHELL_ON_ESP; both feed the platform-state digest |
| B-034 | confirmed | emulated | BootNext is read and its target classified (BootNextOption field + PBL_BPF_BOOTNEXT_SET/SHELL_AS_BOOTNEXT); BUT EDK2 BDS deletes BootNext at BdsEntry.c:1075 before dispatch, so a live BootNext is unobservable to any booted app — detection is best-effort for non-spec firmware |
| B-035 | confirmed | emulated | On this OVMF build, an unordered Boot#### (exists but not in BootOrder) — or BootNext targeting an existent Boot#### — wedges the VM silently before console init (zero serial output) — emulated anomaly, likely OVMF/QEMU fw_cfg interaction, not confirmed on other firmware |

## firmware/identity

| ID | Status | Evidence | Statement |
|---|--------|----------|-----------|
| B-043 | confirmed | code-read | PBL never populates PBL_PLATFORM_STATE.DeviceId: PblCollectPlatformState zeroes the struct and fills ~20 fields without DeviceId, and PblTpmReadAkName has no caller. Every verdict request therefore carries a 32-byte zero device_id, the server looks the device up under key 000...0 and serves the unknown-device branch, and PblVerifyVerdict step 5 compares zeros to zeros so it passes silently. |
| B-044 | confirmed | spec-checked | TPM2_NV_ReadPublic returns the NV index Name (SHA-256(nameAlg) \|\| SHA-256(nvPublic template)), not the 34 bytes the index stores. PblTpmReadAkName used it and treated that value as the AK Name, so deriving device_id from it would have produced an identical device_id on every machine sharing the NV template — worse than the zero id it replaced, because it looks valid. The stored value requires TPM2_NV_Read. C2 §5.1 step 2 named the wrong command; C2 §1.3 defines the index as storing 34 bytes. |

## firmware/mor

| ID | Status | Evidence | Statement |
|---|--------|----------|-----------|
| B-011 | refuted | spec-checked | MemoryOverwriteRequestControl lives under EFI_GLOBAL_VARIABLE. → see B-012 |
| B-012 | refuted | spec-checked | MemoryOverwriteRequestControl lives under e20939be-32d4-41be-a150-897f85d49829 — Mor.c writes under EFI_GLOBAL_VARIABLE, so PBL's MOR write is a no-op decoy the real TcgMor handler never sees. → see B-042 |
| B-013 | refuted | spec-checked | Bit 1 of MemoryOverwriteRequestControl locks the MOR bit. → see B-014 |
| B-014 | confirmed | spec-checked | The MOR byte has only bit 0 (clear-memory) and bit 4 (disable-autodetect); locking is a separate variable, MemoryOverwriteRequestControlLock. |
| B-023 | refuted | assumed | PBL's MOR request actually reaches the platform TcgMor handler and causes a memory clear on BLOCK. → see B-025 |
| B-025 | confirmed | emulated | PBL's MOR request targets the correct spec-GUID variable and is evaluated by the platform's policy engine (WRITE_PROTECTED denial proves it reached the real variable, not a decoy), but functional memory-clear is platform-gated: non-SMM EDK2 variable drivers register LOCK_NOW VariablePolicies on both MOR vars at EndOfDxe, so no post-EndOfDxe writer can set MOR. Functional MOR requires SMM-capable firmware with legitimate MOR provisioning — hardware-gated. |
| B-026 | confirmed | spec-checked | Non-SMM EDK2 variable drivers (VariableRuntimeDxe, incl. the custom OVMF and Ubuntu OVMF builds) treat MOR as unsupported: MorLockInit deletes both MOR vars and MorLockInitAtEndOfDxe registers unconditional LOCK_NOW VariablePolicies — no BDS-phase or OS writer can set MOR on such platforms. A DXE-phase writer before EndOfDxe would beat the policy lock (relevant to DXE-tier enforcement-depth decision). |
| B-042 | confirmed | code-read | Mor.c now writes MemoryOverwriteRequestControl under the CORRECT spec GUID e20939be-32d4-41be-a150-897f85d49829 (gEfiMemoryOverwriteControlDataGuid), not EFI_GLOBAL_VARIABLE — the latent decoy-variable bug is fixed (Mor.c:9-12,27-28). |

## firmware/network

| ID | Status | Evidence | Statement |
|---|--------|----------|-----------|
| B-007 | refuted | code-read | Fast-boot firmware may never connect the NIC before PBL's HTTPS use. → see B-008 |
| B-008 | confirmed | code-read | PblHttpsPost sweeps ConnectController on all handles before HTTP use — the fast-boot NIC-connection gap is mitigated for already-dispatched drivers. |
| B-015 | refuted | code-read | PblHttpsPost hardcodes QEMU static IP 10.0.2.15 with UseDefaultAddress=FALSE — no DHCP; the HTTPS path cannot work on real hardware as written. → see B-037 |
| B-016 | refuted | code-read | PblHttpsPost accepts http:// URIs (marked temporary for QEMU, D-109) — plaintext fallback is live in the release build. → see B-028 |
| B-028 | confirmed | code-read | Release PblHttpsPost requires https:// and rejects http:// with EFI_INVALID_PARAMETER; http:// survives only in PBL_DEBUG builds for the QEMU dev path — the shipping artifact is fail-closed. |
| B-037 | confirmed | emulated | PblHttpsPost configures IPv4 via Ip4Config2PolicyDhcp — real DHCP DORA on every Ip4Config2 instance with an event-pumped InterfaceInfo poll; the HTTP instance uses UseDefaultAddress=TRUE so the verdict fetch works on any DHCP-served network; the QEMU static fallback exists only under PBL_DEBUG and release builds fail closed on DHCP timeout |

## firmware/s3

| ID | Status | Evidence | Statement |
|---|--------|----------|-----------|
| B-009 | confirmed | code-read | On S3 resume PBL never runs — the platform-state digest has no resume-vs-cold-boot provenance; Decision.c checks S3 capability only. |

## firmware/secureboot

| ID | Status | Evidence | Statement |
|---|--------|----------|-----------|
| B-045 | confirmed | spec-checked | PK and KEK live under gEfiGlobalVariableGuid while db/dbx/dbt live under gEfiImageSecurityDatabaseGuid; writing PK or KEK under the image-security GUID fails with EFI_INVALID_PARAMETER because the variable driver does not recognise it as an authenticated variable. |
| B-046 | confirmed | emulated | PK/KEK/db/dbx writes are rejected with EFI_INVALID_PARAMETER unless the attribute set includes EFI_VARIABLE_TIME_BASED_AUTHENTICATED_WRITE_ACCESS and the data begins with an EFI_VARIABLE_AUTHENTICATION_2 header — even while the platform is in SetupMode; the payload is then taken from Data + AUTHINFO2_SIZE(Data). |

## firmware/tls

| ID | Status | Evidence | Statement |
|---|--------|----------|-----------|
| B-055 | confirmed | code-read | The PBL TLS pin is enforced by construction, not by PblTlsVerifyCert: C4 key 78 carries the pinned CA's DER and PblInstallTlsCaCertificate (TlsVerify.c:56, called from PblApp.c:600 before the fetch at :617) rebuilds the platform TlsCaCertificate store from it each boot, so EDK2's hard-coded EFI_TLS_VERIFY_PEER validates against exactly that CA — proven by artifacts/d132-mismatched-ca-results.txt (correct CA installed, wrong-CA server, handshake aborts, no request reaches the server). What is missing is HOSTNAME binding: PblApp parses the URI host, PblHttpsPost only NULL-checks it, HttpsClient.c configures no TLS session data, and PblTlsVerifyCert (TlsVerify.c:129) has no caller and no SAN support. Also: the QEMU+swtpm firmware harness DOES run locally in Docker (make firmware-qemu, 17 PASS/0 FAIL on the prebuilt PblApp.efi), contrary to the ledger's 'cannot run locally' text; but the image has no EDK II build tool, so firmware C changes cannot be compiled or verified until an edk2 checkout is added. |
| B-056 | confirmed | code-read | The PBL firmware builds reproducibly on this host with the repo's own script: EDK II lives at ~/.local/src/edk2 (commit 2970e56) with nasm 2.16.01 at ~/.local/bin, BaseTools and OVMF already built, and 'cd firmware/PblPkg && ./build-pbl.sh --arch X64' reproduces PblApp.efi (3906065d...), PblPersistDxe.efi (042f2914...) and EnrollKeys.efi (418d7d8c...) byte-identically — git status firmware/ stays empty. So firmware fixes are buildable and verifiable here, contrary to S200's 'no EDK II build tool' conclusion that was drawn from inside the pbl-qemu image only. For D-116, the remaining gap is the TLS VERSION FLOOR, not pinning or hostname: chain pinning comes from C4 key 78 + PblInstallTlsCaCertificate, hostname verification comes from EDK2's HttpDxe (HttpsSupport.c:666-668 sets VerifyHost.HostName from RemoteHost, :695-702 applies EfiTlsVerifyHost), but TlsDxe creates its context as TLS10 (TlsDriver.c:263) and TlsInit.c:107 makes that the minimum, so TLS 1.0/1.1 can be negotiated; PBL cannot raise it because HttpsClient.c only ever holds EFI_HTTP_PROTOCOL (no EFI_TLS_PROTOCOL handle, no EfiTlsVersion). |

## firmware/variables

| ID | Status | Evidence | Statement |
|---|--------|----------|-----------|
| B-003 | confirmed | code-read | PBL variables PblMarkerTest and MemoryOverwriteRequestControl are written without authentication — any boot-time writer can spoof or erase them. |
| B-004 | refuted | code-read | PblBootmgrSvn is attacker-writable — the SVN anti-rollback decision reads an unauthenticated variable any OS process or UEFI shell can plant. → see B-032 |
| B-027 | confirmed | code-read | PblBootmgrSvn is demoted to advisory-only telemetry: PblReadBootmgrSvn now reports a Trusted flag from the variable's TIME_BASED_AUTHENTICATED attribute (BootmgrSvnTrusted in PBL_PLATFORM_STATE); the value must not drive decisions. |
| B-031 | confirmed | emulated | KernelDmaProtection UEFI variable is unauthenticated — plantable by any OS/shell writer for spoof-to-pass on the Decision.c BLOCK gate; PBL now treats it as advisory telemetry only, with DMAR (Intel VT-d) / IVRS (AMD-Vi) ACPI tables as the authoritative firmware-authored signal. |
| B-032 | confirmed | code-read | PblBootmgrSvn remains attacker-writable (unauthenticated by design) but is now advisory-only: Trusted flag from TBA attribute travels with the value in PBL_PLATFORM_STATE (hashed into attestation digest); no decision path consumes it. |

## meta/process

| ID | Status | Evidence | Statement |
|---|--------|----------|-----------|
| B-024 | confirmed | code-read | Ambiguous imperatives ('proceed','go','continue') during an open ruling mean continue the discussion — never start implementing; .devin/PENDING-RULING.md gates code edits |

## meta/testing

| ID | Status | Evidence | Statement |
|---|--------|----------|-----------|
| B-029 | confirmed | emulated | test-d215-harness incremental-build trap: PolicyRootOfTrust.generated.h is __has_include-gated, so it enters make deps only when present at the last compile — a dev→RoT incremental build silently produces the unprovisioned binary; touching the .c file forces correct recompilation. |
| B-041 | confirmed | emulated | QEMU slirp 10.0.2.2 under docker --network host forwards to the docker HOST loopback — a host-side mock server on :8080 is reachable from the guest. In-container mock server fails because pbl-qemu images lack cryptography/cbor2. |

## meta/verification

| ID | Status | Evidence | Statement |
|---|--------|----------|-----------|
| B-018 | confirmed | code-read | Harnesses that check log output rather than security outcomes pass vulnerable code — the D-220 bypass and the MOR no-op both survived green harnesses. |

## testing/e2e

| ID | Status | Evidence | Statement |
|---|--------|----------|-----------|
| B-050 | refuted | code-read | Agent E2E suites that run the in-process test server MUST spawn the agent asynchronously: spawnSync blocks the Node event loop, so the server cannot answer the subprocess and the agent reports a 15s read timeout that looks like a broken server. Spawned agents must also inherit the harness's agentEnv() (agent-relevant vars deleted, never blanked), because the agent's load_config() prefers env over the config file and an inherited AGENT_SHARED_KEY silently replaces the device key, making every check-in 401. And two devices cannot share one host in these suites: get_hardware_uuid() falls back to a host-stable value where DMI is unreadable and devices.hardware_uuid is UNIQUE. → see B-051 |
| B-051 | confirmed | code-read | The agent E2E harness (tests/e2e/agent-helpers.js) already encodes two rules that a new suite must reuse, not reinvent: (1) spawn the agent ASYNCHRONOUSLY, because spawnSync blocks the Node event loop and the test server shares that process — measured 6.0s ReadTimeout synchronously vs 200 in 0.01s async; (2) scrub agent-relevant env vars through agentEnv(), because load_config() prefers env over the config file — an inherited AGENT_SHARED_KEY yields 'SHARED-KEY-FROM-ENV' where the file says 'DEVICE-KEY-FROM-FILE', making every check-in 401. The S195 failures were the new suite bypassing those rules, NOT defects in the pre-existing harness. Separately, and still true: devices.hardware_uuid is UNIQUE while get_hardware_uuid() falls back to a host-stable value where DMI is unreadable, so two devices on one host collide on check-in (re-provision one device); and last_checkin is NULL at enrollment, so an assertion that it becomes non-null depends on a real check-in (verified: null before the agent ran, '2026-11-03 10:24:49' after). |
| B-052 | proposed | assumed | In the jest E2E harness, 'await server.close()' is a no-op (close() returns the server, not a promise), so calling sqlitePool.end() next closes the database while a request handler may still be mid-query; the sqlite3 driver then THROWS from its native error callback (SQLITE_MISUSE: Database handle is closed) as an uncaught exception that kills the jest process with no test-level trace. Teardown must await a real close and drop keep-alive sockets (closeAllConnections) before ending the pool. Separately, ast-grep's unchecked-throwing-call rule fires on calls that ARE inside try: when they sit in an assignment or a with, and its line numbers can lag the file after edits — verify enclosures yourself instead of rewriting correct defensive code. |
| B-054 | confirmed | code-read | In serverless/worker.ts, every /api path the source mentions (outside comments) is dispatched: 37 mentioned paths vs 56 route-table branches, 0 unrouted — so the S198 'advertised but unserved URL' defect was a single instance, not a pattern. The class is now gated two ways: serverless/worker.test.ts asserts that every /api literal outside a comment has a path === branch (verified non-vacuous by renaming the route, which fails both contract tests and the four download tests), and CI already runs that suite (ci.yml npm run test:coverage, release.yml npm test). Consequence for the open question: keeping the workerd E2E opt-in (LOCKDOWN_WORKER_E2E=1) does not leave the class ungated, so pinning wrangler buys runtime fidelity, not failure-mode coverage. |

## threat-model

| ID | Status | Evidence | Statement |
|---|--------|----------|-----------|
| B-019 | confirmed | code-read | In-the-wild UEFI bootkits persist at three layers — SPI flash implants (LoJax, MosaicRegressor, MoonBounce, CosmicStrand), ESP-resident boot managers (BlackLotus, Bootkitty), and image-parser exploits (LogoFAIL). |
