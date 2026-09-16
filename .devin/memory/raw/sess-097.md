# Session Capture — 2026-09-15 — sess-097

## Context
- Task: Study Intel platform security: Boot Guard, TXT, PTT/CSME (Source 4)
- Environment: <not specified>
- Duration: <not specified>

## Decisions Made
- <none recorded>

## Actions Taken
- Downloaded and text-extracted six Intel PDFs to /tmp/intel-docs/.
- Inspected PBL platform-state and decision code.
- Wrote consolidated study note docs/research/STUDY-INTEL-PLATFORM-SECURITY.md.
- Closed session and captured memory.

## Outcomes
- What worked: <not recorded>
- What failed: <not recorded>
- What was unexpected: <not recorded>

## Learnings
- Intel Boot Guard roots trust in CPU microcode/ROM and ME/CSME FPFs; FIT at 0xFFFFFFC0 points to ACM, Key Manifest, IBBM; IBB verified before reset vector.
- Boot Guard modes: Measured Boot, Verified Boot, combined; Enforcement_Policy 00=do nothing, 01=shutdown timeout, 11=immediate.
- Intel TXT provides DRTM via SMX, GETSEC[SENTER], SINIT ACM, MLE; extends into TPM PCRs 17-23; protects MLE with DPR and VT-d PMR.
- PTT is an integrated/firmware TPM 2.0 inside CSME/ME; CSME is an isolated PCH subsystem with its own secure boot and anti-rollback.
- PBL can only collect indirect signals: SPI HSFS/PRR, UEFI KernelDmaProtection, MOR, HECI PCI presence, SBAT, custom SVN variable.
- PBL cannot inspect Boot Guard FPFs, CSME firmware integrity, or TXT state from UEFI; these checks assume an underlying trustworthy platform.
- PBL-DEBT-LEDGER.md has an internal inconsistency: summary table marks D-121..D-128 CLOSED while detailed sections still say OPEN.

## Mistakes / Corrections
- <none recorded>

## Open Questions
- <none recorded>

## File References
- docs/research/STUDY-INTEL-PLATFORM-SECURITY.md
- /tmp/intel-docs/bootguard.txt
- /tmp/intel-docs/txt_mle2.txt
- /tmp/intel-docs/txt_enabling.txt
- /tmp/intel-docs/txt_whitepaper.txt
- /tmp/intel-docs/ptt.txt
- /tmp/intel-docs/csme.txt
- firmware/PblPkg/PblApp/PblApp.h
- firmware/PblPkg/PblApp/SpiProtections.c
- firmware/PblPkg/PblApp/DmaProtection.c
- firmware/PblPkg/PblApp/AmtCheck.c
- docs/adr/PBL-C4-Policy-Blob.md

## Optional Fields (applied to consolidated memories)
- evidence_sources: paper:Safeguarding rootkits: Intel BootGuard (Alexander Ermolov, 2016), spec:Intel TXT MLE Developer\u2019s Guide 315168-005, whitepaper:Intel Platform Trust Technology, whitepaper:Intel Converged Security and Management Engine
- impact: PBL platform-state checks, D-121..D-130, Intel-rooted trust vs. UEFI indirect signals
- response: Next: Windows NT internals / ReactOS / authorized Microsoft documentation (Source 5)
