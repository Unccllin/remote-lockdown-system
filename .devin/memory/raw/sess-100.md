# Session Capture — 2026-09-15 — sess-100

## Context
- Task: Study academic papers on UEFI bootkits, firmware security, and TPM attestation (Source 7)
- Environment: <not specified>
- Duration: <not specified>

## Decisions Made
- <none recorded>

## Actions Taken
- Fetched three arXiv HTML papers and extracted key sections.
- Searched for and cited standards and conference reports.
- Wrote consolidated academic study note.
- Closed session and captured memory.

## Outcomes
- What worked: <not recorded>
- What failed: <not recorded>
- What was unexpected: <not recorded>

## Learnings
- SoK UEFI security analysis (arXiv 2311.03809v2) provides a MITRE ATT&CK-like taxonomy and risk analysis; highest-risk techniques include malicious boot/payload/driver injection, SMM exploitation, physical attacks, UEFI policy alteration, bootkit installation, and Secure Boot bypass.
- Peacock (arXiv 2601.07402) is a UEFI runtime observability framework: DXE agent logs Boot/Runtime Service calls, OS Agent builds a TPM-attested bundle, and Analysis Server detects Glupteba, BlackLotus, LoJax, MosaicRegressor.
- UEFI Memory Forensics (arXiv 2501.16962) provides UEFIMemDump and UEFIDumpAnalysis to detect function-pointer hooking, inline hooking (MoonBounce), malicious image loading, and gadget-based control flow.
- vTPM (USENIX Security 06) virtualizes TPM for VMs; fTPM (USENIX Security 16) implements software TPM 2.0 using ARM TrustZone/Intel SGX.
- Separate but Together (USENIX ATC 25) shows TLS and remote attestation must be cryptographically linked to prevent relay attacks.
- NIST SP 800-155 / TCG PC Client FIM / RFC 9683 define firmware integrity measurement chains with RTM, event log, RIM/golden measurements, and verifier appraisal policy.
- BootHole (CVE-2020-1073) and BYOVD attacks demonstrate that signed but vulnerable bootloaders/drivers defeat Secure Boot; dbx/SVN floors are essential.
- PBL relevance: bootmgr_hash, LoadedImageCount, BCD/NVRAM parsing, PCR 12/13 attestation, and policy updates are the defensive counterparts to these academic frameworks.

## Mistakes / Corrections
- <none recorded>

## Open Questions
- <none recorded>

## File References
- docs/research/STUDY-ACADEMIC-FIRMWARE-SECURITY.md
- /tmp/devin-overflows-1000/cbfa3a73/content.txt
- /tmp/devin-overflows-1000/bcb8e444/content.txt
- /tmp/devin-overflows-1000/27c0f2df/content.txt

## Optional Fields (applied to consolidated memories)
- evidence_sources: paper:arXiv 2311.03809 (SoK UEFI), paper:arXiv 2601.07402 (Peacock), paper:arXiv 2501.16962 (UEFI Memory Forensics), paper:USENIX Security 06 vTPM, paper:USENIX Security 16 fTPM, paper:USENIX ATC 25 TLS+Attestation, standard:NIST SP 800-155, standard:TCG PC Client FIM, standard:RFC 9683, report:Eclypsium BootHole, report:Binarly Signed and Dangerous
- impact: PBL policy, attestation, and detection design
- response: Next: Conference talks on firmware security (Source 8)
