# What it costs a company to run this, on their own accounts

**Measured/checked**: 2026-11-26 · **Currency**: KES with the USD source figures beside them ·
**FX**: 1 USD = KES 130.06 (CBK, 2026-11-26). Cloudflare bills in USD, so **FX is part of the
cost** — a 10% shilling move is a 10% move on this line, not a rounding error.

Prices below are from Cloudflare's published rate card read on the same date
(`developers.cloudflare.com/workers/platform/pricing`, `/kv/platform/pricing`, `/r2/pricing`,
`/d1/platform/pricing`). Two figures are marked **check** because they are third-party rates that
change without notice and I did not verify them today.

There is **no licence fee and no per-seat charge**: the company runs its own instance of this
code on its own accounts. What follows is what those accounts cost.

---

## Part A — one-off, to stand it up

| item | cost | needed? |
|---|---|---|
| Cloudflare account + Workers Paid plan | $0 to open, $5/month minimum starts on first deploy | **yes** — everything server-side lives here |
| Domain name (optional) | ~$10–15/year (.com) **check** | no: it runs on a `workers.dev` subdomain. A custom domain is branding, and it is baked into each device's `server_url`, so decide **before** enrolling devices |
| GitHub private repo + Actions | $0 on the free plan (2,000 minutes/month) | optional: only if they want the release pipeline in their own CI. One release run is ~60 billable minutes once Windows (×2) and macOS (×10) multipliers are applied — comfortably inside the free tier |
| Windows code signing (optional) | Azure Trusted Signing, ~$10/month **check**; or an OV certificate ~$200–400/year | no, but without it every Windows install shows a SmartScreen warning |
| Apple Developer Program (optional) | $99/year | no; without it the macOS DMG is unnotarised and Gatekeeper warns on first launch |
| Google Maps/geolocation key (optional) | usage-based, **not estimated here** | only for the location feature; the deployment currently ships a placeholder key |

**Labour, estimated (not measured):**

| step | effort |
|---|---|
| Create the Cloudflare account, deploy the Worker, create the first admin | 1–2 hours |
| Per device: install the agent, enrol it, confirm the first check-in | 10–15 minutes |
| Set up code signing, if chosen | 2–4 hours one-off |

A 50-device rollout is therefore roughly 1 working day of IT time, dominated by per-device
touches, not by the platform.

---

## Part B — recurring platform cost by fleet size

Assumptions, taken from the code rather than guessed: each device polls every **60 s** (43,200
check-ins per device per month), and one check-in costs **1 request, 3 KV reads, 1 KV write and 1
KV list** — the device lookup, the check-in metadata read, the metadata write and the per-device
command index (`serverless/agent-routes.ts`, `handleAgentCheckin`). Included allowances are 10M
requests, 10M reads, 1M writes and 1M lists per month.

| devices | $/month | KES/month | $/device | KV reads / writes per month |
|---|---|---|---|---|
| 2 (today) | 5.00 | **650** | 2.50 | 0.3M / 0.1M |
| 10 | 5.00 | **650** | 0.50 | 1.3M / 0.4M |
| 25 | 5.80 | **754** | 0.23 | 3.2M / 1.1M |
| 50 | 16.60 | **2,159** | 0.33 | 6.5M / 2.2M |
| 100 | 39.68 | **5,161** | 0.40 | 13.0M / 4.3M |
| 325 | 152.67 | **19,857** | 0.47 | 42.1M / 14.0M |
| 1000 | 496.76 | **64,609** | 0.50 | 129.6M / 43.2M |

Marginal cost is flat at about **KES 66 per device per month** because the expensive meter is the
KV **write/list** at $5 per million — 50× the price of a read.

Storage is not what drives this: the four binaries in KV total 51 MB against a 1 GB allowance,
the database is 112 KB, and R2 keeps its first 10 GB and all egress free, so backups (two ~41 KB
objects so far) are free at any realistic fleet size.

---

## Part C — the number that changes the shape of the bill: finishing the D1 cutover

Stage 0 of the D1 migration is **live as of 2026-11-26** (see `docs/SERVERLESS-D1-CUTOVER.md`):
the relational store exists, the schema is applied, and replay protection now writes there. What
is *not* done is moving the device/command reads and writes off KV — and those are the two meters
that scale.

| devices | now (KV) | after the cutover (D1) | saving |
|---|---|---|---|
| 100 | KES 5,161 | KES 843 | 6.1× |
| 325 | KES 19,857 | KES 2,897 | 6.9× |
| 1000 | KES 64,609 | KES 9,723 | 6.6× |

D1 includes 50 million rows written per month against KV's 1 million at five times the unit price,
which is the whole reason the crossover moves. The cutover is staged and each stage has a check
that can fail; the ceiling it removes binds above roughly 1,100 devices (50M rows ÷ 43,200
check-ins), not today.

---

## Part D — where this differs from the figure in `docs/SERVERLESS-COST.md`

That document states serverless stays cheaper than a local VM up to about **325 devices**. With
the per-check-in operations above, the crossover against a KES 2,000–2,500 local host arrives at
about **45–55 devices**: at 50 devices this deployment is already at KES 2,159 a month, and at 100
it is KES 5,161 — twice the VM it replaces.

Both figures are reproducible; they differ because of what is counted. The older figure predates
S348's fix to the check-in path and its arithmetic is stated in terms of a single read per poll,
not the write and list per poll that the current code performs. **Do not quote the 325 figure to a
customer.** The table in Part B is the one built from the code as it runs today, and even that is a
model: the first thing to do after a real rollout is read the monthly KV counters in the Cloudflare
dashboard and replace the assumption with a measurement.

---

## Part E — what to check before signing a budget

1. Re-read the four Cloudflare pricing pages — the rate card moves, and the KV write price is the
   whole bill.
2. Confirm the third-party rates marked **check** (domain, Azure Trusted Signing).
3. Decide the domain before enrolling devices; changing it later means reconfiguring every agent's
   `server_url`.
4. If the fleet is expected to exceed ~50 devices within a year, budget for finishing the D1
   cutover (Part C): it is a code change with a staged verification path, not a platform upgrade,
   and it takes the 1,000-device bill from about KES 64,600 to about KES 9,700 a month.
5. Remember the two optional-but-visible costs: unsigned Windows builds and unnotarised macOS
   builds both produce a security warning at install time. Signing is a trust cost, not a
   technical one.
