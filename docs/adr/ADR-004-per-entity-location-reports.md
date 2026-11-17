# ADR-004 — Location reports become per-entity records, capped per device

**Status**: accepted (2026-11-18, session 274)
**Supersedes**: nothing
**Extends**: ADR-002 (`commands`), ADR-003 (`devices`)
**Constrains**: `serverless/worker.ts` (`listLocations`, `saveLocations`, `handleAgentLocation`,
`handleGetLocations`, `handleLatestLocation`, `handleReleaseDevice`), `serverless/worker.test.ts`

## Context

Location reports were the last high-volume store still kept as one KV value:

```ts
const locations = await listLocations(env);   // one get of up to 1000 reports
locations.push(report);
await saveLocations(env, locations);          // one put of up to 1000 reports
```

`saveLocations` caps the list at the **1000 most recent rows across all devices**. Two measured
consequences, and one that follows from the poll interval:

1. **Every report rewrites the whole window.** A tracking device polls every 30 s
   (`ADAPTIVE_POLL.tracking = 30`), so one tracked machine writes ~1,000 rows every 30 seconds —
   ~2.9 million row-writes a day, to append a single fix.
2. **Two devices reporting at once lose one of the two fixes.** Same cross-isolate race as
   ADR-002/003, except here each lost write is *evidence* — the thing a covert-tracking trail
   exists to produce.
3. **The global cap is a per-device cliff that nobody chose.** 1000 rows shared by N tracking
   devices is 1000/N reports each: at 60 devices, **16 reports — about 8 minutes** of a
   device's trail. The fleet that this cap was sized for has more devices than the cap serves,
   and the last arrival always wins, so the chattiest device starves the rest.

## Decision

A report is its own key, and the index is **per device**, so devices do not share a window:

| key | value | written by |
| --- | --- | --- |
| `location:<id>` | one `LocationReport` (now with a real `id`) | the agent's report, once |
| `location_index:<deviceId>` | that device's report ids, oldest first | append on report, prune past the cap |
| `locations` (legacy) | the old whole list | read once for migration, then deleted |

- `addLocationReport(env, report)` — put the record, append the id, and when the index exceeds
  `LOCATION_HISTORY_LIMIT` delete the reports that fall off the end. Pruning records (not just
  the index) is what keeps the key count bounded; ADR-002's `command_index` could leave orphan
  records because a command is rewritten in place, a report never is.
- `listLocationsForDevice(env, deviceId, limit)` — one index get, then the N record gets the
  caller asked for. This replaces `listLocations`, so **no code path reads every device's
  locations any more**; the only global view was the release cascade, which is now
  `deleteLocationsForDevice`.
- `deleteLocationsForDevice(env, deviceId)` — the device's index and its records, then the index
  key itself.

`LOCATION_HISTORY_LIMIT` is **500 per device** (≈4 hours of continuous tracking at the 30 s
poll), a named constant with the arithmetic next to it. It is deliberately larger than the old
per-device share and deliberately bounded: KV has no TTL sweep here, and an unbounded trail is a
privacy liability as much as a cost.

Migration is lazy and idempotent, once per namespace, on the first location read:

1. If the legacy `locations` key is absent → nothing to do.
2. Otherwise parse it, group by `device_id`, and write each row as `location:<id>` with a
   **deterministic** id derived from the row's own content — two isolates migrating at once then
   write the same keys instead of duplicating every report (`generateId()` would double them).
3. Write each device's index as `legacy ids + any ids already there`, so a device that reported
   after migrating has its new reports kept and the order stays oldest-first.
4. Delete the legacy key.

## Consequences

- **Location reports stop overwriting each other.** Two devices in tracking at the same moment
  write different records and different indexes.
- **The write per report drops from ~1000 rows to one record plus one small index.** The index is
  still a whole-value write, per device, bounded by the cap — the residual ADR-002 accepted,
  now scoped to one device instead of the fleet.
- **Reads are bounded by the caller's `limit`**, not by the fleet's history: the history route
  reads `limit` records instead of every device's.
- **The cap is now a per-device retention policy**, and it is larger than the old global share.
  A device that goes dark keeps its last 500 fixes instead of being pushed out by other devices.
- **The response gains a real `id`.** The two read routes used to synthesise
  `loc-<deviceId>-<idx>`, which changed whenever the window shifted; a stored id is stable across
  reads, and `reported_at` is still mapped from `created_at` for the dashboard.
- **Deleting a device costs one index get plus one delete per retained report**, instead of a
  filter over the fleet's list.

## Alternatives rejected

- **One list per device (`locations:<deviceId>`).** Removes cross-device contention and is the
  cheapest option for reads, but keeps a read-modify-write on the same key — the same defect
  class, just smaller — and two reports from one device racing would still drop one.
- **Keep one list, shrink the cap.** Treats the symptom: the write amplification and the
  cross-device clobbering both survive.
- **A Durable Object per device.** Correct granularity for both this and the poll loop; still a
  deployment change, and still the next step rather than this one (ADR-002/003 rationale).

## Verification

- `serverless/worker.test.ts`: migration (rows become records + per-device indexes, ids are
  deterministic, legacy key deleted, a second read is a no-op); two devices' reports interleave
  without losing either; the cap prunes both the index **and** the records; ordering by
  `observed_at` survives the move; release removes the device's location keys.
- The existing location tests (agent report, history ordering, latest pin, `observed_at`
  handling from S272) are the regression net for the read path.
- `docs/artifacts/s274-location-per-entity-keys.json` — the real Worker driven through two
  devices reporting concurrently, the cap being crossed, and a release, printing the key layout
  at each step.
