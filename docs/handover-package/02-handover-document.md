# Handover Document — Remote Lockdown System

**Document**: HND-02 · Version 1.0 · 24 November 2026
**Recipient**: [Recipient Legal Name]
**Classification**: Private and Confidential — Commercial in Confidence

---

## 1. Executive summary

The Remote Lockdown System is a remote lockdown, tracking and recovery platform for managed Windows
endpoints. It consists of a server and API, an administrative dashboard, a persistent Windows service
agent, a desktop administration shell, an optional serverless deployment, and a firmware-level component
for machines where software-only control is not durable enough.

This document describes what transfers, what the recipient must supply, what has been proven and how, and
what has explicitly not been proven. It is written to be sufficient on its own: a reader who has never
seen the System should be able to decide, from this document plus documents 3 to 6, whether they can
operate it.

Four statements are deliberately prominent, because a handover that hides them transfers risk instead of
capability:

1. **11 of 13 enforcement capabilities are verified on real hardware.** The remaining two change boot or
   firmware state in a way a failed run cannot reverse, and have never been executed on live hardware.
2. **There is no single sign-on and no multi-factor authentication for administrator accounts.** Access is
   a local username and password with role-based authorisation and a full audit trail.
3. **There is no licence or entitlement mechanism.** Any commercial model must be decided before it can be
   built; none is implied by this transfer.
4. **Two interface dependencies carry a licence that restricts use** and is not OSI-approved. Counsel must
   either replace them or accept them in writing.

---

## 2. What the System consists of

| Component | What it is | Runs on |
|---|---|---|
| Server and API | REST API, authentication, command queue, audit ledger, alerting, backup and retention schedulers | Linux, containerised |
| Dashboard | Administrative interface: fleet view, commands, audit, locations, hardware reports | Browser, served by the server |
| Agent | Persistent Windows service; executes lockdown, encryption, location reporting, recovery, deadman switch, auto-update | Windows endpoints |
| Administration shell | Desktop application wrapping the dashboard for administrators | Windows, macOS |
| Serverless transport | Cloud-hosted API surface for deployments without a local server | Cloud edge platform |
| Firmware component | Pre-boot lockdown application and persistence module for firmware-level durability | UEFI, Secure Boot signed |
| Installers | Device enrolment installers, generated per device with pinned server address and update key | Windows |
| Verification harnesses | Automated suites proving each capability, including a hardware test harness that produces signed evidence artifacts | Development and test machines |

---

## 3. What you receive

| Deliverable | Form | Evidence that it is usable |
|---|---|---|
| Source code and history | Repository transferred to your organisation | You build it and your own tools read it |
| Credential and key inventory | Document 3, plus machine-readable form | Every key accounted for, none with an unrecorded owner |
| Account ownership | Nine accounts transferred or re-issued | You can issue a release without us |
| Physical test machines | Two machines handed over with documented firmware state | You can run a hardware verification window |
| Hardware evidence | Signed artifacts per verified capability | You can reproduce the claim, not just read it |
| Documentation set | Deployment, disaster recovery, backup and restore, code signing, access control matrix, security architecture, data-protection assessment, privacy notice, terms | Your team can deploy, restore and sign without asking us |
| Verification procedure | Reproducible full build-and-test sweep | It passes on your machine, unaided |
| Written statement of limits | This document, sections 6 and 8 | Nothing is implied that is not stated |

---

## 4. What you must supply

| Item | Why it is yours and not ours | Needed by |
|---|---|---|
| A server host (your estate or your cloud account) | You must own the host, the volume and the backup target, not merely receive an image | Phase 1 |
| A domain name and DNS control | The administrative address is embedded in every installer you generate | Phase 1 |
| A code-signing identity in your legal entity's name | Signing identities are issued to an entity; yours must be yours | Phase 1 |
| An Apple developer membership, if the macOS administration shell is to be distributed | Same reason | Phase 1 |
| A sacrificial machine with a documented recovery plan | Two capabilities are provably destructive to boot and firmware state | Phase 2 |
| A data-protection registration and an employee-monitoring notice | These are the controller's obligations, and they attach to you on transfer | Phase 1 |
| Named owners for nine operating obligations | Document 5, section 3 | Phase 4 |
| Decisions on the five acceptances | Document 5, section 2 | Phase 0 |

---

## 5. Security model in brief

- **Device authentication** is per-device: each enrolled device holds its own key, and the server stores
  only a peppered hash of it. A shared transitional key exists for devices enrolled before per-device
  keys and can be retired once no such device remains.
- **Request signing** is available and can be required, using a signed timestamp and a replay-protection
  nonce cache. Requiring it is a configuration decision you make at deployment; the System supports
  either mode.
- **Data at rest** is encrypted for sensitive fields and, separately, for location records — deliberately
  two keys with two blast radii, so a single compromise does not expose both.
- **Audit** is append-only and records every administrative action with the acting account.
- **Agent updates are signed**, and the signing public key is pinned into each device at enrolment.
  Devices without a pinned key will say so at check-in rather than fail silently.
- **Recovery** uses a key domain separate from update signing, on purpose.

---

## 6. What is proven, and what is not

### 6.1 Verified on real hardware — 11 of 13

| Capability | What the evidence shows |
|---|---|
| File encryption | Files encrypted on a live device, key material handled as designed |
| File decryption | Recovery restores access without data loss |
| Workstation lock | Lock holds against a sign-in attempt |
| Lock enforcement | A process attempting to bypass the lock is terminated and the lock re-established |
| Command acknowledgement | Device acknowledgement is received and recorded end to end |
| Unlock and recovery | Recovery command restores a working device |
| Location reporting | Reporting flow verified, including the network-based lookup path |
| Deadman switch | Offline condition triggers the configured action |
| Lockdown effectiveness | The lockdown state is observable and sustained |
| Offline command queue | Commands issued while offline execute on reconnection |
| Automatic update | A signed update is delivered, verified against the pinned key and applied |

Each of these has an artifact recording the machine state, the agent binary hash and the outcome. The
artifacts transfer with the System.

### 6.2 Not verified on real hardware — 2 of 13

| Capability | Why it has not been run |
|---|---|
| Boot-configuration lockdown | It rewrites the machine's boot configuration. A failed run can leave the machine unable to boot, and its own rollback is not sufficient to guarantee recovery |
| Firmware password lockdown | It sets a firmware setup, power-on or drive password. A rejected write can require a manual visit to the machine's BIOS, or a service intervention |

These two are implemented and verified in unit and emulated tests. They are reported as
**verified-in-unit-test**, never as hardware-verified. Promoting either requires a machine you nominate as
sacrificial and a recovery plan you accept in advance; we will not run them otherwise.

### 6.3 Documented technical limits

- **Firmware persistence and the TPM.** The firmware component stores its persistent state in the TPM
  platform hierarchy, which is the production default. Firmware that randomises the platform
  authorisation value, or disables the platform hierarchy, will remove that storage; an owner-hierarchy
  alternative exists but was written as an emulation fallback and is not the default. On such machines
  the firmware-persistence path must be treated as unavailable, and software-level control is what
  remains.
- **BitLocker state reporting.** Where boot configuration cannot confirm encryption state, the System
  reports the device conservatively — that is, as not encrypted. This is a reporting limitation, not an
  enforcement one: it can make an encrypted device look unencrypted in the dashboard.
- **Firmware component validation.** The firmware component is validated in emulation with a software
  TPM, and its wire format and parsing are pinned by host-side tests. It has not been validated on
  production firmware, and it should not be described as firmware-verified until it is.
- **Location precision by install type.** A service-based install reports network address rather than
  wireless access point identifiers, because the platform restricts precise-location calls to
  interactive, consented processes. This is a platform constraint, measured and documented, not a defect.
  Plan location precision accordingly.

---

## 7. Legal and compliance position

**Ownership.** The source code is proprietary, all rights reserved. The transfer instrument is a separate
agreement; this package describes the technology and the operating obligations, not the terms of sale.

**Third-party licence restriction.** Two interface-mapping dependencies are licensed under the Hippocratic
Licence 2.1. That licence restricts use and is not OSI-approved. Two paths are open and both are
acceptable; what is not acceptable is neither: replace the two dependencies before transfer, or have
counsel sign the acceptance in document 5. This is already recorded as an open product decision, not a
discovery made during diligence.

**Data protection.** The System processes personal data: account identities, device identifiers, location
records and audit history. On transfer you become the controller. Three consequences follow and are your
work, not ours:

1. Registration with the data-protection authority before processing employee or location data, at the
   tier that matches your size.
2. A lawful basis and a written notice covering monitoring of staff devices, agreed with your employee
   representatives or works council where that applies.
3. A decision, recorded in writing, on whether the existing database transfers. If it does, four keys
   travel with it and the transfer is itself a personal-data event requiring notice; if it does not, the
   fleet is enrolled afresh and only the update-signing key must move.

**Cross-border transfer.** Hosting in your own jurisdiction avoids a transfer analysis. Hosting abroad
requires one. The cost schedule prices the local option and notes the difference.

**Export and dual use.** The System includes firmware components and endpoint control capability. You are
responsible for determining whether your jurisdiction requires an export authorisation for the jurisdictions
in which your devices operate.

---

## 8. Operating obligations

Nine obligations are owed continuously, and each needs a named person before the transfer completes.
They are listed with their cadence in document 5, section 3. Two deserve emphasis here:

- **Authority to sign an agent update** is standing authority to change the software on every enrolled
  device at once. It requires two approvers, not one.
- **Authority to issue a lockdown** is authority to disable a person's workstation. It requires a named
  incident commander, a deputy, and an audit trail that is reviewed.

---

## 9. Acceptance criteria for the transfer

The transfer is complete when all of the following are true, demonstrated by your team, unaided:

1. The System builds and its full verification sweep passes on your machine.
2. An encrypted backup is restored onto a clean host and opened.
3. A signed update is produced, verified, and accepted by a device holding the pinned public key.
4. One hardware verification window completes and produces an evidence artifact that names a capability.
5. Every key in document 3 is in your custody with two-person access and a recorded custodian.
6. All nine obligations have a named owner, and all five acceptances are signed.
7. Our access to your environments is revoked and confirmed revoked in writing.

---

## 10. Explicitly out of scope

- Any licence fee, subscription or revenue share for the software itself. Pricing of the System is a
  separate commercial negotiation and is not implied by any figure in this package.
- Single sign-on, multi-factor authentication, multi-tenancy, licence enforcement and audit export. These
  are named gaps with a sequenced plan in document 6; they are not delivered by this transfer.
- Any SOC 2, ISO 27001 or equivalent attestation. None exists, and none is claimed.
- A penetration test. One is recommended and priced in document 4 so that you commission it early; it has
  not been performed.
- Ongoing product development, hosting or support beyond the three months of shadow support priced in
  document 4.
