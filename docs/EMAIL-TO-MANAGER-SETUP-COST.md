# Draft email to management — setup cost (plain version)

**To**: [Manager]
**Subject**: Cost to set up our first client — about KES 2,000–6,600 a month, plus one certificate

---

Hi [Manager],

You asked what it costs to set this up for a client company. Here it is in plain numbers.

**The short version:** we can run a client for a few thousand shillings a month. The main one-off cost is
a certificate so Windows trusts our installer. Everything else is staff time.

## What it costs to run each month

| Devices | Monthly cost |
|---|---|
| Up to 25 | **KES 2,100** |
| 50 | **KES 3,600** |
| 100 | **KES 6,600** |
| 1,000 (later, after one upgrade) | **KES 11,000** |

That includes the cloud account, the certificate and the domain name. The 1,000-device figure assumes we
do one more piece of engineering first — that work is already half done and costs us nothing to finish.

## What it costs once

- **Certificate so Windows trusts our software: KES 26,000–52,000 a year.** There may be a Microsoft
  option at about KES 16,000 a year, but I must confirm we qualify — it is only offered in some countries.
- **Domain name (optional): about KES 1,600 a year.**
- **Setup time: 1–2 days** to create their account and get it live.
- **Installing on each laptop: 10–15 minutes.** This is the real effort. 100 laptops is about 3 days of
  work.

## What I need you to approve

1. **The certificate** (KES 26,000–52,000 for the year), or let me check the cheaper Microsoft option first.
2. **The first client's size.** I recommend a pilot of 25–50 devices.
3. **The sales scope.** I recommend we sell the Windows agent and the web console now, and describe the
   firmware as "coming later".

## Two things we should not promise yet

- **The firmware part is not ready to sell.** It has never been tested on a real machine. It needs a test
  laptop and the certificate first. If we sell it now and a client's IT team asks for proof, we don't have
  it.
- **Our installers are not yet signed**, so Windows shows a security warning when someone downloads one.
  For a company this is not a problem, because we install through their IT system, where that warning never
  appears. Signing the installers is still worth doing, which is why it is in the list above.

## Recommendation

Approve the certificate and a pilot of 25–50 devices. First-year cost outside our own staff time is roughly
**KES 45,000–70,000**. It scales to 1,000 devices for about KES 11,000 a month.

I can walk you through any of this whenever you have ten minutes.

Best,
[Your name]

---

## Appendix — detail, if he asks

Currency: Kenyan shillings, converted at the Central Bank rate of KES 130.06 per US dollar (26 November
2026). The cloud provider bills in dollars, so the shilling figures move with the exchange rate.

Hosting alone, by fleet size: 25 devices KES 754 · 50 KES 2,159 · 100 KES 5,161 · 325 KES 19,857 ·
1,000 KES 64,609. After the planned database upgrade: 100 devices KES 843 · 325 KES 2,897 ·
1,000 KES 9,723. Each device adds about KES 66 a month today, about KES 10 after the upgrade.

The certificate line assumes a conventional public certificate. Apple charges USD 99 a year if we ever sell
the Mac version of the console.

The full model, with the assumptions it is built on, is in `docs/COMPANY-SETUP-COST.md`. The deployment
steps for a client's IT team are in `docs/WINDOWS-DEPLOYMENT.md`.
