# What a fully serverless deployment costs

> **Correction, 2026-11-26 (S362): the crossover figures below are optimistic, and the "Not yet"
> column is out of date.** The per-check-in workload is 1 request + 3 reads + 1 write + 1 list, and
> the KV **write/list** meter at $5/million is what scales — which puts the crossover against a
> KES 2,000–2,500 local VM at roughly **45–55 devices**, not ~325, and 1,000 devices at about
> **KES 64,600/month** rather than KES 8,300 *until the D1 read/write cutover lands*. The
> company-facing model, its assumptions and the code each one comes from is
> [`COMPANY-SETUP-COST.md`](COMPANY-SETUP-COST.md) — use that for quoting. Alerts, encrypted
> backups to R2, the nonce purge and the shared replay store all exist now (S348–S361); the only
> item still genuinely missing from the right-hand column is the read/write cutover, whose stage 0
> is live.

**Measured**: 24 November 2026 · **Currency**: Kenyan shillings only · **FX basis**: 1 USD = KES 130.09
(open.er-api.com, 2026-11-24). The hosting provider bills in its own currency; the KES figures below are
that bill converted at this rate, so **FX is part of the cost** — a 10% shilling move is a 10% move here.

---

## Verdict

1. **Up to roughly 40 devices, serverless is cheaper than a local VM** — about KES 650 a month against
   KES 2,000–2,500 for the smallest local host.
2. **Before the fix shipped in S348, above ~40 devices the design cost more than the VM it replaces**, and
the cause was one line of code: every check-in read the entire command index. Cost scaled with *command
history × fleet size*, not fleet size alone. **That is now fixed** — the check-in reads a per-device
index, and the middle column below is what it costs today.
3. **After the fix, the crossover moves to about 325 devices**, and the remaining ceiling is writes, not
reads: a poll writes check-in metadata every time. Moving state to the relational store removes that
ceiling too and takes 1,000 devices from about **KES 8,300 a month to about KES 650** — writes are
included 50× more generously there and cost a fifth as much each.

---

## What "fully serverless" means for this repository today

| Already serverless | Not yet |
|---|---|
| Agent ingress: check-in, enrolment, command acknowledgement, escrow, deadman, location | Reading/writing devices and commands from the relational store (D1 stage 0 is live; the read/write cutover is stage 1+) |
| Administrative API and dashboard | Third-party inventory view (answers *not implemented*, by design) |
| Binary and installer download endpoints | |
| The firmware-facing surface, in CBOR with signatures | |
| Durable state in a key-value namespace plus an object bucket | |
| Scheduled work: the hourly alert tick, the retention/nonce purge, the daily encrypted backup (S348–S354, proven by `backup_written` audit entries on 25 and 26 Nov) | |
| Shared replay-protection store for request signing (D1 `nonces` UNIQUE constraint, live 2026-11-26) | |
| Backup and restore to object storage, with a restore drill (2026-11-24) | |

So "fully serverless" is not a lift-and-shift with a bigger bill attached: three background jobs and a
replay store do not exist yet. Their cost is small; their absence is the real gap.

---

## The cost driver, measured from the code

Per agent check-in, the Worker performs:

| Step | Operation |
|---|---|
| Resolve the device from its credential | 1 read (key hash) + 1 read (device record) |
| Read and write check-in metadata | 1 read + 1 write |
| Find pending commands | **1 read (index) + 1 read per command in the index** |

That last row is the problem. The command index is a single key holding every command id, and it is only
pruned when a device is deleted. With ~100 historical commands retained — a normal figure after a few
months of fleet operation — each poll costs **104 reads**. At ten thousand devices polling every five
minutes, that is 33 polls a second, each reading a ten-thousand-entry index.

**Assumptions used below**: 300-second polling for an active device; 30–60 second polling for locked or
stolen devices, which multiplies every figure up to 10×; the retained command index at 100 entries for the
"before S348" column, and **2 command reads per poll measured from the shipped code** for the middle
column; administrative dashboard traffic excluded (it is small relative to fleet polling).

---

## Monthly cost by fleet size

All figures KES per month, including the KES 650 base plan. Storage, egress and downloads are effectively
free at these volumes: objects sit well inside the 10 GB free allowance, and egress is not charged.

| Devices | Before S348 (global index, 100 commands) | As shipped now (per-device index) | On the relational store |
|---|---|---|---|
| 10 | 650 | 650 | 650 |
| 100 | 5,850 | 650 | 650 |
| 500 | 31,400 | 3,800 | 650 |
| 1,000 | 63,400 | 8,300 | 650 |
| 5,000 | 320,800 | 45,600 | 650 |

Yearly, for the middle two columns at the fleet sizes most likely to appear in a pilot:

| Devices | Before S348 | As shipped now | Relational store |
|---|---|---|---|
| 100 | 70,200 | 7,800 | 7,800 |
| 1,000 | 760,800 | 100,000 | 7,800 |

**Against local hosting** at KES 24,000–30,000 a year: the design as it stood before S348 beat a local VM
only below about **40 devices**. The per-device command index now in the code moves that crossover to
roughly **325 devices**, where per-poll writes — not reads — start to dominate. The relational store moves
it past **5,000**, where the monthly write allowance finally runs out.

---

## The free plan cannot run a fleet

The free tier allows **1,000 key writes per day**. A single device polling every 300 seconds writes 288
times a day; three devices exhaust it. The free plan is usable for development only, and any real
deployment pays the base plan from day one. This is not a risk to plan around — it is a hard wall.

---

## What completing "fully serverless" adds

| Item | Cost | State |
|---|---|---|
| Scheduled handlers (retention purge, alert tick) | **Negligible** — scheduled invocations are included in the base plan | **Done** (S348/S349) |
| Replay-protection store for request signing | ~200–500 KES/month at 1,000 devices with a relational binding; 0 without one | **Done** — key-value marker by default, UNIQUE constraint when D1 is bound |
| Backups to object storage | **Negligible** — inside the free allowance | **Done** (S350) — AES-256-GCM, refuses plaintext, drill in [SERVERLESS-BACKUP.md](SERVERLESS-BACKUP.md) |
| Email alerting | 0–2,600 KES/month | **Done** — webhook or Slack; free tier covers a fleet |
| Third-party inventory view | Not a hosting cost | Must be built, or permanently answered as *not implemented* |
| Single sign-on for administrators | Not a hosting cost | Still absent; a gateway in front of the dashboard is a partial substitute |

**Engineering still owed**: a backup and restore path, and the parity tests that prove it — in the
region of one to two weeks. Retention, alerting and replay are in the code and covered by tests.
The relational-store cutover is not owed yet: it is staged in
[docs/SERVERLESS-D1-CUTOVER.md](SERVERLESS-D1-CUTOVER.md) and only pays off past a few hundred devices.

---

## Recommendation

1. **Do not deploy the pre-S348 shape to a large fleet.** The global command index made cost grow with
   commands × devices, and it would have surprised whoever read the first large bill.
2. **One change is done, one remains.** The per-device command index shipped in S348 and is pinned by
   `serverless/serverless-scale.test.ts`, which counts key reads during a check-in: 1,000 devices went
   from KES 63,400 to KES 8,300 a month. The remaining change is moving device and command state onto the
   relational store, which takes it to the base plan and keeps it there to about 5,000 devices — and that
   is worth doing when a deployment passes a few hundred devices, not before.
3. **Keep binaries and installers on the object bucket.** Egress is free there, which matters the moment
   a fleet starts pulling 30 MB installers.
4. **If the fleet stays under ~40 devices**, the present design is genuinely economical and nothing is
   urgent — but the 30-second poll interval of a stolen device multiplies every figure by ten, so size the
   decision against the worst case, not the average.

---

## What this estimate does not include

- The pen test, data-protection registration, legal instrument and code-signing identity priced in the
  handover cost schedule — they are unchanged by hosting choice.
- Administrative dashboard traffic: small next to fleet polling, and not modelled.
- Any commercial licence fee for the software.
- Migration engineering, which is the four-to-six weeks named above, not a monthly line.
