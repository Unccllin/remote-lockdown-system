# ADR-005 — Audit entries become per-entity records with one capped index

**Status**: accepted (2026-11-18, session 275)
**Supersedes**: nothing
**Extends**: ADR-002 (`commands`), ADR-003 (`devices`), ADR-004 (`locations`)
**Constrains**: `serverless/worker.ts` (`listAudit`, `saveAudit`, `addAuditEntry`,
`handleGetAudit`, `handleReleaseDevice`), `serverless/worker.test.ts`

## Context

The last store that every mutation touches:

```ts
async function addAuditEntry(env, deviceId, action, detail) {
  const entries = await listAudit(env);        // one get of up to 500 entries
  const devices = await listDevices(env);      // ADR-003: one index get + one get PER DEVICE
  entries.push({ … });
  await saveAudit(env, entries);               // one put of up to 500 entries
}
```

Two of those three reads are unnecessary, and one of them got worse this week:

1. **The device lookup is a fleet scan.** `addAuditEntry` needs one field — the hostname for the
   entry — and it read every device to find it. Since ADR-003 that is one index get plus one get
   per device, on **every audit write**, and audit is written by every mutation. Measured against
   the shape: a 60-device fleet paid 61 gets to record one `api_key_rotated`. One record get
   fixes it.
2. **The append rewrites the whole window.** 500 entries read and rewritten to add one line, so
   two concurrent appends lose one — and a lost audit entry is a compliance record, not a cache.
3. **`handleGetAudit` filters in JavaScript.** A device-filtered read loads all 500 entries and
   discards the ones that do not match.

## Decision

One record per entry, one index, capped:

| key | value | written by |
| --- | --- | --- |
| `audit:<id>` | one `AuditEntry` | the mutation that produced it |
| `audit_index` | `[{id, device_id}]`, oldest first, capped | append; each id pruned with its record |
| `audit_log` (legacy) | the old whole list | read once for migration, then deleted |

The index holds `device_id` **as well as** the id, and that is the whole reason there is one
index rather than two. The read API is either global (`GET /api/audit?limit=N`) or scoped to one
device (`?device_id=`), so per-device indexes would be a second write on the highest-volume store.
Carrying the device id in the index satisfies both: a device-filtered read selects its ids from
the index without loading any other device's records, and the release cascade can find exactly
the entries it must anonymise.

- `addAuditEntry(env, deviceId, action, detail)` keeps its signature (16 call sites): one device
  record get for the hostname, one record put, one index put.
- `handleGetAudit` reads the index, filters by `device_id` when asked, takes the newest `limit`
  ids, and loads only those records.
- `handleReleaseDevice` no longer rewrites every entry: it loads that device's entries, appends
  `released_at` to each `detail`, and puts those records back. The entries stay (they are the
  accountability record of the release); only their detail is amended.

`AUDIT_HISTORY_LIMIT` is **1000** entries — twice the old 500, since entries are small and the
old cap was the same global truncation for the whole fleet — overridable as a `[vars]` entry like
`LOCATION_HISTORY_LIMIT`, so the pruning path can be exercised.

Migration is lazy and idempotent on the first audit read, exactly as ADR-004 does it: legacy rows
get deterministic ids derived from their content (so two isolates migrating at once write the
same keys), legacy ids go in front of whatever index already exists, and the legacy key is
deleted afterwards.

## Consequences

- **An audit append costs three gets-worse operations instead of a fleet-sized one**: one device
  get, one put, one small index put. The fleet scan is gone.
- **Concurrent appends no longer overwrite each other's entries.** Two isolates appending at once
  both land; the index append is still a whole-value write, so one of the two ids can be lost —
  the residual ADR-002 accepted, now over ids rather than over the entries themselves (the record
  is written first and survives, and a lost id hides one line from the list view rather than
  corrupting the trail).
- **A device-filtered read stops loading other devices' entries.**
- **The release cascade stops rewriting the whole trail**: it touches only that device's entries,
  which also stops it from silently dropping the newest entries when the 500-row cap bites
  mid-rewrite.
- **The index grows with the cap, not with time**: 1000 `{id, device_id}` tuples is a few tens of
  KB, and every id that falls off the end takes its record with it.

## Alternatives rejected

- **Per-device audit indexes as well as a global one.** Two index writes per append on the
  busiest path, to save loading a handful of non-matching records. The device id in the index
  entry buys the same filtering for one write.
- **Keep the list and only fix the fleet scan.** Treats one of the three defects; the append
  would still rewrite the window and still lose a concurrent entry.
- **Durable Object per device (again).** Same reasoning as ADR-002/003/004: right granularity,
  deployment change, next step.

## Verification

- `serverless/worker.test.ts`: migration (records + index with device ids, deterministic ids, a
  re-migration does not duplicate, legacy key deleted); two devices appending concurrently both
  keep their lines; the cap prunes index entries **and** records; a device-filtered read returns
  only that device's entries; release amends only that device's entries without rewriting the
  rest.
- The existing audit tests (`GET /api/audit`, `?device_id=`, `timestamp` mapping, the
  `agent_<type>_confirmed` entries the dashboard's effectiveness panel parses) are the regression
  net.
- `docs/artifacts/s275-audit-per-entity-keys.json` — the real Worker taken through two devices
  mutating, a capped append, a device-filtered read, and a release, printing the key layout and
  the index contents at each step.
