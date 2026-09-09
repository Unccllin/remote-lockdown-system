# Session Capture — 2026-09-09 — sess-090

## Context
- Task: D-109/D-110 breakthrough — full UEFI network verdict flow verified end-to-end in QEMU+swtpm with mock HTTP server
- Environment: repo: remote-lockdown-system, branch: master, commit: b995a0d, key files: firmware/PblPkg/PblApp/HttpsClient.c, firmware/PblPkg/PblApp/PblApp.c, firmware/PblPkg/PblApp/PblApp.h, firmware/PblPkg/PblApp/PblApp.inf, firmware/PblPkg/build-pbl.sh, docs/adr/PBL-DEBT-LEDGER.md, .devin/graph/trace.md
- Duration: ~2 hours

## Decisions Made
- Fixed policy CBOR key 2 to uint (issued_at) instead of tstr (name) — parser in CborDecode.c expects uint
- Rebuilt OVMF with TPM2_ENABLE=TRUE (was FALSE by default in OvmfTpmDefines.dsc.inc)
- Used EFI_HTTP_SERVICE_BINDING_PROTOCOL.CreateChild() to obtain EFI_HTTP_PROTOCOL instead of LocateProtocol
- Added ConnectController on all handles because PBL runs during BDS before driver-connection phase
- Added -cpu qemu64,+rdrand to QEMU because MnpDxe auto-DEPEX requires gEfiRngProtocolGuid
- Temporarily allowed http:// URIs in PblParseUriHostname and PblHttpsPost for QEMU testing (TODO D-109)
- Used static IP 10.0.2.15/24 instead of DHCP because QEMU user networking DHCP didn't assign in time
- Rebuilt OVMF with NETWORK_ALLOW_HTTP_CONNECTIONS=TRUE for HTTP testing

## Actions Taken
- Regenerated test policy blob with correct CBOR encoding (key 2 = uint, not tstr): 150 bytes
- Rebuilt OVMF with HTTP+TLS+TPM2+RDRAND support: OVMF_CODE_NET.fd, OVMF_VARS_NET.fd
- Fixed HttpsClient.c to use EFI_HTTP_SERVICE_BINDING_PROTOCOL CreateChild pattern
- Added ConnectController on all handles before locating HTTP service binding
- Added network stack diagnostic prints (later removed): SNP, MNP, IP4, TCP4, HTTP SB
- Decoded MnpDxe.depex to discover gEfiRngProtocolGuid dependency (13 PUSH+AND opcodes)
- Added +rdrand to QEMU CPU flags — full network stack came up: SNP→MNP→IP4→TCP4→HTTP
- Created mock HTTP server returning COSE_Sign1 verdict (verdict=0 ALLOW, 153 bytes)
- Ran full QEMU+swtpm+mock-server test: POST received 108 bytes, verdict decoded successfully
- Removed diagnostic prints from HttpsClient.c
- Updated trace.md, current-state.md, PBL-DEBT-LEDGER.md (D-109/D-110 → CLOSED)
- Committed as b995a0d

## Outcomes
- What worked: Full UEFI network verdict flow: ESP policy.cose → CBOR/COSE parse → lock_service_uri → HTTP POST → mock server → COSE_Sign1 response → verdict decoded (verdict=0, policy_version=1). TPM HMAC session established. PCR HMAC session established. Fail-closed behavior when signature verification fails (Security Violation → BLOCK).
- What failed: TLS/HTTPS not tested — used HTTP with NETWORK_ALLOW_HTTP_CONNECTIONS=TRUE. Verdict signature verification skipped because policy has no SPKI (D-205). Verdict blocked due to zero signature (Security Violation — fail-closed, correct behavior). TPM NV reads return Device Error because test indexes not provisioned.
- What was unexpected: MnpDxe auto-generated DEPEX includes gEfiRngProtocolGuid — without CPU RDRAND, the entire UEFI network stack silently fails to initialize with no indication that RNG is the root cause. The failure manifests as 'HTTP SB: Not Found'. This was discovered by decoding the 234-byte MnpDxe.depex file with EDK2 DEPEX opcodes (0x02=PUSH, 0x03=AND, 0x08=END) and looking up all 13 GUIDs in Guid.xref.

## Learnings
- EFI_HTTP_PROTOCOL is not a globally installable protocol — it requires EFI_HTTP_SERVICE_BINDING_PROTOCOL.CreateChild() then HandleProtocol(child, gEfiHttpProtocolGuid)
- OVMF's OvmfTpmDefines.dsc.inc defaults TPM2_ENABLE=FALSE — must explicitly set -D TPM2_ENABLE=TRUE
- MnpDxe auto-DEPEX includes gEfiRngProtocolGuid — QEMU default CPU lacks RDRAND, silently blocking the entire network stack
- PBL runs during BDS before the BDS driver-connection phase — must call ConnectController on all handles to connect network drivers to the NIC
- QEMU user networking DHCP may not assign an IP within a reasonable time — use static IP 10.0.2.15/24 for testing
- CBOR policy key 2 is issued_at (uint) not name (tstr) — CborDecode.c lines 728-731 expect uint
- EFI_HTTPv4_ACCESS_POINT uses LocalSubnet (not SubnetMask) for the subnet field
- NETWORK_ALLOW_HTTP_CONNECTIONS=TRUE is needed in OVMF to allow plaintext HTTP for testing

## Mistakes / Corrections
- Initial test policy used key 2 as tstr (name) but parser expects uint (issued_at) — should have read CborDecode.c switch statement first
- Initially tried to locate EFI_HTTP_PROTOCOL directly via LocateProtocol — should have known about the service binding pattern from UEFI spec
- Initially used e1000 NIC model but OVMF only has VirtioNetDxe — should have checked OVMF network driver list first
- Initially used UseDefaultAddress=TRUE (DHCP) but DHCP didn't assign in time — should have used static IP from the start for QEMU testing

## Open Questions
- How to configure TLS CA certificates in OVMF for HTTPS testing?
- How to provision TPM NV indexes in swtpm for authenticated NV commands?
- How to generate a real ECDSA key pair and SPKI for verdict signature testing (D-205)?
- Will real Windows hardware have RDRAND? (Yes, all modern x86 CPUs do)

## File References
- firmware/PblPkg/PblApp/HttpsClient.c
- firmware/PblPkg/PblApp/PblApp.c
- firmware/PblPkg/PblApp/PblApp.h
- firmware/PblPkg/PblApp/PblApp.inf
- firmware/PblPkg/PblApp/CborDecode.c
- firmware/PblPkg/build-pbl.sh
- docs/adr/PBL-DEBT-LEDGER.md
- .devin/graph/trace.md
- .devin/graph/current-state.md
- firmware/OVMF_CODE_NET.fd
- firmware/OVMF_VARS_NET.fd
- firmware/policy.cose

## Optional Fields (applied to consolidated memories)
- evidence_sources: file:firmware/PblPkg/PblApp/HttpsClient.c:157-180, file:firmware/PblPkg/PblApp/CborDecode.c:721-731, spec:UEFI 2.11 §10.6 Driver Connection, file:/home/cllin/.local/src/edk2/OvmfPkg/Include/Dsc/OvmfTpmDefines.dsc.inc:2
- impact: D-109 CLOSED, D-110 CLOSED — UEFI network verdict flow verified. Next: D-205 (verdict signing key SPKI), TLS configuration, NV index provisioning, D-211 (real hardware)
- response: Next session: implement D-205 (verdict signing key SPKI in policy) to enable signature verification, or provision TPM NV indexes in swtpm to exercise authenticated NV commands with HMAC session and AES parameter encryption
