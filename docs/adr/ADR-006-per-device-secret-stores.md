# ADR-006 — Encryption keys and BIOS credentials become per-device collections

**Status**: accepted (2026-11-18, session 276)
**Supersedes**: nothing
**Extends**: ADR-002 (`commands`), ADR-003 (`devices`), ADR-004 (`locations`), ADR-005 (`audit`)
**Constrains**: `serverless/worker.ts` (`listKeys`, `saveKeys`, `listBiosPasswords`,
`saveBiosPasswords`, the check-in/ACK/deadman/escrow/recover paths and the release cascade),
`serverless/worker.test.ts`

## Context

The last two whole-list stores, and the only ones that hold secrets:

```ts
const keys = await listKeys(env);          // every device's encryption keys
keys.push({ device_id, command_id, key_material, released_at: null });
await saveKeys(env, keys);                 // every device's encryption keys
```

`encryption_keys` holds the escrowed Fernet key material the agent needs to decrypt a locked
device; `bios_passwords` holds the setup/power-on/PIN credentials that undo a firmware lockdown.
Both are read and written **only ever for one device**, at eight call sites between them — the
check-in unlock path, the ACK, the deadman report, escrow, recover, the PBA credentials endpoint,
and the release cascade. There is no global read of either store.

So the defect here is not the read shape, it is that a per-device operation rewrote every other
device's secrets: two devices escrowing at once could lose one key, and **a lost encryption key
is an unrecoverable device**.

## Decision

One key per device per store, holding that device's rows:

| key | value | written by |
| --- | --- | --- |
| `encryption_keys:<deviceId>` | `EncryptionKey[]` for that device | escrow, ACK, deadman, unlock, recover |
| `bios_passwords:<deviceId>` | `StoredBiosPassword[]` for that device (KEK-encrypted as today) | ACK |
| `encryption_keys` / `bios_passwords` (legacy) | the old whole lists | migrated once, then deleted |

This is the natural-key variant of ADR-003, and it is deliberately **not** the index pattern the
other four use. The other stores had an unbounded or fleet-wide population, so they needed an
index and a cap. Here the population is the device set itself: `device_id` *is* the partition, the
rows per device are single digits (one key per escrowing command; one credential per type of
which there are four), and every access is already scoped to one device. An index would add a
second write per mutation and a cap would truncate secrets that must not be truncated.

Helpers replace the list API one-for-one, and the store API disappears so a whole-list write
cannot come back:

- `listKeysForDevice(env, deviceId)` / `saveKeysForDevice(env, deviceId, keys)`
- `listBiosPasswordsForDevice(env, deviceId)` (decrypts) / `saveBiosPasswordsForDevice(env,
  deviceId, rows)` (encrypts through the same KEK path)
- `deleteKeysForDevice(env, deviceId)` / `deleteBiosPasswordsForDevice(env, deviceId)`

Each caller keeps its existing semantics — "newest wins", "replace the row for this command",
"keep the first escrow" — because it now receives only its own device's rows, which is what it
was filtering for anyway.

Migration is lazy and idempotent per store: read the legacy list, group the rows by `device_id`,
write one key per device, delete the legacy key. No ids are generated, so two isolates migrating
at once write identical values.

## Consequences

- **A per-device secret write touches one device.** Escrowing on device A can no longer drop the
  key device B is about to be unlocked with.
- **The write is bounded by one device's rows** (a handful), not by the fleet.
- **No index and no cap.** Bounded by construction: the key set is exactly the device set, and
  the rows per device are bounded by the command/credential types. Nothing to prune means nothing
  can silently evict the key an unlock still needs — which the old 500-row audit-style cap could
  never have been allowed to do here.
- **The release cascade deletes one key per store** instead of rewriting both lists.
- **The legacy key names remain readable for migration only**; after it runs, `encryption_keys`
  and `bios_passwords` are gone from the namespace.

## Alternatives rejected

- **An index over key ids (`key:<id>` + `key_index`).** Correct for an unbounded population, wrong
  here: it would add an index write to every escrow and a cap that must never truncate a key.
- **A Durable Object per device.** Same reasoning as ADR-002/003/004/005.

## Verification

- `serverless/worker.test.ts`: migration (both stores split by device, legacy keys deleted, a
  second migration is a no-op); escrowing on one device leaves another device's key byte-identical;
  the unlock path still hands out the **newest** key (the S269 regression); BIOS credentials
  survive the move and still decrypt through the KEK path; release deletes both per-device keys.
- The existing agent-path tests (check-in unlock materials, ACK credential storage, deadman,
  escrow idempotency, recover, PBA credentials endpoint) are the regression net — they exercise
  every one of the eight call sites through the API.
- `docs/artifacts/s276-secret-stores-per-device-keys.json` — the real Worker taking two devices
  through escrow → unlock and ACK → credentials → release, printing the key layout and proving the
  bystander device's key material is untouched.
