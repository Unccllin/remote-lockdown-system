# D1 cutover — the relational store, in stages

**Status**: schema written, replay path live, read/write migration **not started**
**Schema**: [`serverless/d1/schema.sql`](../serverless/d1/schema.sql)
**Cost context**: [`docs/SERVERLESS-COST.md`](SERVERLESS-COST.md)

---

## Why bother, in one table

| Property | Key-value store | Relational store |
|---|---|---|
| Replay rejection | Eventually consistent: two replays in two locations can both pass | UNIQUE constraint: one can |
| Per-poll cost driver | Writes, billed per key, 1M included | Writes, billed per row, 50M included at a fifth the unit price |
| Listing one device's commands | An index key that must be maintained by hand | An index the planner uses |
| Retention delete | Rewrite an index, then delete keys | A range delete |
| Crossover against a local VM | ~325 devices | ~5,000 devices |

Two separate reasons to move, and it matters which one is yours: **replay integrity** binds
immediately (it is a correctness gap), **cost** binds only above a few hundred devices.

---

## What is done, and what is not

| Element | State |
|---|---|
| Schema for devices, commands, locations, audit, admins, nonces | Written; not applied anywhere |
| Replay protection preferring D1 when bound | **Live and tested** — falls back to the key-value marker when unbound |
| Expired-nonce purge in the cron tick | **Live and tested** (no-op without a binding) |
| Reading and writing devices/commands/locations from D1 | Not started |
| Migration of existing data | Not started |

**Why the read/write cutover is not in this change, stated plainly.** It cannot be verified from
this machine: there is no D1 instance, and a fake would prove that the code calls `prepare()`,
not that D1 rejects a duplicate key, honours the index, or keeps SQLite's type affinity. This
repository's rule is that a verification which cannot run has not passed — writing the migration
and calling it done would break exactly that rule. The stages below exist so each one has a check
that can actually fail.

---

## Stage 0 — create and apply (30 minutes)

```bash
cd serverless
npx wrangler d1 create lockdown                    # prints database_id
# paste the id into wrangler.toml (the [[d1_databases]] block is present, commented)
npx wrangler d1 execute lockdown --file=d1/schema.sql --remote
npx wrangler d1 execute lockdown --command "SELECT name FROM sqlite_master WHERE type IN ('table','index') ORDER BY name" --remote
```

**Exit condition**: the index list includes `commands_device_status`, `devices_api_key_hash` and
`nonces_expires`. If it does not, the schema silently half-applied — check before going further.

**What this proves**: the schema is valid SQL for D1's SQLite build. Nothing else.

---

## Stage 1 — shadow write (1 week, no reads)

Write every device and command mutation to both stores; read only from KV. Compare after every
write with a counter (`shadow_mismatch` in the audit trail).

**What this proves**: the D1 statement set produces the same records the KV path does, on real
traffic, without risking a read path. **Rollback**: delete the shadow writes; nothing reads them.

**Watch for**: `api_key_hash` uniqueness. Enrolment writes a hash that KV also writes as a
pointer key; a duplicate hash is a bug today and a constraint violation here.

---

## Stage 2 — shadow read (1 week)

Read from D1, compare against the KV result, serve the KV result.

**What this proves**: the reads agree on real data, including the per-device command list that the
poll depends on. **Rollback**: none needed — nothing user-visible changed.

This stage is where a missing `ON DELETE CASCADE`, a TEXT-vs-REAL affinity mismatch, or a
timestamp-format difference between the stores actually shows up. Expect at least one.

---

## Stage 3 — cut reads over, keep KV writes (1 week)

Serve D1 reads; keep writing to both.

**What this proves**: D1 can carry the read load on the hot path — the check-in — at real fleet
polling rates. **Rollback**: flip the read flag back; KV is still current because it is still
being written.

---

## Stage 4 — cut writes over, stop KV writes (permanent)

D1 is the store. KV remains for the two things it is good at: binary artifacts (already in R2) and
the legacy keys the migration reads.

**What this proves**: nothing — it is the decision. **Rollback**: the last KV write is the restore
point, so this stage must not run until Stage 3 has been clean for a full billing cycle.

---

## What must not be lost in the migration

| Item | Why it is easy to lose |
|---|---|
| `api_key_hash` per device | Regenerated hashes re-enrol the whole fleet |
| `last_checkin` | Staleness alerts fire for every device at once if it lands as NULL |
| Command `created_at` | The old/new ordering in the poll is by this field; ties reorder silently |
| Audit entries | The audit trail is evidence; a partial copy is worse than none |
| Location `created_at` | The retention purge deletes on it — a wrong format deletes live rows |

Each row of that table is a test: the migration script should assert counts and a checksum per
entity before and after, and refuse to switch the read flag on a mismatch.

---

## Timing

Do Stage 0 when convenient — it changes nothing. Do Stages 1–3 when either condition is true:

- the fleet passes **~300 devices** (cost), or
- an auditor asks how replay is enforced (integrity).

Do not do it before either. The key-value store with a per-device command index is a correct store
for a few hundred devices; migrating it earlier buys nothing and costs a week of verification.
