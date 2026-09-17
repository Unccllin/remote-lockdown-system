# TCG TPM 2.0 Study Notes

## Source

- **Title:** Trusted Computing Group (TCG) *TPM 2.0 Library Specification*, revision 1.85.
- **Date:** 2026/03/12 (extracted from PDF/page footers).
- **Files reviewed (local):**
  - `/tmp/go-sdk-vtpm2/docs/spec/v185/Part-0.txt` — introduction and trust model.
  - `/tmp/go-sdk-vtpm2/docs/spec/v185/Part-1.txt` — architecture, commands/responses, sessions, policy, PCRs, names.
  - `/tmp/go-sdk-vtpm2/docs/spec/v185/Part-2.txt` — data structures, attribute bit fields, `TPMA_SESSION`, algorithm constants.
  - `/tmp/go-sdk-vtpm2/docs/spec/v185/Part-3.txt` — command/response tables and general descriptions.
- **Search convention used:** page-aware `awk`-prefix search from `/tmp/go-sdk-vtpm2/CLAUDE.md`, and the pre-indexed `/tmp/Part-{0,1,2,3}.indexed` files.
- **PBL source files:**
  - `firmware/PblPkg/PblApp/TpmClient.c`
  - `firmware/PblPkg/PblApp/TpmSession.c`
  - `firmware/PblPkg/PblApp/TcgLog.c`
  - `firmware/PblPkg/PblApp/PblApp.h`
  - `firmware/PblPkg/PblApp/PblApp.c` (call sites only)
- **PBL architecture docs:**
  - `docs/adr/PBL-C2-TPM-Contract.md`
  - `docs/adr/PBL-C4-Policy-Blob.md`
- **EDK II source files:**
  - `MdePkg/Include/Protocol/Tcg2Protocol.h`
  - `MdePkg/Include/IndustryStandard/Tpm20.h`
  - `SecurityPkg/Tcg/Tcg2Dxe/Tcg2Dxe.c`
- **Cross-reference notes:**
  - `docs/research/STUDY-UEFI-SPEC-2.10.md`
  - `docs/research/STUDY-EDK2.md`
- **BitLocker PCR context (secondary, not a TCG library source):**
  - Microsoft Learn, *OEM BitLocker provisioning* and *BitLocker-Boot-Options*.
  - SCRT blog, *BitLocker and the TPM Platform Validation Profile*.
- **Important source gap:** The TCG *PC Client Platform TPM Profile* (PTP) PDF, which defines TIS/CRB register-level transport and event-log format, is behind Cloudflare on trustedcomputinggroup.org and was not retrieved. The PTP material in this note is therefore derived from EDK II implementations and the PTP references embedded in the TPM 2.0 library specification, and is explicitly marked as implementation-derived.

## One-paragraph technical overview

A TPM 2.0 is a discrete or firmware-resident cryptographic co-processor that exposes shielded storage, a deterministic root of trust for reporting, and an extend-only integrity state in Platform Configuration Registers (PCRs). All TPM commands are byte streams with a 10-byte big-endian header and optional authorization/session areas; command execution may be authorized by a password (`TPM_RS_PW`), an HMAC session, or a policy session that accumulates a policy digest through `TPM2_Policy*` commands. Non-volatile (NV) indices and sealed key objects let the platform persist and later release data only when a caller proves the expected PCR, locality, and/or authorization state; `EFI_TCG2_PROTOCOL` in EDK II wraps raw command submission and event logging for UEFI phases before `ExitBootServices()`.

## 10-20 key technical facts/mechanisms

1. **The TPM has three logical roots of trust.** The Root of Trust for Measurement (RTM) generates integrity measurements; the Root of Trust for Storage (RTS) holds shielded, non-migratable data; and the Root of Trust for Reporting (RTR) signs attestations of selected TPM state. PCRs are an example of non-sensitive readable state; private keys are sensitive shielded state. (Part 0 §4.4, pp. 28–29; Part 1 §7, p. 31)

2. **TPM command and response buffers share a 10-byte header.** A command begins with `tag` (`TPM_ST`), `commandSize`, and `commandCode`; a response begins with `tag`, `responseSize`, and `responseCode`. Both are big-endian. (Part 1 §15.1, pp. 97–98; `Tpm20.h` lines 480–484; `TpmClient.c` lines 72–103)

3. **Canonical big-endian applies to every multi-byte integer in the wire format.** The TPM uses MSB0 bit and big-endian octet ordering for all serialised values. (Part 1 §5.2, p. 22; `TpmClient.c` lines 72–103, 125–143)

4. **Tags distinguish commands with and without sessions.** `TPM_ST_NO_SESSIONS` (0x8001) means no authorization area and no parameter-size field; `TPM_ST_SESSIONS` (0x8002) means an authorization area follows and both the command and response carry a `paramSize` field. (Part 1 §15.1, pp. 97–98; `Tpm20.h` lines 481–484; `TpmClient.c` lines 125–143)

5. **Authorization/session types are HMAC, policy, and trial.** `TPM_SE_HMAC` (0x00) creates an HMAC-authorized session; `TPM_SE_POLICY` (0x01) accumulates a policy digest; `TPM_SE_TRIAL` (0x03) is used only to build a policy without executing commands. (Part 2 §8.4, p. 69; `Tpm20.h` lines 506–508; `TpmSession.c` lines 263–270, 345–347)

6. **HMAC authorization is computed over pHash, nonce pair, and session attributes.** The HMAC input is `H( pHash || nonceNewer || nonceOlder || sessionAttributes [|| (optional decrypt/encrypt nonce for parameter encryption)] )`; raw nonces are used, not size-prefixed buffers. (Part 1 §16.6.7, pp. 118–120; `TpmSession.c` lines 659–787)

7. **Session-key derivation depends on `bind` and `salt`.** If both `tpmKey` and `bind` are `TPM_RH_NULL`, the session key is an empty buffer and the HMAC relies on the caller-side `authValue` (e.g., `authValue` of the bound NV index). (Part 1 §16.6.6, p. 121; `TpmSession.c` lines 412–424)

8. **`TPMA_SESSION` controls session behavior and parameter encryption.** Bits include `continueSession`, `auditExclusive`, `auditReset`, `decrypt`, `encrypt`, and `audit`. The `decrypt` bit requests encryption of the first command parameter; `encrypt` requests encryption of the first response parameter. (Part 2 §10.7, pp. 104–106; `PblApp.h` lines 83–85; `TpmSession.c` lines 33–34; `TpmClient.c` lines 172–214)

9. **PCRs are hash accumulators, not ordinary writeable memory.** A `TPM2_PCR_Extend` computes `newPCR[bank] = Hash( oldPCR[bank] || digest[bank] )` for each selected bank. Direct PCR writes are not permitted; reset/extend is allowed only for the PCRs and under the authorizations, policies, and localities defined at allocation. (Part 1 §13, pp. 91–96; Part 3 §22.2, p. 194; `TpmClient.c` lines 1524–1629)

10. **PCR banks are keyed by hash algorithm.** `TPML_PCR_SELECTION` and `TPMI_ALG_HASH` select which bank(s) to extend or quote. A single extend command can carry one digest per active bank, and the TPM applies it to the matching bank. (Part 1 §12.1, pp. 89–90; Part 2 algorithm constants; `TpmClient.c` lines 1638–1694)

11. **NV indices are defined with `TPM2_NV_DefineSpace` and a public area.** `TPMA_NV_*` attributes control read, write, extend, locking, hierarchy, counter behavior, and dictionary-attack protection. The Name of an NV index is `nameAlg || H(nameAlg, handle || nvPublicArea)` and changes when `TPMA_NV_WRITTEN` or lock attributes change. (Part 3 §31.3, pp. 344–345; Part 1 §13, pp. 89–90; `TpmClient.c` lines 997–1086)

12. **NV commands require authorization matching the index attributes.** Whether a write uses `authValue`, `TPM_RH_PLATFORM`, `TPM_RH_OWNER`, or a policy is determined by `TPMA_NV_PPWRITE`, `TPMA_NV_OWNERWRITE`, `TPMA_NV_AUTHWRITE`, and `TPMA_NV_POLICYWRITE`; the same idea applies to reads. (Part 3 §31.8, p. 355; `TpmClient.c` lines 1100–1160)

13. **`TPM2_Clear` removes owner-controlled context and most storage-hierarchy NV.** It flushes objects, changes the SPS, resets hierarchy auths, and deletes any NV Index defined with `TPMA_NV_PLATFORMCREATE == CLEAR`. Platform-created indices survive. (Part 3 §24.6, p. 283; `PBL-C2-TPM-Contract.md` §1)

14. **There is no standalone `TPM2_Seal` command.** Sealing is `TPM2_Create` or `TPM2_CreatePrimary` with `sensitive.data` and an `authPolicy` requiring, for example, `TPM2_PolicyPCR` (or `TPM2_PolicyOR`, `TPM2_PolicyCommandCode`, `TPM2_PolicyAuthValue`). To release the data the caller first creates a policy session, satisfies each policy assertion, and then calls `TPM2_Unseal`. (Part 3 §12.1, p. 63; §12.7, pp. 80–81; §24.1, pp. 271–273; `PBL-C2-TPM-Contract.md` §3.4)

15. **Attestation uses `TPM2_Quote` and an Attestation Key (AK).** `TPM2_Quote` returns a `TPMS_ATTEST` structure signed by the selected key, covering the selected PCRs. `TPM2_GetCapability` reads TPM properties such as active PCR banks, manufacturer, and firmware version. (Part 3 §18.4, pp. 157–158; Part 3 §30.2, pp. 331–336; `TpmClient.c` lines 1807–1847)

16. **The Endorsement Key (EK) is derived from the Endorsement Primary Seed (EPS).** An AK is an asymmetric signing key used for quotes; identity privacy can be preserved with a Privacy CA or, more directly, with ECDAA/Direct Anonymous Attestation. (Part 1 §14.5, pp. 81–82; Part 1 §44.3.3, p. 298)

17. **Locality is a privilege-level tag for accesses to the TPM.** Locality 0–4 are represented as single bits; extended localities are integer values 32–255. PCR reset/extend attributes are associated with locality, and `TPM2_PolicyLocality` can require a particular locality. (Part 1 §13, pp. 91–96; Part 1 §30, p. 230; Part 1 §16.7, p. 137)

18. **`TPM2_Startup` and `TPM2_Shutdown` manage the TPM life-cycle.** `TPM2_Startup(CLEAR)` or `(STATE)` follows a `_TPM_Init` and sets the initial state; `TPM2_Shutdown(STATE)` preserves the PCR update counter and designated PCRs for the next startup, while `TPM2_Shutdown(CLEAR)` does not. (Part 3 §9.3, p. 45; Part 3 §9.4, pp. 46–47; Part 1 §8, pp. 62–67)

19. **EDK II exposes the TPM to UEFI through `EFI_TCG2_PROTOCOL`.** The protocol provides `GetCapability`, `GetEventLog`, `HashLogExtendEvent`, `SubmitCommand`, `GetActivePcrBanks`, and `SetActivePcrBanks`. It is installed before BDS by `SecurityPkg/Tcg/Tcg2Dxe` and is a Boot Services protocol, so it must not be used after `ExitBootServices()`. (`Tcg2Protocol.h` lines 32–87, 238–304; `Tcg2Dxe.c` lines 1410–1489, 1319–1392, 1578–1584; `STUDY-UEFI-SPEC-2.10.md`)

20. **`TPM2_PCR_Read` does not require authorization; `TPM2_PCR_Extend` does.** A caller can read any PCR freely, although sessions can be used for integrity/audit. Extending a PCR requires an authorization session or the relevant platform policy. (Part 3 §22.3, pp. 197–198; Part 3 §22.2, p. 194)

## Glossary terms

- **PCR (Platform Configuration Register):** An extend-only hash accumulator. Cannot be written directly; each bank is updated with `Hash(oldPCR || newDigest)`.
- **PCR bank:** A set of PCRs keyed to one hash algorithm (e.g., SHA-1, SHA-256, SHA-384). Selected through `TPML_PCR_SELECTION`.
- **NV index:** A named non-volatile area in TPM memory with its own public area, attributes, and authorization model.
- **Name (TPM):** The unique identifier of an entity. For an NV index it is `nameAlg || H(nameAlg, handle || nvPublicArea)`; for a transient object it is `nameAlg || H(nameAlg, publicArea)`.
- **pHash:** The hash of the command/response fields, including `commandCode`/`responseCode` and command/response parameters, used in session HMACs.
- **pcrUpdateCounter:** A TPM counter that increments when PCRs are extended or reset; `TPM2_PolicyPCR` records it and can return `TPM_RC_PCR_CHANGED` if the PCRs changed after the policy was asserted.
- **HMAC session:** A session in which command and response authorizations are HMACs over pHash, nonces, and attributes.
- **Policy session:** A session in which the TPM accumulates a `policyDigest` by evaluating a sequence of `TPM2_Policy*` commands.
- **Trial session:** A non-executing policy session used to compute the final `authPolicy` for an object or NV index.
- **authValue:** A password-like secret bound to an entity (object, NV index, hierarchy).
- **authPolicy:** A digest representing the policy that must be satisfied to authorize an operation on an entity.
- **bind:** A permanent entity (often an NV index or key) whose `authValue` is mixed into the session key.
- **salt:** An encrypted secret used to seed the session key when `tpmKey` is a loaded key.
- **continueSession:** A `TPMA_SESSION` bit that tells the TPM to keep the session context after this command; clearing it causes implicit flush.
- **Locality:** A privilege level tag supplied by the TPM interface; used in policy and PCR access control.
- **Sealed object:** A TPM object created with `TPM2_Create`/`TPM2_CreatePrimary` containing `sensitive.data` and an `authPolicy`; released by `TPM2_Unseal` when the policy is satisfied.
- **EK (Endorsement Key):** A primary key derived from the EPS, cryptographically identifying the TPM for attestation.
- **AK (Attestation Key):** A signing key, often a child of a storage key or the EK hierarchy, used to sign `TPM2_Quote` outputs.
- **DAA / ECDAA:** Direct Anonymous Attestation, a group-signature scheme that lets a TPM sign quotes without revealing its identity.

## Security implications

- **PCRs reset at startup or after `TPM2_Clear`.** Any pre-OS code that runs before PBL can extend PCRs and therefore influence the values PBL later observes or must match. A fail-open policy that trusts an unmeasured pre-boot environment is vulnerable to extension by a compromised loader or boot manager. (Part 1 §13, pp. 91–96)
- **HMAC session security depends on secrets and nonces.** When `bind` is `TPM_RH_NULL` and the session key is empty, the HMAC relies on the caller’s `authValue`. A weak or empty `authValue` allows dictionary and replay attacks; `TPMA_SESSION_NO_DA` and lockout policy can mitigate but not eliminate this. (Part 1 §16.6, pp. 118–121)
- **Parameter encryption is limited to the first command/response parameter.** `TPM_ST_SESSIONS` with `decrypt`/`encrypt` only protects the first parameter; it does not encrypt handles, the authorization area, or later parameters. This is still enough to hide NV write payloads and unsealed data, but not everything. (Part 2 §10.7, pp. 105–106; `TpmSession.c` lines 594–624)
- **NV index attributes define persistence and resistance to clear.** Platform-created (`TPMA_NV_PLATFORMCREATE`) indices survive `TPM2_Clear(RH_OWNER)`, but not a platform-authorized `TPM2_Clear` or `TPM2_Clear(RH_PLATFORM)`. Mis-chosen attributes can make lock state vanish on owner clear or survive when it should not. (Part 3 §24.6, p. 283; Part 3 §31.3, p. 344)
- **Names change with lock/written state.** If an HMAC uses a stale Name after `TPM2_NV_Write` sets `TPM_NV_WRITTEN` or after the index is read- or write-locked, the authorization will fail and may increment dictionary-attack protection. The caller must either re-read `TPM2_NV_ReadPublic` or compute the new Name from the updated public area. (Part 1 §13, pp. 89–90)
- **Policy sessions are fail-closed.** If the current PCR digest, locality, command code, or `authValue` does not match the accumulated `authPolicy`, `TPM2_Unseal` or an NV operation fails. This is the basis of BitLocker’s data-at-rest protection but also makes recovery challenging after a legitimate firmware or option-ROM update. (Part 1 §16.7, pp. 131–146; Part 3 §22.7, p. 225)
- **Raw `SubmitCommand` bypasses EDK II event logging.** If PBL extends PCR 12/13 but does not log the event through the same path as `Tcg2Dxe`, the TCG event log will not reflect *why* those PCR values were produced, weakening post-boot audit. (`Tcg2Dxe.c` lines 1230–1392; `TcgLog.c` lines 80–165)
- **`TPM2_Quote` is only meaningful with a trusted AK and verifier.** A quote signed by an unproven key is just a signed statement; the verifier must bind the AK to an EK, a credential, or a certificate chain, or use DAA to preserve privacy. (Part 1 §14.5, pp. 81–82)

## PBL-specific relevance

- **PBL uses raw `EFI_TCG2_PROTOCOL->SubmitCommand`.** `PblTcg2Locate` finds the protocol and checks `TPMPresentFlag`; `PblTpmSubmitCommand` wraps `Tcg2->SubmitCommand`. This gives PBL full control over command construction but removes EDK II’s safety wrappers. (`Tcg2Protocol.h` lines 238–304; `Tcg2Dxe.c` lines 1410–1489; `TpmClient.c` lines 54–118)

- **PBL defines three platform-hierarchy NV indices for the cache.** `PBL_NV_LOCK_STATE` (0x01C00001, 64 bytes), `PBL_NV_POLICY_VERSION` (0x01C00002, 8 bytes), and `PBL_NV_AK_NAME` (0x01C00003, 34 bytes). The index base is `0x01C00000` plus an offset derived from `PcdNvIndexBase`. (`PblApp.h` lines 54–62; `PBL-C2-TPM-Contract.md` §2)

- **Decision and platform state are bound to PCR 12 and PCR 13.** `PBL_PCR_DECISION` is 12 and `PBL_PCR_INPUTS` is 13. PBL never extends PCR 0–7, 11, or other PCRs controlled by the firmware/BitLocker profile. (`PblApp.h` lines 88–89; `PBL-C2-TPM-Contract.md` §4.3; `PBL-C4-Policy-Blob.md` §5)

- **PBL establishes HMAC sessions with AES-256-CFB parameter encryption.** `PblTpmStartHmacSession` calls `TPM2_StartAuthSession` with `TPM_SE_HMAC`, SHA-256, and an AES-256-CFB symmetric parameter. The intended session attributes are `TPMA_SESSION_CONTINUESESSION | TPMA_SESSION_DECRYPT | TPMA_SESSION_ENCRYPT`. (`PblApp.h` lines 83–85; `TpmSession.c` lines 288–428; `TpmClient.c` lines 172–214)

- **The session is unbound and unsalted in the current code.** `tpmKey` and `bind` are `TPM_RH_NULL` for the PCR session, and for the lock-state session `bind` may be set to the NV index handle with an empty `bindAuth` in the dev/OVMF path. The session key is therefore empty and the HMAC relies on `authValue`. (`TpmSession.c` lines 412–424; `PblApp.c` lines 277–285, 551–555)

- **Command HMAC and parameter encryption are implemented in `TpmSession.c`.** `PblTpmComputeCommandHmacEx` computes the HMAC over pHash, nonceCaller, nonceTPM, and the session attributes; `TpmClient.c` (`PblTpmFillCommandHmac`) serializes it into the auth area; `PblTpmEncryptCommandParams` then XOR-encrypts the first command parameter with AES-256-CFB if `decrypt` is set. Response verification is done by `PblTpmVerifyResponseHmacEx`/`PblTpmVerifyResponseHmacSession`. (`TpmSession.c` lines 659–787, 827–995; `TpmClient.c` lines 172–214, 550–600)

- **NV read/write/increment are implemented in `TpmClient.c`.** `PblTpmReadLockState`, `PblTpmWriteLockState`, `PblTpmIncrementPolicyVersion`, and `PblTpmReadPolicyVersion` build the big-endian command buffers, attach the HMAC session, and parse the response. `PblTpmProvisionNvIndices` defines the three indices. (`TpmClient.c` lines 957–1252, 1524–1629, 1807–1847)

- **The TCG event log parser is currently a stub.** `PblParseTcgLog` zeros the extracted PCR values for PCR 4, 5, 7, and 11 instead of parsing the event log, and `PblLogExtendEvent` hashes the data, extends the PCR directly, and then calls `HashLogExtendEvent` with `DataToHashLen == 0`. This does not produce a complete or correctly linked event-log entry. (`TcgLog.c` lines 27–77, 80–165)

- **There is a contract/implementation mismatch in NV hierarchy.** `PBL-C2` requires platform-hierarchy, platform-created indices so they survive `TPM2_Clear(RH_OWNER)`. The current `TpmClient.c` provisioning path uses `TPM_RH_OWNER` with empty auth under OVMF because `Tcg2PlatformDxe` randomises the platform hierarchy `authValue`. This means the indices are owner-hierarchy in the dev build and will be deleted by `TPM2_Clear`. (`TpmClient.c` lines 1014–1018; `PBL-C2-TPM-Contract.md` §1, §3.1)

- **PBL flushes sessions before chain-loading Windows.** `PblTpmFlushSession` and `PblTpmFlushPcrSession` send `TPM2_FlushContext` for the loaded session handles, freeing TPM slots before `ExitBootServices`. (`TpmSession.c` lines 1006–1020, 1187–1200; `TpmClient.c` lines 1736–1764; `PblApp.c` lines 644–681)

- **BitLocker is not automatically affected by PCR 12/13.** Windows default BitLocker UEFI profiles use PCR 7 + 11 when Secure Boot supports PCR 7, or PCR 0, 2, 4, 11 otherwise. PBL’s PCR 12/13 extensions only matter if a separate BitLocker protector or a `TPM2_PolicyPCR` seal explicitly includes them. (`PBL-C2-TPM-Contract.md` §4.3; `PBL-C4-Policy-Blob.md` §5)

## Known implementation pitfalls

1. **`TcgLog.c` is not a real TCG log parser.** It zeroes PCR 4, 5, 7, and 11 and does not recover the final pre-extend values from the event log. Any platform-state digest that depends on those PCRs is currently unverified. (`TcgLog.c` lines 80–165; `PBL-DEBT-LEDGER.md` D-125)

2. **OVMF/swtpm provisioning uses owner hierarchy with empty auth.** Real hardware requires the platform hierarchy or the PTP-defined platform authorization to create platform-surviving indices; the dev path will fail or create wrong-ownership indices on a real TPM. (`TpmClient.c` lines 997–1018; `PBL-C2-TPM-Contract.md` §3.1)

3. **`PblTpmStartAuthSession` works around swtpm 0.7.3 output quirks.** The response for `TPM2_StartAuthSession` may not include `sessionAttributes` in swtpm 0.7.3, so the code reconstructs the default attributes. This is a simulator-specific workaround and may hide real bugs on hardware. (`TpmSession.c` lines 371–373)

4. **HMAC session with no `bind` and no `salt` has an empty session key.** In that case the `authValue` is the only secret in the HMAC. If PBL falls back to `TPM_RS_PW` with an empty password on an unprovisioned device, authorization is trivially forgeable. (`TpmSession.c` lines 412–424; `TpmClient.c` lines 362–378)

5. **NV index Names change after first write and after lock.** The HMAC authorisation must be recalculated against the current public area; otherwise the command fails and, depending on `TPMA_NV_NO_DA`, may contribute to lockout. `PblTpmComputeNvName`/`PblTpmCacheNvName` compute the Name from the initial public area but do not update it after a write or lock, so a stale cached Name could break authorisation. (Part 1 §13, pp. 89–90; `TpmClient.c` lines 429–488)

6. **`TPM2_PCR_Extend` requires authorization; a no-session fallback is not spec-valid.** The fallback in `PblApp.c` (“PCR session start failed — using no-session”) can work only against swtpm/OVMF with `authValue` policies disabled or the PCR in a group with empty auth. On a real TPM, `TPM2_PCR_Extend` with `TPM_ST_NO_SESSIONS` will fail unless the specific PCR’s authValue is empty and the implementation allows it. (Part 3 §22.2, p. 194; `PblApp.c` lines 551–555; `TpmClient.c` lines 1524–1535)

7. **BitLocker PCR profile is deployment-specific, not universal.** OEM firmware, Secure Boot configuration, boot manager path, and user choices can change the profile. PBL cannot assume that extending PCR 12/13 will deny Windows boot unless the installed protector explicitly lists them. (`PBL-C2-TPM-Contract.md` §4.3; secondary Microsoft/SCRT BitLocker docs)

8. **`TPM2_Startup` is the firmware’s responsibility.** EDK II `Tcg2Dxe` calls `TPM2_Startup` during DXE/BDS. PBL must not call it again; a second startup will return `TPM_RC_INITIALIZE` or similar and can violate platform boot sequencing. (`Tcg2Dxe.c` startup code; `PblApp.c` does not call `TPM2_Startup`.)

9. **If `PblTpmStartHmacSession` fails, PBL falls back to `TPM_RS_PW` (password auth).** In the dev build the owner hierarchy and NV index `authValue` are empty, so the password session uses an empty secret. This works under swtpm/OVMF but is trivially forgeable and must not be used on real hardware. (`PblApp.c` lines 279–282; `TpmClient.c` lines 362–378; `TpmSession.c` lines 312–316)

10. **The PC Client PTP transport and event-log format were not reviewed.** The TIS/CRB register details and the canonical event log structure are in the PTP/PC Client PFP documents that could not be retrieved. Any pre-boot transport claim here is based on EDK II source, not on the PTP itself.

## Cross-references to previously studied sources

- `STUDY-UEFI-SPEC-2.10.md`: `ExitBootServices()` boundary, `EFI_SYSTEM_TABLE`, `EFI_BOOT_SERVICES`, `EFI_RUNTIME_SERVICES`, `OpenProtocol()`, and UEFI application execution model. The `EFI_TCG2_PROTOCOL` is a Boot Services protocol and disappears after `ExitBootServices()`.
- `STUDY-EDK2.md`: EDK II image build, protocol GUIDs, and DXE/BDS phase details. `Tcg2Dxe` is a DXE driver that installs `EFI_TCG2_PROTOCOL`, calls `Tpm2Startup`, measures UEFI variables such as `SecureBoot`, `PK`, `KEK`, `db`, and `dbx`, and maintains the event log area.
- `PBL-C2-TPM-Contract.md`: the authoritative PBL contract for platform-hierarchy NV indices, HMAC sessions with AES-256-CFB, PCR 12/13 usage, and the BitLocker/PCR fail-closed design.
- `PBL-C4-Policy-Blob.md`: policy blob evaluation, monotonic version check against the NV counter, and the distinction between local policy state, cached lock state, and server `LOCKED` verdict.

## Outstanding questions

1. What is the exact policy-command sequence `TPM2_PolicyAuthorize` + `TPM2_PolicyPCR(12)` + `TPM2_PolicyAuthValue` intended by `PBL-C2` for the policy-version counter? The contract lists the sequence, but `TpmSession.c` does not yet implement a full policy session builder. (`PBL-C2-TPM-Contract.md` §3.4; `TpmSession.c` lines 130–142)
2. How will PBL provision `TPMA_NV_PLATFORMCREATE` indices on real hardware where the platform hierarchy auth is not empty and is not exposed to the UEFI application? A separate pre-provisioning flow or `PhysicalPresence` interface may be required. (Part 3 §31.3, p. 344; `PBL-C2-TPM-Contract.md` §3.1)
3. Which BitLocker PCR profile is active on the target fleet? PBL currently has no runtime detection (D-120). Should it inspect the Windows Boot Configuration Data (BCD) or the BitLocker protector metadata? (`PBL-DEBT-LEDGER.md` D-120)
4. Does `PblTpmIncrementPolicyVersion` handle `TPM_RC_NV_LOCKED`, counter wrap, and `TPM_RC_NV_UNAVAILABLE`? The NV counter is `TPMA_NV_COUNTER`, but the command builder does not appear to check these cases. (`TpmClient.c` lines 1347–1380)
5. Should PBL record its PCR 12/13 extensions in the TCG event log? `TcgLog.c` is marked unfinished; a real implementation is needed for auditability. (`TcgLog.c` lines 80–165; `PBL-DEBT-LEDGER.md` D-125)
6. Is the `TPM2_StartAuthSession` nonce-caller and AES-CFB IV generation fully spec-compliant? `PblTpmStartHmacSession` uses `TPM2_GetRandom`, not `EFI_RNG_PROTOCOL`, and the AES-CFB IV is fixed at zero as the spec requires; is this adequate for both dTPM and swtpm? (`TpmSession.c` lines 312–316; `TpmSession.c` lines 52–60)
7. Is the no-session PCR-extend fallback only safe in swtpm/OVMF? On a hardware TPM, `TPM2_PCR_Extend` with `TPM_ST_NO_SESSIONS` will almost certainly fail, producing a fail-open path if PBL ignores the error. (Part 3 §22.2, p. 194; `PblApp.c` lines 551–555)
8. The PTP/PC Client PFP event log and TIS/CRB transport sections could not be reviewed. Are there locality, command-address, or final-events-table requirements that affect pre-boot PCR extension? (Source gap noted above.)

## Self-test (TPM 2.0) — 10 questions with answers and confidence

1. **What are the three TPM roots of trust and which one corresponds to signing attestations?**  
   **A:** Root of Trust for Measurement (RTM) creates measurements; Root of Trust for Storage (RTS) holds shielded data; Root of Trust for Reporting (RTR) signs attestations. The RTR signs `TPM2_Quote` outputs and other credentials. (Confidence: high; Part 0 §4.4, p. 28–29)

2. **What is the byte order of all multi-byte integers in TPM command/response buffers?**  
   **A:** Big-endian / most-significant-octet first. (Confidence: high; Part 1 §5.2, p. 22; `TpmClient.c` lines 72–103)

3. **How does a PCR change value during `TPM2_PCR_Extend`?**  
   **A:** For each active bank, the new value is `Hash(oldPCR || digest)`, where `digest` is the caller-supplied tagged digest for that bank. (Confidence: high; Part 1 §13, pp. 91–96; Part 3 §22.2, p. 194)

4. **Does `TPM2_PCR_Read` require an authorization session?**  
   **A:** No. `TPM2_PCR_Read` does not require authorization, although a session can be added for integrity/audit. (Confidence: high; Part 3 §22.3, pp. 197–198)

5. **What happens to an NV index created with `TPMA_NV_PLATFORMCREATE == CLEAR` when `TPM2_Clear(RH_OWNER)` is executed?**  
   **A:** It is deleted. Only NV indices with `TPMA_NV_PLATFORMCREATE == SET` survive an owner clear. (Confidence: high; Part 3 §24.6, p. 283)

6. **Is there a `TPM2_Seal` command in the TPM 2.0 library specification?**  
   **A:** No. Sealing is performed by creating a key object with `TPM2_Create` or `TPM2_CreatePrimary` that has `sensitive.data` and an `authPolicy`, then using `TPM2_Load` and `TPM2_Unseal` to release the data. (Confidence: high; Part 3 §12.1, p. 63; §12.7, pp. 80–81)

7. **What is the primary difference between an HMAC session and a policy session?**  
   **A:** An HMAC session proves knowledge of a secret for each command/response; a policy session accumulates a `policyDigest` through `TPM2_Policy*` commands and authorizes operations based on satisfying that policy. (Confidence: high; Part 1 §16.6, pp. 114–130; Part 1 §16.7, pp. 131–146)

8. **What do the `decrypt` and `encrypt` bits in `TPMA_SESSION` protect?**  
   **A:** They request AES-256-CFB (or the agreed symmetric algorithm) encryption of the first command parameter (`decrypt`) and the first response parameter (`encrypt`). They do not encrypt handles or the authorization area. (Confidence: high; Part 2 §10.7, pp. 105–106)

9. **Which PCRs does PBL extend, and why are they chosen?**  
   **A:** PCR 12 (decision) and PCR 13 (platform-state inputs). They are not part of the standard Windows/BitLocker PCR profiles, so PBL can use them to record its own policy verdict and input state without colliding with firmware/BitLocker measurements. (Confidence: high; `PblApp.h` lines 88–89; `PBL-C2-TPM-Contract.md` §4.3)

10. **Why does the current PBL `TcgLog.c` implementation weaken pre-boot attestation?**  
    **A:** Because `PblParseTcgLog` does not parse the event log; it returns zero for PCR 4, 5, 7, and 11. Any platform state that depends on these PCR values is therefore not actually being verified. (Confidence: high; `TcgLog.c` lines 80–165)
