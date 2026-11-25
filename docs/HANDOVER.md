# Product Handover — everything that is not the code

**Status**: living document, `pre-transfer` · measured 2026-11-24
**Local basis**: Kenya — prices in **KES**, FX 1 USD = KES 130.09 (2026-11-24), VAT 16% incl. imported digital services (§9.0)
**Machine-readable companion**: [`handover-registry.json`](handover-registry.json)
**Gate**: `python3 scripts/check_handover.py` (pre-transfer) · `--strict` (post-transfer)

```bash
python3 scripts/check_handover.py              # exits 0 when the inventory is consistent
python3 scripts/check_handover.py --self-test  # proves the gate can actually fail
```

The registry is the source of truth; this document explains it and prices it.
If you add a secret-shaped variable to an env example without adding a custody
entry, the gate fails — that is the whole point, because the failure mode this
document exists to prevent is *a key nobody recorded*.

---

## 1. Scope: what moves, and what does not

The source history is the easy half. It is in `git`, it is reviewable, and a
new team can read it. Everything below is the half that only exists as
knowledge, credentials and people — and that is the half which is unrecoverable
when it is lost.

| Category | Count | Transferable? |
|---|---|---|
| Key domains (secrets + trust roots) | 20 (7 critical) | 7 critical ones must transfer, some by re-enrolment of the fleet |
| Accounts with an owner | 9 | Transferred or re-created by the receiving legal entity |
| Physical assets | 3 (2 exist, 1 must be supplied) | Handed over / purchased |
| Named obligations | 9 | Assigned to people at the company, not to this document |
| Written acceptances | 5 | Signed by the receiving party |

**The one fork that changes everything**: does the existing database travel?

- **Yes** → `K-AGENT-PEPPER`, `K-FIELD-ENC`, `K-LOCATION` and `K-BACKUP` travel
  with it, sealed. Moving those four is a personal-data transfer with its own
  notice obligations (`docs/GDPR_LIA.md`).
- **No** → generate fresh values and re-enrol the fleet. `K-UPDATE-SIGN` still
  has to transfer, because agents already deployed pin its public key. There is
  no "clean start" for that one without a physical re-enrolment per device.

---

## 2. Key custody sheet

Severity `critical` means *the loss cannot be undone*, so the gate refuses to
accept a critical key marked `regenerable: yes`. Full detail (purpose, loss
impact, exact transfer step) is in the registry; this is the custody view.

### 2.1 Trust roots and data keys — 7 critical

| ID | Key | Where it lives today | Loss impact | Transfer step |
|---|---|---|---|---|
| `K-AGENT-PEPPER` | Per-device API key pepper | `secrets/agent_key_pepper.txt`, env | Every `api_key_hash` becomes unverifiable → whole fleet re-enrols in person | Sealed, with the DB |
| `K-FIELD-ENC` | At-rest field encryption | `secrets/field_encryption_key.txt` | Encrypted columns unreadable forever, even from a backup | Sealed, with the DB |
| `K-LOCATION` | Location field key (separate blast radius) | `secrets/location_field_key.txt` | All historical location data unreadable — a GDPR deletion event | Sealed, with the DB — do **not** merge into `K-FIELD-ENC` |
| `K-BACKUP` | Backup encryption (AES-256-CBC) | `.env.prod`, `docs/BACKUP.md` | Every existing backup becomes an unreadable blob; DR runbook stops being executable | Sealed, with the backup set, before the first restore drill |
| `K-UPDATE-SIGN` | Agent update signing (Ed25519) + pinned public key | `docs/CODE_SIGNING.md`, env | Agents pin this key: lose it → no agent can ever be updated again | **Must transfer even if the DB does not** |
| `K-RECOVERY-ESCROW` | Recovery escrow keypair | `scripts/generate-recovery-keys.sh` | A locked device has no software unlock left | Two-person custody, never stored with `K-UPDATE-SIGN` |
| `K-SECUREBOOT` | Secure Boot / PBL platform keys | `scripts/gen-secureboot-keys.sh`, `sign-pbl.sh` | Firmware stops trusting the platform → manual enrolment visit per machine | With the D-130 signing authority ruling |

### 2.2 Everything else — re-issue rather than transfer

| ID | What | Regenerable | Note |
|---|---|---|---|
| `K-JWT` | Dashboard session signing | yes | Fresh value; admins log out once |
| `K-GH-TOKEN` | Release-download token | yes | Fine-grained, repo-scoped. Never a user PAT |
| `K-DB` | PostgreSQL access | yes | Rotate after transfer; the host must move too |
| `K-CI-AZURE-SIGNING` / `K-CI-APPLE` | Windows + macOS signing identities | yes-with-reenrolment | Tied to a legal entity; hashes change either way |
| `K-GEO-API` | Google Geolocation | yes | Losing it degrades tracking to IP quietly — re-issue and regenerate installers |
| `K-SMTP`, `K-NOTIFY-WEBHOOKS` | Alerts | yes | Re-create in the company's own domain/workspace |
| `K-GRAPH`, `K-MESHCENTRAL` | Optional inventory integrations | yes | Consent is tenant-scoped; the receiving side grants its own |
| `K-GRAFANA` | Monitoring login | yes | Ships as `admin/admin`; reset on first login |
| `K-AGENT-SHARED` | Legacy shared agent key | yes-with-reenrolment | Count legacy devices first — if zero, delete the variable |
| `K-CLOUDFLARE` | Workers account | yes | Transfer the account, not the token |

---

## 3. Accounts that must change owner

| ID | Account | Why it matters | Transfer action |
|---|---|---|---|
| `A-GITHUB` | Org + repo + 10 Actions secrets + releases | Source, CI, and the download source the server calls | Transfer repo into the company org; **re-create** secrets |
| `A-AZURE` | Subscription (Artifact Signing) | Windows signing identity + cert profile | Move subscription or re-validate identity in their tenant |
| `A-APPLE` | Developer Program | Developer ID + notarization for the Electron shell | Re-enroll under the company legal entity |
| `A-CLOUDFLARE` | Workers account | Serverless transport + its secrets | Transfer account ownership |
| `A-DOMAIN` | Registrar + DNS zone | URL baked into installers; ACME issuance | Transfer registration; TLS re-issues free |
| `A-GCP` | Geolocation API project | Billing attached to the key | Move project or re-issue + regenerate installers |
| `A-EMAIL` | Transactional email | Alert delivery | New account on the company domain (SPF/DKIM) |
| `A-M365` | Entra tenant + Graph app | Optional Intune inventory, tenant consent | Receiving tenant consents |
| `A-SERVER-HOST` | Linux host (2 GB RAM / 20 GB disk, Docker 24+) | Runs the API, PostgreSQL, Caddy | They must own host, volume **and backup target** |

---

## 4. Physical assets

| ID | Asset | Why | Action |
|---|---|---|---|
| `P-FRANKENSTEIN` | First production device (HP EliteBook, Win 11, service install) | Carries evidence for 11 of 13 enforcement paths | Hand over with documented BIOS state |
| `P-HP-TEST` | HP test unit (Sure Admin / UEFI path) | Second hardware target | Same; record where the Sure Admin credential lives, never the value |
| `P-SACRIFICIAL` | **Must be supplied by the receiving company** | `E-BCD` and `E-HP-UEFI` are unit-test-only *because* a failed run rewrites boot config or sets a firmware password needing a manual BIOS visit | Provide a named machine + written recovery plan, or accept the ceiling in writing |

---

## 5. Obligations that need a human, not a document

Nine obligations are owed continuously. None has a named person today; the
gate warns until one is recorded, and `--strict` refuses to pass without them.

| ID | Obligation | Cadence | Role |
|---|---|---|---|
| `O-LOCKDOWN` | Authority to lock or recover a device | per event | Incident commander + deputy |
| `O-UPDATE-SIGN` | Authority to sign and publish an agent update | per release | Release engineer + 2nd approver |
| `O-KEY-CUSTODY` | Custody of the 6 trust/data keys | continuous | Key custodian, sealed escrow |
| `O-ONCALL` | Response to a locked/stolen device event | continuous | Security operations |
| `O-RESTORE` | Backup restore drill | quarterly | Platform owner |
| `O-HARDWARE-WINDOW` | Real-device verification of enforcement paths | per release | Hardware test owner |
| `O-VERIFY` | Green `make full-verify` after environment change | per release | Release engineer |
| `O-PRIVACY` | Monitoring notice, lawful basis, works council | per deployment | DPO / HR legal |
| `O-IR` | Incident response + security contact | continuous | Security lead |

**Read this twice**: `O-UPDATE-SIGN` is standing remote-brick authority over
every enrolled machine. It is not a routine release permission.

---

## 6. Knowledge transfer

The repository's harness (`.devin/`) holds 346 sessions of state — graph,
memory, beliefs. It is genuinely valuable and cannot be absorbed by reading.
What a receiving team needs instead:

1. **A clean-room build.** `make full-verify` green on a machine that has never
   seen this repo. This is the single honest acceptance test for a handover.
   Prerequisites that live only in `AGENTS.md` today: Node at
   `~/.local/node/bin`, `LD_LIBRARY_PATH` for Playwright/Electron, semgrep +
   actionlint + shellcheck installed, the user in the `docker` group.
2. **The host-specific traps**, written down rather than rediscovered:
   the push gate must be `&&`, not `;`; a busy port 5173 must fail loudly, not
   reuse a stale dev server; eslint v8 needs `--ext .js,.jsx`; the `glob`
   override in `electron/package.json` must stay version-scoped (a blanket one
   *hangs* `@electron/asar` forever with no error).
3. **Fix the doc drift before they read it.** `AGENTS.md` claims 37 OPEN PBL
   debt items; `docs/adr/PBL-DEBT-LEDGER.md` actually has 5 status markers
   OPEN. A receiving team finds that on day one and stops trusting the rest.

---

## 7. Gaps a corporate owner will hit

None of these are secrets; all of them are the difference between "impressive
prototype" and "procurable product".

| ID | Gap | Blocks | Remedy |
|---|---|---|---|
| `G-SSO` | No SSO/SAML/OIDC — admins are local username/password | Enterprise procurement | OIDC/SAML path behind existing auth middleware |
| `G-MFA` | No MFA/TOTP/WebAuthn | Procurement, pen-test clearance | TOTP + recovery codes on admin records |
| `G-ENTITLEMENT` | No licence/entitlement mechanism (no activation, seats, expiry) | Any commercial model | Decide the model first; offline activation file fits on-prem |
| `G-MULTITENANCY` | Single-tenant by construction | SaaS delivery | Tenant scoping everywhere — or stay on-prem, which avoids it |
| `G-AUDIT-EXPORT` | No audit export / DSAR tooling | Works council, subject access | Read-only export over the existing audit ledger |
| `G-SBOM` | No SBOM in the release pipeline | Security review | syft / cyclonedx (free, offline-capable) |
| `G-IR` | No IR plan, no published disclosure policy | Procurement questionnaire | Write both; `docs/SECURITY.md` is the raw material |
| `G-DOC-DRIFT` | Debt count disagrees between two documents | Trust in the documentation | Reconcile |

---

## 8. The five written acceptances

Skill, not negligence, is what makes these defensible — but each one must be
signed by a named person at the receiving company, or explicitly declined.

| ID | What is being accepted | Why it cannot be skipped |
|---|---|---|
| `ACC-LICENCE` | Hippocratic Licence 2.1 on `react-leaflet` / `@react-leaflet/core` restricts **use** and is not OSI-approved | Already flagged as an open product decision in `LICENSE`. Their legal team will stop the transfer on it |
| `ACC-HW-CEILING` | `E-BCD` and `E-HP-UEFI` stay unit-test-only | 11 of 13 paths are hardware-verified; the other 2 have a documented reason and must not become an implied 13/13 |
| `ACC-SSO-GAP` | No SSO and no MFA at transfer | Dated remediation plan, or decline |
| `ACC-MONITORING-POLICY` | Who may use covert tracking / lockdown against an individual | The audit ledger is the technical answer; the policy is theirs to adopt |
| `ACC-DATA-FLOW` | Whether the existing database transfers | A controller change with its own notice obligations |

---

## 9. What everything costs

Basis tags on every line, because a price without provenance is a rumour:

| Tag | Meaning |
|---|---|
| **[V]** | **Verified price** — read from the vendor's or provider's own page on 2026-11-24 |
| **[P]** | **Published list price** — stable and well known, re-verify at purchase |
| **[R]** | **Market range** — from published price indices, not a quote |
| **[E]** | **Estimate** — needs a quote |

### 9.0 How local pricing is applied

**Local basis: Kenya. Primary currency KES, with USD/EUR shown for reference.**

| Parameter | Value | Note |
|---|---|---|
| FX rate | **1 USD = KES 130.09** · 1 EUR = KES 142.08 | open.er-api.com, 2026-11-24. Re-check before quoting: a 10% KES move changes every USD line by 10% |
| VAT | **16%** | VAT Act s.5(2). It applies to **imported digital services** too — the Digital Marketplace Supplies regime removed the B2B/B2C distinction in 2022, so a USD SaaS invoice is a 16% local cost, not a foreign one |
| Card FX markup | 3–5% | Typical on USD subscriptions paid from Kenya; not in the figures below |
| Mobile money | +3.5% | Where a provider bills through M-Pesa rather than a card |
| VAT recoverability | varies | A VAT-registered receiving company with a proper tax invoice may claim input tax; otherwise 16% is real money. Retail local prices are usually quoted **VAT-inclusive** — ask which |

Local pricing is not just a currency substitution. It changes **which vendor you
pick**, and three lines move materially:

| Line | International | Local (Kenya) | Why it moves |
|---|---|---|---|
| Server host | Hetzner CPX11 €18.49/mo ≈ **KES 2,630/mo** | Angani Linux VM, 2 vCPU / 2 GB / 40 GB — **≈ KES 2,000–2,500/mo** [V] | Cheaper, and it removes a DPA 2019 §48 cross-border transfer question instead of answering it |
| Penetration test | US median $4,950 ≈ **KES 644,000** | Kenyan VAPT: **KES 175,000–300,000** per engagement [V] | 2–4× cheaper. The caveat is real: a local report may not satisfy an international acquirer's vendor diligence |
| Engineering day rate | €800–1,200/day ≈ **KES 113,000–170,000/day** | **KES 15,000–35,000/day** [E] | Same work, local market. It cuts the handover delivery cost by roughly 5× |

Two lines do **not** move: SOC 2 (AICPA-registered, priced in USD wherever you
are) and Apple/Azure (global list prices). And one line is **new and local**:

| Line | Price | Tag |
|---|---|---|
| ODPC registration (Data Protection Act 2019 s.18 + Registration Regulations 2021) — mandatory before processing employee/location data | Small **KES 4,000** · Medium **KES 16,000** · Large **KES 40,000**, valid 2 years | [V] |

### 9.1 Scenario A — one company runs it on its own estate (100 devices)

Assumes the two existing test machines transfer with the product.

#### One-off

| Line | KES | USD | Tag | Note |
|---|---|---|---|---|
| Sacrificial boot/firmware machine | 52,000–117,000 | $400–900 | [E] | Required to ever promote `E-BCD` / `E-HP-UEFI` |
| Penetration test (local VAPT firm) | 175,000–300,000 | — | [V] | vs KES 644,000 at the US median. Scope: OWASP web app, report, retest |
| Legal: DPA 2019 compliance pack, employee-monitoring notice, cross-border assessment | 150,000–400,000 | — | [E] | Kenyan advocate. Zero only if their legal team does it in-house |
| ODPC registration | 4,000–40,000 | — | [V] | Tier depends on staff/turnover; valid 2 years |
| macOS build host (only if shipping the Electron shell) | 77,900 | $599 | [P] | Mac mini; the agent itself is Windows |

Subtotal: **KES 381,000–935,000** (≈ $2,900–7,200)

#### Recurring, per year

| Line | KES | USD | Tag | Note |
|---|---|---|---|---|
| Server host — Angani VM 2 vCPU/2 GB/40 GB (local) | 24,000–30,000 | — | [V] | Hetzner CPX11 would be ≈ KES 31,500/yr and a cross-border transfer |
| Domain — `.co.ke` renewal + 16% VAT | 1,740 | — | [V] | KES 999 first year, KES 1,500 renewal + VAT. A `.com` is $12–15 ≈ KES 1,560–1,950 |
| TLS certificates | **0** | **$0** | [V] | Caddy + Let's Encrypt |
| Azure Artifact Signing, Basic tier + 16% VAT | 18,100 | $119.88 | [V] | $9.99/mo, 5,000 signatures. Premium is $99.99/mo for 100,000; $0.005/signature over |
| Apple Developer Program + VAT | 14,960 | $99 | [V] | Only if the macOS shell ships |
| Cloudflare Workers Paid + VAT | 9,050 | $60 | [V] | $5/mo minimum, 10M requests. Only if the serverless transport is used |
| Email alerts (Resend/Postmark-class) + VAT | 27,150–36,200 | $180–240 | [P] | $15–20/mo |
| Google Geolocation API | **0** in a pilot | $0 | [V] | 10,000 free requests/mo, then ≈ KES 650 per 1,000 — re-verify, the SKU moved in 2025 |
| GitHub | 0 | $0 | [P] | Private repos free; Team is ≈ KES 6,250/user/yr |
| Semgrep OSS, Prometheus, Grafana, Node, Python | **0** | **$0** | [V] | All self-hosted |
| Spares + maintenance | 26,000 | $200 | [E] | |

Subtotal: **KES 97,000–136,000/yr** (≈ $750–1,050)

**Scenario A total: ≈ KES 478,000–1,071,000 in year one, then ≈ KES 97,000–136,000/yr.**

That is roughly **half** the same deployment priced at international list
prices (KES 950,000–2,340,000) — almost entirely because of the pen test, the
legal work and the local host.

### 9.2 Scenario B — become an enterprise vendor (adds to A)

| Line | KES | USD | Tag | Note |
|---|---|---|---|---|
| SOC 2 Type 1 (audit fee only) | 911,000–3,250,000 | $7,000–25,000 | [R] | No local price advantage — AICPA-registered firms price in USD |
| SOC 2 Type 2 (audit fee only) | 1,560,000–5,850,000 · **median 1,170,000** | $12,000–45,000 · median $9,000 | [R] | Q3 2026 quote data for 1–10 employees |
| SOC 2 **full program**, year one | 3,250,000–11,700,000 | $25,000–90,000 | [R] | Readiness + platform + audit + your own staff time |
| Compliance automation (Vanta Essentials, 1–20 employees) | 1,820,000–2,600,000/yr | $14,000–20,000 | [V] | From $14,000/yr on AWS Marketplace; median spend ≈ $20,000. Drata lists $25,000/yr platform |
| Annual penetration test (local firm) | 175,000–300,000 | — | [V] | Repeated yearly; the US index (to $30,000) does not apply here |
| ISO 27001 | 2,600,000–6,500,000 | $20,000–50,000 | [E] | **Not measured this session** — placeholder only |
| Legal: ToS, DPA, sub-processor list, cross-border review | 650,000–1,950,000 | $5,000–15,000 | [E] | |
| SBOM tooling | **0** | **$0** | [V] | syft / cyclonedx |
| Engineering: SSO + MFA + entitlement + audit export | 600,000–2,100,000 | — | [E] | 8–12 weeks = 40–60 days at KES 15,000–35,000/day. The real cost of `G-SSO`/`G-MFA`/`G-ENTITLEMENT`/`G-AUDIT-EXPORT` |

**Scenario B incremental spend, year one: ≈ KES 2,300,000–19,000,000**
— with a realistic middle around **KES 5,000,000** (Type 2 at the median, a
compliance platform, one local pen test, moderate legal, in-house engineering
at local rates).

**Two honest discounts.** If the receiving company is already SOC 2 certified,
the compliance block collapses to an incremental scope extension — typically
$5,000–15,000 (KES 650,000–1,950,000), not KES 11,700,000. And if they already
run a Microsoft tenant, `A-AZURE` and the Windows signing identity cost them
nothing incremental — they already pay for it.

### 9.3 What to charge per device (anchors, not a valuation)

Two verified comparables frame the category. This product sits closer to
Absolute's lockdown/tracking/recovery than to Jamf's device management.

| Comparable | Price | In KES | Tag |
|---|---|---|---|
| Jamf for Mac | $12.50/device/month = **$150/device/yr**, 25-device minimum | ≈ KES 19,500/device/yr | [V] |
| Absolute Resilience | $123.99–139.53/device per **3-year** term ≈ **$41–47/device/yr** | ≈ KES 5,300–6,100/device/yr | [V] |
| Absolute Resilience (education) | $110.95/device per 36 months ≈ **$37/device/yr** | ≈ KES 4,800/device/yr | [V] |

A defensible local ask is **KES 4,500–7,800/device/yr** positioned against
Absolute, or **KES 13,000–19,500/device/yr** bundled as full device management.
For 100 devices: **KES 455,000–780,000/yr** at Absolute parity,
**KES 1,300,000–1,950,000/yr** at Jamf parity.

Negotiating in KES matters on its own: a per-device price pegged to USD drifts
10% against the shilling in a bad quarter, and a Kenyan buyer will notice.

### 9.4 What it costs to *deliver* the handover

Distinct from all of the above: transferring the non-code package is itself
work, and it is the part usually left unpriced.

| Activity | Local effort cost | International-rate cost | Tag |
|---|---|---|---|
| Key escrow ceremony + account transfers + clean-room build proof | 3–5 engineer-days | same effort | [E] |
| Shadow support (3 months, part-time) | 8–12 engineer-days | same effort | [E] |
| Hardware windows on real devices | 2 engineer-days + machine time | same effort | [E] |
| **Total** | **13–19 days → KES 195,000–665,000** at KES 15,000–35,000/day | **KES 1,470,000–3,230,000** at €800–1,200/day | [E] |

Which column applies depends on who is paying, not where the work happens. An
acquirer paying European consultancy rates will not accept the local column,
and they are not wrong to — the same engineer, a different market.

### 9.5 Price caveats

- Every figure is a **price read on 2026-11-24 at the stated FX**, not a quote.
  Cloud, audit and legal providers discount heavily at contract size.
- **[R] and [E] lines are ranges on purpose.** A single number for a pen test or
  a SOC 2 audit would be a guess wearing a decimal point.
- **VAT is shown where it is a real cost** (imported SaaS) and omitted where the
  receiving company can reclaim it. Confirm their VAT position before comparing
  totals; a 16% swing dwarfs most negotiation.
- **FX is a live exposure, not a rounding error.** The USD lines are ~40% of
  Scenario A's recurring spend; if they are invoiced in USD, the KES cost is
  whatever the rate is on the day the card is charged.
- Costs that exist only because the receiving company lacks them (SOC 2, Azure,
  Apple, domain, GitHub) drop out entirely if they already have them. Price the
  **increment**, not the table.

## 10. Handover acceptance test

A handover is complete when all of these exit 0 on the receiving side's own
machine, with no help from the transferring engineer:

```bash
python3 scripts/check_handover.py                # inventory consistent
python3 scripts/check_handover.py --self-test    # gate has teeth
python3 scripts/check_licenses.py --strict       # nothing new is copyleft/unusable
make verify-env                                  # 63 environment checks
make full-verify                                 # FV_EXIT=0, all five suites + E2E
scripts/verify-signing.sh                        # release signature verifies
```

Plus three drills that are not commands but transcripts:

1. **Restore drill** — restore an encrypted backup on a clean host and open it
   (`docs/BACKUP.md`, `docs/DR_RUNBOOK.md`). Proves `K-BACKUP` moved.
2. **Update-sign drill** — sign an update, verify it, confirm an agent with the
   pinned public key accepts it. Proves `K-UPDATE-SIGN` moved intact.
3. **One hardware window** — `make hw-preflight` then `make hw-artifact`, with
   the artifact accepted by I3. Proves the evidence chain survives the move.

Then `--strict` must pass, which requires every obligation to have a named
person and every acceptance to be signed.

---

## 11. What this document deliberately does not decide

- The **price of the asset itself**. §9.3 gives anchors for per-device
  pricing; what the product is worth as a whole is a negotiation, and inventing
  a number here would be worse than leaving it open.
- Which **commercial model** the company adopts (per-device, per-admin, site
  licence). `G-ENTITLEMENT` says build nothing until that is decided.
- Whether the **Hippocratic Licence** dependency is replaced or accepted
  (`ACC-LICENCE`). Both are legitimate; silence is not.
- Whether the **database** transfers (`ACC-DATA-FLOW`). Both are legitimate;
  the key sheet differs and the legal work differs.
