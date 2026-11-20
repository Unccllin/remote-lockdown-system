# ADR-003 — Devices become per-entity KV records; the whole-list write goes away

**Status**: accepted (2026-11-18, session 272)
**Supersedes**: nothing
**Extends**: ADR-002 (the same decision, for `commands`)
**Constrains**: `serverless/worker.ts` (`listDevices`, `saveDevices`, every mutation of a
device, `verifyAgentAuth`), `serverless/worker.test.ts`

## Context

Every device mutation loads the entire `devices` list from one KV key, edits an array, and
writes the array back:

```ts
const devices = await listDevices(env);   // one KV get of the whole fleet
device.status = 'stolen';
await saveDevices(env, devices);          // one KV put of the whole fleet
```

ADR-002 removed this shape for `commands` and left `devices` on it deliberately, naming the
residual: *"`serializeMutation()` stays as belt-and-braces for the remaining `devices` list."*

Three consequences, in order of how badly they bite:

1. **Two writers destroy each other's fields.** `serializeMutation()` serialises *within one
   isolate*; Workers scale across isolates and colos. A `flag-stolen` and an `api-key-rotate`
   landing in different colos each write a list built before the other's edit, so one of the
   two changes is silently lost. On `devices` that is worse than on `commands`: the lost field
   can be `api_key_hash` (the device stops authenticating) or `status` (the dashboard says
   `active` for a machine that is locked).
2. **Cost and latency scale with the fleet, not with the change.** Setting one device's status
   serialises and writes **every** device record. 27 call sites read the whole fleet, and
   `verifyAgentAuth` does it on **every agent request** — so a check-in from one device costs a
   read of all N devices.
3. **Value size.** A single KV value holds the whole fleet. Cloudflare caps a value at 25 MiB,
   which is not the binding limit today but is a cliff nobody is measuring.

The 60-device rollout was blocked on this (`current-state.md`, S271): the storage shape, not a
missing feature.

## Decision

A device is stored as its own key, and mutations address one device:

| Key | Value | Written by |
| --- | --- | --- |
| `device:<id>` | one `Device` JSON | created at enrol; thereafter only the fields a handler changes |
| `device_index` | `string[]` of ids, append-mostly | append on enrol, remove on release |
| `agent_key:<sha256>` | the device id | whenever `api_key_hash` is set (enrol, re-enrol, re-key, rearm, rotate) |
| `devices` (legacy) | the old whole list | read once for migration; deleted after |

Mutations become targeted:

- `putDevice(env, device)` — write `device:<id>`, ensure the id is in the index, and keep the
  `agent_key:` mapping in step with `api_key_hash` (write the new mapping, delete a stale one
  when the hash changed). A stale `agent_key:` entry pointing at a re-keyed device is dropped
  rather than left to authenticate an old key.
- `deleteDevice(env, id)` — delete the record, its `agent_key:` mapping, and its index entry.
- `getDeviceById(env, id)` — one read, for the handlers that only need one device.
- `listDevices(env)` keeps its signature (27 call sites) but reads `device_index` and then the
  records, skipping ids whose key is gone.

**Why `agent_key:` is part of this and not a later optimisation.** `verifyAgentAuth` finds the
device by scanning the list for `api_key_hash`. Left alone, converting devices to per-entity
records turns one fleet-wide read per agent request into N per-entity reads per agent request —
a 60-device fleet polling every 300 s would go from ~288 reads/day to ~17,000, and every
check-in would pay the latency of 60 sequential KV gets. The lookup key makes authentication a
single read, which is what it is on the Express surface (`SELECT … WHERE api_key_hash = $1`).
The mapping is derived data: it can always be rebuilt by scanning the index, and
`api_key_hash` stays on the record as the source of truth.

Migration is lazy and idempotent, on the first `listDeviceIds`:

1. If `device_index` exists → read it; done.
2. Else read the legacy `devices` key; if present, write each `device:<id>` and its
   `agent_key:` mapping, write the index, then delete the legacy key. Two isolates migrating at
   once write identical records — `device:<id>` writes are idempotent and the index is the
   union of ids.

## Consequences

- **The lost-field race disappears for devices**: two writers touch different keys, so
  `flag-stolen` and `api-key-rotate` can no longer overwrite one another, across colos or
  within one.
- **A mutation costs one write, not one fleet-sized write.** `serializeMutation()` stays as
  belt-and-braces for the multi-key paths (an enrolment writes a record *and* an index entry).
- **The index is still a whole-value write**, exactly as ADR-002 accepted for `command_index`.
  It is append-mostly and holds only ids. A lost append hides a device from `device_index` —
  recoverable, because the `agent_key:` mapping still authenticates it and the record still
  exists; a device that is invisible to `listDevices` would otherwise 404 on check-in, so
  `putDevice` re-appends an id that the index is missing whenever it writes.
- **Reads become N+1** for the three handlers that genuinely need the fleet (the device list,
  the PBL link check, the release cascade). That is the same trade ADR-002 made, and the number
  is bounded by the fleet the dashboard page is already rendering.
- **Two sources of truth for authentication** (`api_key_hash` on the record, `agent_key:` in the
  index). The record wins: the index entry is only a pointer, and `verifyAgentAuth` still
  compares the hash it computed against the hash on the record it loaded. A stale pointer to a
  re-keyed device therefore fails closed.
- **Deleting a device now has to clean up three keys**, not one list entry. `deleteDevice` is
  the only sanctioned path, and the release handler uses it.

## Alternatives rejected

- **Keep the list and rely on `serializeMutation()`.** It is per-isolate; the observed losses
  in S269/S271 were cross-request and the same shape is still reachable.
- **Scan by key prefix (`list({prefix: 'device:'})`) instead of an index.** Cloudflare KV
  `list()` is paginated (1000 keys) and eventually consistent, so it is a slower, more
  expensive read of the same information, and it cannot be bounded by the caller's `limit`.
- **A Durable Object per device.** The correct granularity, and it would also replace the poll
  loop with an alarm — but it is a deployment change (bindings, migrations, local dev), not a
  refactor of one module. Same reasoning, and the same named owner, as ADR-002.
- **Move devices to D1.** A second source of truth next to the Express/SQLite surface; the
  cross-surface divergence this repo already fights would get worse.

## Verification

- `serverless/worker.test.ts`: the migration (legacy key → per-entity keys + index + mapping,
  legacy key deleted, second run a no-op); two concurrent mutations on **different** devices
  both survive; a re-keyed device authenticates with the new key and not the old one; a
  released device is gone from `listDevices`, its `device:<id>` key and its `agent_key:` entry.
- The whole existing Worker suite (458 tests) is the regression net for the 27 read sites and
  17 write sites: no route changes its observable contract.
- `docs/artifacts/s272-device-per-entity-keys.json` — a real run through enrol → flag → ack →
  release, printing the KV key layout at each step, so the storage shape is evidence rather
  than a claim.
