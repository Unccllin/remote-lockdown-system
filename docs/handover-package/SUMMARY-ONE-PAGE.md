# Remote Lockdown System — Handover Summary

**One page. Everything in one place. All figures in Kenyan shillings.**
24 November 2026 · [Recipient Legal Name] · Private and Confidential

VAT at 16% is included where it is a real cost. No foreign currency appears in this summary.

---

## 1. What you get

| Item | What it is |
|---|---|
| The System | Server and API, dashboard, Windows service agent, administration shell, serverless option, firmware component |
| The keys and accounts | 20 credentials accounted for: 7 critical ones transferred under sealed two-person custody, 13 re-issued to you |
| Two test machines | The devices that produced the hardware evidence, handed over with their firmware state recorded |
| The evidence | Signed artifacts proving 11 of 13 capabilities on real hardware, transferable and reproducible |
| The documents | Deployment, disaster recovery, backup and restore, code signing, access control, security architecture, data-protection assessment, privacy notice, terms |
| Three months of shadow support | Your team leads, we advise, ending when your team runs it unaided |

## 2. What you must supply

| Item | Why it is yours |
|---|---|
| A server host and backup target you own | You must own the infrastructure, not receive an image |
| A domain name and DNS control | The address is embedded in every installer you generate |
| A code-signing identity in your own name | Identities are issued to an entity; yours must be yours |
| A sacrificial machine and a recovery plan | Two firmware-level tests are destructive and have never been run live |
| Data-protection registration and an employee-monitoring notice | These are the data controller's obligations, and they attach to you |
| Nine named owners and five signed acceptances | Sections 5, 6 and 7 below |

## 3. What it costs

#### One-off, paid to third parties

| Line | KES |
|---|---|
| Sacrificial machine for the two firmware tests | 52,000 – 117,000 |
| Penetration test by a Kenyan firm | 175,000 – 300,000 |
| Legal: data-protection pack and employee-monitoring notice | 150,000 – 400,000 |
| Data-protection registration | 4,000 – 40,000 |
| Build host for the macOS administration shell (only if you ship it) | 77,900 |
| **Subtotal** | **381,000 – 935,000** |

#### Every year after that

| Line | KES |
|---|---|
| Server host, local cloud, 2 vCPU / 2 GB / 40 GB | 24,000 – 30,000 |
| `.co.ke` domain including VAT | 1,740 |
| TLS certificates | 0 |
| Code-signing service including VAT | 18,100 |
| macOS code-signing membership including VAT (only if you ship the shell) | 14,960 |
| Serverless edge deployment including VAT (only if used) | 9,050 |
| Email and chat alerting including VAT | 27,150 – 36,200 |
| Location lookup | 0 while under 10,000 lookups a month |
| Source hosting, and all build and monitoring tools | 0 |
| Spares and maintenance | 26,000 |
| **Subtotal** | **97,000 – 136,000** |

#### What you pay us

| Line | KES |
|---|---|
| Transfer delivery: escrow ceremony, account migration, knowledge transfer, two hardware windows, three months shadow support (13–19 days) | 195,000 – 665,000 |

**Year one, everything: KES 576,000 – 1,600,000. Then KES 97,000 – 136,000 a year.**

Any licence fee for the software itself is a separate agreement and is not included above. An indicative
local band, to be agreed separately: **KES 4,500 – 7,800 per device per year**, or **KES 13,000 – 19,500**
if bundled with full device management. If you need an independent attestation of controls, that is a
separate programme of **KES 2,300,000 – 19,000,000** and is priced in the cost schedule.

## 4. What is proven, and what is not

**Proven on real hardware — 11 of 13:** file encryption · file decryption · workstation lock · lock
enforcement · command acknowledgement · unlock and recovery · location reporting · deadman switch ·
lockdown effectiveness · offline command queue · signed automatic update.

**Not run on real hardware — 2 of 13:** boot-configuration lockdown and firmware password lockdown. Both
are implemented and pass unit and emulated tests. Both change state a failed run cannot undo, so they are
reported as unit-tested and never as hardware-verified.

**Three limits you should plan around:**

1. Firmware persistence uses the trusted-platform module's platform hierarchy. On machines whose firmware
   randomises or disables that, the firmware path is unavailable and software control is what remains.
2. Where encryption state cannot be confirmed, a device is reported as not encrypted. That is a reporting
   limitation, not an enforcement one.
3. A service-based install reports network address rather than wireless access point identifiers, because
   the platform reserves precise location for consented interactive processes. Plan precision accordingly.

**Not present today:** single sign-on, multi-factor authentication, multi-tenancy, licence enforcement,
audit export, and any independent attestation. All are in the remediation plan with sequenced effort.

## 5. Three decisions before work starts

1. **Does the existing database transfer?** Yes — four keys travel with it under sealed custody, and the
   transfer becomes a personal-data event with notice obligations. No — fresh keys, fleet enrolled from
   scratch, but the update-signing key still transfers because devices already trust it.
2. **Do you accept the two dependencies with a use-restricting licence?** Replace them before transfer, or
   have counsel sign the acceptance. This is the item most likely to stop the transaction late.
3. **Will you name a sacrificial machine** for the two destructive firmware tests, with a recovery plan?

## 6. Five acceptances, signed by you

| Acceptance | What you are accepting |
|---|---|
| Licence position | Two dependencies restrict use and are not open-source approved: replace or accept |
| Hardware ceiling | 11 of 13 proven on hardware; the other 2 stay unit-tested |
| Access gap | No single sign-on and no multi-factor authentication at transfer, with a dated plan |
| Monitoring policy | Who may use tracking or lockdown against an individual, and under what policy |
| Data flow | Whether the database transfers, and therefore which keys travel |

## 7. Nine owners you must name

Authority to lockdown · authority to sign an update, two approvers · key custody, two people ·
on-call response · backup restore drill, quarterly · hardware verification windows · build and test sweep
before each release · employee-monitoring and data protection · incident response and security contact.

## 8. Timeline and next step

| Phase | Weeks | Exit condition |
|---|---|---|
| Decisions | 0–2 | Three decisions signed |
| Escrow and accounts | 2–4 | Custody schedule countersigned |
| Reproduction | 4–7 | Your team builds and verifies it unaided |
| Shadow operation | 7–15 | Two hardware windows and one restore drill run by your team |
| Handover | 15–16 | Nine owners named, five acceptances signed, our access revoked |

**Next step:** a sixty-minute scoping session with your security and platform leads. We then issue the
three decisions as a two-page sign-off, and Phase 1 begins the following week.
