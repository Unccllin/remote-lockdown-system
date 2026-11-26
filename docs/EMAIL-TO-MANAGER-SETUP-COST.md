# Draft email — setup cost for a client deployment

**To**: [Manager]
**From**: [Your name]
**Subject**: What it costs to stand up a client deployment — and the three decisions I need

---

Hi [Manager],

Following the readiness review, here is what it actually costs to put Remote Lockdown into a client
company, and what I need you to decide. All figures are Kenyan shillings, converted at the CBK rate of
**KES 130.06/USD (26 Nov 2026)** — the hosting provider bills in dollars, so a move in the rate moves
this line, and I've kept the USD basis in brackets so it stays checkable.

**The headline: hosting is not the expensive part.** At the fleet sizes we're talking about for a first
client, the whole platform costs less than a mid-range laptop per month. The real costs are one-off
(signing certificate, setup labour) and the commercial decisions around them.

## 1. Recurring platform cost (all-in, per month)

| Devices | Hosting | + signing + domain | After the database upgrade* |
|---|---|---|---|
| 10 | KES 650 | **KES 2,081** | — |
| 25 | KES 754 | **KES 2,185** | — |
| 50 | KES 2,159 | **KES 3,590** | — |
| 100 | KES 5,161 | **KES 6,592** | KES 2,274 |
| 325 | KES 19,857 | **KES 21,288** | KES 4,328 |
| 1,000 | KES 64,609 | **KES 66,040** | KES 11,154 |

\* The right-hand column is the same fleet after the database migration already staged in the code. It is
a code change, not a purchase, and it cuts the biggest bill (at 1,000 devices) by roughly six times.

Marginal cost is about **KES 66 per device per month** today, falling to about **KES 10** after that
migration — so pricing per device is defensible from day one.

## 2. One-off costs

| Item | Cost | Notes |
|---|---|---|
| Windows code-signing certificate | **KES 26,000–52,000/year** ($200–400) | Using a public CA. Microsoft's cheaper managed service (~$10/month) is listed for organisations in USA/Canada/EU/UK only — I need to confirm whether we qualify before we buy |
| Domain name (optional) | ~KES 1,600/year | Without it the console runs on a provider subdomain |
| Apple developer account (only if we sell the Mac console) | KES 12,900/year | |
| Setup labour | ~1–2 days | Account, deployment, secrets, first admin — done once |
| Per-device install labour | **10–15 minutes per device** | This dominates a rollout: 100 devices ≈ 3 working days of IT time |

## 3. What is already done (so we are not starting from zero)

- The first public release is published and installable, with checksums and auto-update manifests.
- All five security findings from the external review are closed and tested — including the two that
  would have blocked a client deployment (an open first-admin setup path, and a route that let a stolen
  laptop re-key itself).
- Automated encrypted backups run nightly and have been restored once in a drill to prove it works.
- A cost model built from the code's actual behaviour, not estimates — it is in the repo as
  `docs/COMPANY-SETUP-COST.md` and it corrected an earlier figure that was wrong by a factor of six.

## 4. What it does **not** include — the honest part

1. **Firmware protection is not shippable yet, and should not be sold as a feature.** It has never run on
   real hardware; three tracked items (D-129, D-130, D-134) need a physical test machine and a signing
   certificate. Presenting it as a premium tier today would be a claim we cannot evidence, and it is the
   one part of this product a client's security team will interrogate hardest.
2. **Builds are unsigned**, so a downloaded installer shows a Windows security prompt. The fix for a
   company deployment is not our signature — it is that we install through their management tooling, where
   that prompt never appears. Signing still matters (it is required on newer Windows configurations and
   for update integrity), which is why it is in the table above.
3. **Anti-virus will flag us** before a client's security team reclassifies us. That is a vendor-relations
   task (allowlisting, Microsoft vendor programme), not a purchase — but it costs calendar time, and it
   should start before the first client, not after the first quarantine.
4. **No licence/entitlement control and no MFA/SSO.** If a client stops paying, nothing switches off; and
   larger clients' IT will ask for single sign-on. Both are product decisions, not setup costs.

## 5. What I need from you

1. **Approve a signing certificate** for the current year (KES 26,000–52,000), and let me first check if
   the cheaper Microsoft option is open to us — that could cut it to about KES 16,000/year.
2. **Choose the first client's likely fleet size.** Up to 50 devices the platform runs at under
   KES 3,600/month all-in. Above about 100 devices I would want the database migration finished first,
   which is engineering time, not money.
3. **Confirm the commercial scope**: my recommendation is to sell the Windows agent and cloud console
   today, and describe firmware as roadmap. That is the version I can evidence end to end.

## Recommendation

Approve the signing certificate and a pilot at **25–50 devices**. Expected first-year cost beyond labour
is roughly **KES 45,000–70,000** (certificate + hosting + domain), and the platform scales to 1,000
devices for about KES 11,000/month once the migration lands. I'd hold firmware out of any commitment
until it has run on real hardware.

Happy to walk through the numbers or the deployment plan (`docs/WINDOWS-DEPLOYMENT.md`) whenever suits.

Best,
[Your name]
