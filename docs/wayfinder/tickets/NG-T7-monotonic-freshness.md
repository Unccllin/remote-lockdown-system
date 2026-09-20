# NG-T7: Monotonic-counter freshness for the lock-state NV cache

> **Label:** `wayfinder:task` (AFK-able, firmware session lifecycle)
> **Status:** OPEN
> **Blocks:** S2 (firmware) — closes the stale-lock-state replay gap
> **Blocked by:** none (TPM NV counter infra exists — PBL_NV_POLICY_VERSION
> is already a TPMA_NV_COUNTER index with Define/Read paths)

## Question

The lock-state cache (`PBL_NV_LOCK_STATE`, C2 §5.1/5.2) lets PBL act on a
cached verdict when the network is unreachable. But a regular NV index is
**replayable**: an attacker who can snapshot NV contents (or a platform
that restores a saved TPM state) could present a stale `unlocked` state
written before the device was locked — i.e., a *rollback* of the lock
decision. HMAC session auth proves the write came from PBL, not that the
value is *fresh*.

Fix: bind the lock-state cache to a **monotonic TPM NV counter**. On each
lock-state write, increment a dedicated counter index and store the
counter value inside the cache record. On read, compare the stored counter
against the counter index's current value: a stored value *lower* than the
current counter means the cache was rolled back → distrust it.

## Work

1. **New NV index** `PBL_NV_LOCK_EPOCH` (counter, 8 bytes) in
   `PblTpmProvisionNvIndices` — reuse the existing `IsCounter=TRUE` arm of
   `PblTpmNvDefineSpace`. Note: a TPM2 NV counter's *stored value* is not
   directly readable as a number via NV_Read after increment in all TPMs —
   but `TPM2_NV_ReadPublic`/`NV_Read` on a counter index returns the count;
   confirm swtpm behaviour. If NV_Read on a counter index isn't readable,
   use `TPM2_NV_Certify` or read via `NV_ReadPublic` (counter value lives in
   the public area for counter indices? verify against swtpm + spec).

2. **Increment + bind on write** (`PblTpmWriteLockState`, C2 §5.2):
   `TPM2_NV_Increment(PBL_NV_LOCK_EPOCH)` then read the new counter value,
   store it in `PBL_LOCK_STATE_CACHE.Epoch`. Counter monotonicity means a
   rolled-back cache has an Epoch lower than the live counter.

3. **Check on read** (`PblTpmReadLockState`, C2 §5.1): after a valid
   (magic + auth) read, compare `Cache.Epoch` to the live counter. If
   `Epoch < live` → treat as `EFI_NOT_FOUND` (rolled-back cache → force a
   fresh verdict fetch), print a `[WARN] lock-state epoch stale` line.

4. **State field** — add `UINT64 Epoch` to `PBL_LOCK_STATE_CACHE` (PblApp.h).
   Keep `PBL_LOCK_STATE_SIZE` consistent (64B — confirm Epoch fits inside
   the existing struct or bump the index size + NV define accordingly).

5. **Fresh-boot path** — first boot (no counter index / NV_UNINITIALIZED)
   must not block: provisioning defines the counter at 0; the first
   write increments to 1. A read with no cached state stays EFI_NOT_FOUND.

## Verify

- `test-*-harness.sh` or a new persistence-boots harness:
  - Boot A: write lock state (epoch=1).
  - Boot B: read → trusted (epoch==counter).
  - Simulate rollback: restore an older NV state (swtpm `--tpmstate` dir
    snapshot) → read → must report stale epoch → EFI_NOT_FOUND path.
- `make graph-check` green; session-close per AGENTS.md.

## Resolution

Record harness evidence (fresh read trusted, rolled-back read rejected).
Update D-120/PBL-DEBT-LEDGER if it covers lock-state freshness.

## Open sub-questions (resolve during implementation)

- Is an NV counter index's count readable via `TPM2_NV_Read`, or only via
  `NV_ReadPublic`/certify? (swtpm test answers this first.)
- Counter NV increment requires auth consistent with the lock-state index
  (platform hierarchy vs auth session) — reuse the same provisioning attrs.
