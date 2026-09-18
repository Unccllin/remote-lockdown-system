# Fetch List — sources & artifacts the agent cannot reach

> Drop downloads into `docs/reference/` under the directories noted below.
> `*.pdf` is gitignored (by design — reference material isn't committed);
> `.md` notes about what was fetched *are* committed. Record what you got in
> the checklist at the bottom so a session can see at a glance what arrived.
>
> Directories used:
> - `docs/reference/specs/` — standards/specifications
> - `docs/reference/vendor-docs/` — Intel/HP/Microsoft documents
> - `docs/reference/books/` — book PDFs (existing convention)
> - `docs/reference/artifacts/` — generated artifacts (BCD exports, disk images, dumps)

## Tier 1 — highest value, ~30 min of clicking

### 1.1 UEFI Forum specifications (uefi.org — Cloudflare-blocked to the agent)

Site: `uefi.org` → Specifications tab → "UEFI Specifications" page.
Download these PDFs (all free, no login):

- [ ] **UEFI Specification** — latest release (2.10 or newer if posted).
  Filename is typically `UEFI_Spec_2_10_Aug29.pdf` or similar — take whatever
  is current.
- [ ] **UEFI Platform Initialization (PI) Specification** — latest (1.8+).
- [ ] **UEFI Shell Specification** — latest posted version (2.2 or newer
  errata). This is the reference the `STUDY-UEFI-SHELL.md` note was built
  around; the real spec replaces reconstruction with citable text.
- [ ] **UEFI HTTP Boot / Network Stack appendix** — only if listed as a
  separate document (usually folded into the main spec).

### 1.2 TCG specifications (trustedcomputinggroup.org — free, sometimes
asks for email registration)

Site: `trustedcomputinggroup.org` → Resource Library → search these titles:

- [ ] **TCG PC Client Platform Firmware Profile Specification** (latest)
- [ ] **TCG EFI Protocol Specification** (family "2.0", level 00 rev 13+)
- [ ] **TPM 2.0 Library Specification** — Part 3 (Commands) and Part 4
  (Supporting Routines) are the ones PBL's `TpmClient.c`/`TpmSession.c`
  need; Parts 1–2 already covered by `STUDY-TPM-2.0.md` but grab all 4 if easy.
- [ ] **TCG PC Client Specific Implementation Specification for
  Conventional BIOS** — only if trivially available (legacy-boot posture).

### 1.3 CERT advisory (kb.cert.org — blocked to the agent)

- [ ] **VU#718077** ("UEFI firmware allows unsigned code execution via
  embedded EFI shell") — save the advisory page as PDF or `.html` into
  `docs/reference/vendor-docs/`. Search `kb.cert.org` for VU#718077.

### 1.4 The one unread book

- [ ] **"Harnessing the UEFI Shell", 2nd edition** (Rothman/Zimmer/Lewis,
  De Gruyter 2017, ISBN 978-1-5015-1480-7, DOI 10.1515/9781501505751).
  Check `degruyterbrill.com` first — De Gruyter hosts many Intel Press
  titles **open access**; if the PDF/ePub is a free download there, grab it
  legally into `docs/reference/books/`. If it's paywalled, a purchased copy
  is legitimate too — do not use pirate sources.

## Tier 2 — vendor documentation (intel.com partially blocked)

### 2.1 Intel (intel.com / software.intel.com — search by title)

- [ ] **"Intel Active Management Technology (AMT) Implementation and
  Reference Guide"** — the HECI/MEI command reference. Needed before
  `HeciClient.c` can be written. Search intel.com for the title.
- [ ] **"Intel Trusted Execution Technology — Software Development Guide /
  Measured Launched Environment Developer's Guide"** (document 315168 if
  still posted) — TXT internals.
- [ ] **"Intel Platform Trust Technology (PTT)"** white paper — PTT-vs-dTPM
  discrimination for `AmtCheck.c`/`TpmClient.c`.
- [ ] **Intel Anti-Theft Technology** — any surviving product briefs/
  datasheets (product is EOL; archive.org copies are acceptable for
  historical mechanics). Feeds the E-DEADMAN/rendezvous design.

### 2.2 HP (hp.com / support.hp.com — public)

- [ ] **"HP Sure Admin"** documentation — white paper + WMI/BIOS setting
  reference. This is the direct input for D-127 (`AmtCheck.c` Sure Admin
  path) and E-HP-UEFI hardening.
- [ ] **HP Client Management / BIOS WMI interface guide** — the
  `SetBIOSSetting` model-aware names (D-009) live here.
- [ ] One **HP BIOS/UEFI softpaq** for the target model in the hardware
  plan — the `.exe` download from HP Support for the specific machine.
  Contains the real firmware image for cross-vendor checks.

### 2.3 Microsoft (learn.microsoft.com — probably reachable, verify)

- [ ] **BCD WMI provider / BCD object reference** — save the relevant
  learn.microsoft.com pages as PDF. Search: "BCD WMI provider",
  "BcdObjectElementType", "BCD device data". Direct input to the
  `osdevice` partition-binding work (D-120 residual).
- [ ] **BitLocker CSP + FVE metadata documentation** — any
  learn.microsoft.com pages on `Win32_EncryptableVolume`, BitLocker CSP.
- [ ] **"Secure Boot and Device Encryption" / SGRA attestation docs** —
  System Guard Runtime Attestation chain (MDM delta fact 13).

## Tier 3 — generated artifacts (you produce these, ~1 hour)

These aren't downloads — they're artifacts only a Windows machine can make.
Any Windows 10/11 PC or VM works; a Windows 11 VM with vTPM is ideal.

### 3.1 BCD hive exports (5 min on any Windows box)

```powershell
bcdedit /export C:\bcd-export
bcdedit /enum all /v > C:\bcd-enum.txt
```

- [ ] `bcd-export` (binary hive) + `bcd-enum.txt` →
  `docs/reference/artifacts/bcd/`. From **two different machines** if
  possible (different `osdevice` layouts). If the machine has BitLocker,
  even better.

### 3.2 BitLocker test image (the single most valuable artifact)

- [ ] A **Windows 11 VM** (Azure vTPM SKU, Hyper-V with vTPM, or VMware with
  vTPM) with BitLocker enabled on the OS volume. Then either:
  - export the VHD/VMDK (preferred — full disk, partitions intact), or
  - `manage-bde -status` + `manage-bde -protectors -get C:` output +
    the first 1 MB of the encrypted volume (`dd`-style sector copy via
    `\\.\PhysicalDrive` or a hex tool) →
    `docs/reference/artifacts/fve/`.
  Real FVE metadata + real `osdevice` blobs unlock D-120's remaining
  residuals (partition-level binding + real-media validation).

### 3.3 UEFI variable dumps (from a real machine's UEFI shell)

- [ ] Boot a UEFI shell (USB `BOOTX64.EFI` shell) on the target hardware:
  ```
  dmpstore -all -sfo vars.txt
  bcfg boot dump -v > boot.txt
  map -r > map.txt
  ```
  → `docs/reference/artifacts/uefi-dumps/<machine-model>/`. Real vendor
  GUID variables + real Boot#### layouts feed the shell-detection and
  HII-keyword work.

### 3.4 Hardware (bigger commitment, not this list)

The remaining gap is a physical Windows+TPM machine for D-129 and the 9
unverified enforcement paths — separate decision, see synthesis Tier-3.

## Checklist — mark what arrived

| Item | In repo? | Path |
|---|---|---|
| UEFI spec | ☐ | docs/reference/specs/ |
| PI spec | ☐ | docs/reference/specs/ |
| UEFI Shell spec | ☐ | docs/reference/specs/ |
| TCG PC Client Firmware Profile | ☐ | docs/reference/specs/ |
| TPM 2.0 Library Parts 3–4 | ☐ | docs/reference/specs/ |
| VU#718077 advisory | ☐ | docs/reference/vendor-docs/ |
| Harnessing the UEFI Shell (2e) | ☐ | docs/reference/books/ |
| Intel AMT Implementation & Reference Guide | ☐ | docs/reference/vendor-docs/ |
| Intel TXT MLE Developer's Guide | ☐ | docs/reference/vendor-docs/ |
| Intel PTT white paper | ☐ | docs/reference/vendor-docs/ |
| Intel AT briefs | ☐ | docs/reference/vendor-docs/ |
| HP Sure Admin docs | ☐ | docs/reference/vendor-docs/ |
| HP BIOS WMI guide | ☐ | docs/reference/vendor-docs/ |
| HP BIOS softpaq (target model) | ☐ | docs/reference/artifacts/firmware/ |
| BCD exports ×2 | ☐ | docs/reference/artifacts/bcd/ |
| BitLocker test image / sector dump | ☐ | docs/reference/artifacts/fve/ |
| UEFI variable dumps | ☐ | docs/reference/artifacts/uefi-dumps/ |
| MS BCD/BitLocker/SGRA docs | ☐ | docs/reference/vendor-docs/ |
