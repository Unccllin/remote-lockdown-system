# ADR-002 — Commands become per-entity KV records; the whole-list write goes away

**Status**: accepted (2026-11-17, session 271)
**Supersedes**: nothing
**Constrains**: `serverless/worker.ts` (`listCommands`, `saveCommands`, every mutation of a
command), `serverless/worker.test.ts`, `serverless/device-commands.test.ts`

## Context

Every command mutation loads the entire `commands` list from one KV key, edits an array, and
writes the array back:

```ts
const commands = await listCommands(env);   // one KV get of the whole list
… // edit or append
await saveCommands(env, commands);          // one KV put of the whole list
```

Two requests that overlap therefore destroy each other's fields — the later `put` wins with a
list built before the other request's edit. This was observed on the live Worker, not
theorised: the agent ACKed `unlock … status=executed` (and the audit log gained
`agent_unlock_confirmed`), yet `GET /api/devices` still reported the unlock `pending` and the
device `locked` (S269, defect 9). It self-heals on the next write, which is why it reads as
"eventually consistent" rather than as a bug.

Three partial fixes exist and none is sufficient:

1. **`serializeMutation()`** wraps the seven mutating dispatch sites in a promise chain. That
   serialises *within one isolate*; Workers scale across isolates and colos, so two writes
   from different isolates still race.
2. **`device_checkin:<id>`** already splits check-in metadata out of the `devices` key
   (KV-RACE-001) — the precedent this ADR generalises, and evidence that the shape works.
3. **Per-entity reads** for locations and encryption keys exist; commands were left behind
   because they are read by the agent poll path as a set.

## Decision

A command is stored as its own key, and mutations address one command:

| Key | Value | Written by |
| --- | --- | --- |
| `command:<id>` | one `Command` JSON | created once at queue time; thereafter only the transitions below |
| `command_index` | `string[]` of ids, append-mostly | append on create, remove on delete |
| `commands` (legacy) | the old whole list | read once for migration; deleted after |

Mutations become targeted:

- `updateCommand(env, id, patch)` — read `command:<id>`, merge the patch, write it back. The
  ACK path uses this, so an ACK can no longer roll back a concurrent lock/flag write on
  `devices`, and vice versa.
- `deleteCommand(env, id)` / bulk removal — index edit plus per-key deletes.
- `listCommands(env)` keeps its signature (17 call sites) but reads `command_index` and then
  the individual keys, and drops index entries whose key is missing.

Migration is lazy and idempotent, on the first `listCommands`:

1. If `command_index` exists → read it; done.
2. Else read the legacy `commands` key; if present, write each `command:<id>` and the index,
   then delete the legacy key. If two isolates migrate at once they write identical records —
   `command:<id>` writes are idempotent, and the index is the union of ids.

## Consequences

- **The observed race disappears for commands**: two writers touch different keys, so the ACK
  and the queue path cannot clobber one another. `serializeMutation()` stays as
  belt-and-braces for the remaining `devices` list.
- **The index is still a whole-value write.** It is append-mostly and its entries are ids, so
  a lost append at worst hides a command from `listCommands` (recoverable from the audit log)
  rather than corrupting a record. Removing this residual means a Durable Object per device
  (see below) — deliberately not part of this ADR.
- **Reads become N+1.** The poll path reads the index plus the pending commands it needs.
  Cloudflare KV bills per operation and each `get` is a round trip, so `listCommands` must
  never be called in a loop over devices; the dashboard endpoint already bounds its window
  (`limit`, max 100) and now reads only the commands it returns.
- **KV eventual consistency still applies.** `command_index` may lag across colos. The poll
  path therefore tolerates a missing id (skips it) and a stale extra id (fetches, finds a
  terminal status, ignores it) — both already true of a list-based read.
- **Migration runs once per namespace** and is covered by a test that seeds the legacy key and
  asserts both the per-entity keys and the deletion.

## Alternatives rejected

- **Keep the list, add a real distributed lock.** Workers KV has no compare-and-swap; the only
  atomic primitive available is a Durable Object, which is the next step rather than a fix.
- **Durable Object per device now.** Correct granularity — one serialisation point per device,
  which also replaces the poll loop with an alarm — but it is a deployment change (bindings,
  migration steps, local dev), not a refactor of one module. Recorded here so the index
  residual has a named owner.
- **Move commands to D1.** Would give transactions, and a second source of truth next to the
  Express/SQLite surface; the cross-surface divergence this repo already fights would get
  worse, not better.

## Verification

- `serverless/device-commands.test.ts` (the route contract: newest first, scoped, bounded).
- New tests in `serverless/worker.test.ts`: a mutation of one command does not rewrite
  another; `command_index` migration from the legacy key; a missing index entry is skipped
  rather than thrown.
- The acceptance harness's `lock`/`recover`/`track` steps read the command back through
  `GET /api/devices/:id/commands`, so a regression shows up as `command status: pending` on a
  device that visibly executed — the exact symptom S269 recorded.
