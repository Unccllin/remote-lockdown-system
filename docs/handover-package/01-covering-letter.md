**Private and Confidential — Commercial in Confidence**

[Company Letterhead / Date: ____ / Reference: HND-2026-11-24]

To: The Chief Information Security Officer / Chief Information Officer
[Recipient Legal Name]
[Address]

**Subject: Transfer of the Remote Lockdown System — product, credentials and operating responsibility**

Dear [Name],

We are proposing to transfer the Remote Lockdown System ("the System") to [Recipient Legal Name] in a
condition where your team can operate, maintain and extend it without us. This letter sets out what you
would receive, what you must supply, what it costs, and the three decisions we need from you before any
transfer work begins.

**What the System does.** It remotely locks, tracks and recovers managed Windows endpoints. An agent runs
as a Windows service, stays reachable when no user is logged on, and carries out lockdown, data
encryption, location reporting and recovery on command. A web dashboard and API drive the fleet, keep an
audit record of every action, and support further capability at the firmware level for machines where
software-only control is not durable enough.

**What you receive.** The complete System: server and API, dashboard, Windows agent, desktop shell for
administrators, serverless deployment option, firmware component, the verification and test harnesses
that prove each capability, and the full documentation set. Alongside it we hand over the credential and
key inventory, the account ownership, the physical test machines, and a written record of what is proven
on real hardware and what is not.

**What you must supply.** An owner for each operating obligation, a sacrificial machine for the two
firmware-level tests we have deliberately never run on live hardware, and the accounts and legal
decisions that belong to your entity rather than ours. Section 3 of the enclosed handover document lists
these precisely.

**Headline cost.** Two figures, and it matters that they are kept apart.

1. *What you pay us* for the transfer itself — escrow ceremony, account migration, knowledge transfer,
   three months of shadow support and two hardware verification windows: **KES 195,000 – 665,000** at
   Kenyan professional rates, or **KES 1,470,000 – 3,230,000** if you require delivery at international
   consultancy rates.
2. *What you will spend with third parties* to run it: **KES 97,000 – 136,000 per year** for hosting,
   code signing, domain, alerting and maintenance, plus a one-off **KES 381,000 – 935,000** for the
   penetration test, data-protection registration, legal instrument and the sacrificial machine.

Estimated programme cost in year one, excluding any licence fee for the software itself:
**KES 576,000 – 1,600,000** on local rates.

**Three decisions we need before work starts.**

1. **Does the existing database transfer?** If yes, four encryption keys travel with it under sealed
   escrow and the transfer becomes a personal-data event with its own notice obligations. If no, we
   generate fresh keys and your fleet is enrolled from scratch — but the agent update-signing key must
   still transfer, because every device already deployed trusts that key and nothing else.
2. **Do you accept the third-party licence position?** Two interface dependencies are under the
   Hippocratic Licence 2.1, which restricts use and is not OSI-approved. Either we replace them before
   transfer or your counsel signs an explicit acceptance. This is the single item most likely to stop
   the transaction late, so we would rather it were decided early.
3. **Will you name a sacrificial machine** for the firmware boot-configuration and firmware-password
   tests? A failed run on those two can require a manual visit to the machine's BIOS. We have never run
   them on live hardware for that reason, which is why we report 11 of 13 capabilities as
   hardware-verified rather than 13 of 13.

**What we are not claiming.** The System has no single sign-on and no multi-factor authentication for
administrator accounts today; administrators authenticate with a local username and password. It is
single-tenant. It has no licence or entitlement mechanism, so any commercial model must be decided before
one can be built. A penetration test has not been performed on it, and it holds no SOC 2 or ISO 27001
attestation. We would rather you heard all of that from us, in writing, than from your own assessment.

**Next step.** A sixty-minute scoping session with your security and platform leads, after which we will
issue the decisions above as a two-page sign-off. On signature, the escrow and account migration begin
and the first hardware window is booked. We expect the full transfer, including three months of shadow
support, to complete within sixteen weeks of sign-off.

Enclosed with this letter: the handover document, the key custody and transfer schedule, the cost
schedule, the acceptance and sign-off form, and the remediation plan for the capability gaps named above.

Yours faithfully,

_____________________________
[Name], [Title]
[Organisation]

Enclosures: 1. Handover document · 2. Key custody and transfer schedule · 3. Cost schedule ·
4. Acceptance and sign-off form · 5. Remediation plan
