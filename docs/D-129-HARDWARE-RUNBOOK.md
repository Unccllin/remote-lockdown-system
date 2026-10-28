# D-129 Hardware Runbook — the window, executed once, correctly

Status: **Phase A implemented and executed on Linux (2026-10-27); nothing has
run on physical hardware.** The runbook exists so that the single hardware
window produces artifacts that `graph_assert.py` accepts, instead of an
afternoon of screenshots that cannot be filed.

Owner decisions it depends on: D-130 signing (settled 2026-10-14 —
owner-cert + provisioning-time `db` enrollment), credential rotation
(step 0, needs console access).

---

## 0. Read this first: two evidence streams, not one

D-129 ("No real hardware validation") and the nine `verified-in-unit-test`
enforcement paths are **different claims with different evidence**. The last
session's handover note merged them. They share a trip, not an artifact.

| Stream | Claim it closes | Required evidence | Ledger / invariant |
|--------|-----------------|-------------------|--------------------|
| **A — Firmware** | PBL boot flow runs on real UEFI + real TPM | Captured **serial log** of the full `[1/8] … [8/8]` flow | D-129 close criteria; I3 for firmware paths |
| **B — Agent enforcement** | Enforcement paths behave on real Windows | Harness **CTRF JSON** with the path's own `test_id` at `PASS` | I3 `hardware_artifact_ref` per path |

Stream A is `firmware/PblPkg/HARDWARE-TEST-PLAN.md` + `docs/HARDWARE-TEST-CAPSULE.md`.
Stream B is `agent/hw_test_harness.py`. Do not cite one as proof of the other.

---

## 1. Coverage truth table — what is runnable, and what each test asserts

Status 2026-10-27: **Phase A is implemented.** All 20 registered tests execute;
the 8 new ones ran on Linux and passed (see §3 for the evidence, and for what
still needs Windows or the physical machine).

| Path | Harness test | `--tag <path>` | What the test asserts |
|------|--------------|----------------|------------------------|
| E-DECRYPT | `E-DECRYPT-01` | exit 0 | wrong key raises `InvalidToken`, ciphertext intact, **no plaintext released**; right key restores content |
| E-HP-UEFI | `E-HP-UEFI-01` | exit 0 | BIOS boot lockdown applied and rolled back on HP + admin |
| E-ACK | `E-ACK-01` | exit 0 | refused connection → `False` + pending ACK preserved; retry delivers once, HMAC-signed, **same `command_uuid`**, then deletes the file |
| E-RECOVERY | `E-RECOVERY-01` | exit 0 | no key material → ACK `failed`, nothing released; wrong key → ciphertext + sentinel + recovery key intact; right key → decrypted, sentinel removed, recovery key deleted, ACK `executed` |
| E-TRACK | `E-TRACK-01` | exit 0 | location posted with its source and hardware UUID; unreachable server queues offline; empty wifi scan falls back to IP; no location → no phantom queue entry |
| E-DEADMAN | `E-DEADMAN-01` | exit 0 | 60 s of skew does **not** fire; unflagged device does not fire; expiry fires and encrypts; backward clock fires; corrupt state fires |
| E-EFFECTIVENESS | `E-EFFECTIVENESS-01` | exit 0 | `critical_applied_total == 0` ⇒ ACK says `partial`, never a success claim; fully applied ⇒ totals 5 / 3 reflected |
| E-OFFLINE-QUEUE | `E-OFFLINE-QUEUE-01` | exit 0 | 3 queued, drained FIFO, size 0; corrupt DB does not raise and reports empty; queueing works again after removal |
| E-AUTO-UPDATE | `E-AUTO-UPDATE-01` | exit 0 | missing signature refused; invalid signature refused; SHA mismatch refused; valid signature applied with `signature_verified: true`; unreachable server is a soft failure |

Historical note: before Phase A, `--tag <path>` exited 1 (`ERROR: No tests match
tags`) for 8 of these 9 — the tests did not exist, so no amount of window time
could have converted them into hardware-verified paths.
`tests/test_hw_harness.py::test_every_graph_enforcement_path_has_a_harness_tag`
now fails if a graph enforcement path is added without a harness test.

The harness's other seven tests (`E-DURESS`, `E-HIDDEN-FILE`, `E-TAMPER`,
`E-TPM`, `E-ENROLL`, `E-HWID`, `E-INTEGRATION`) are real coverage but they are
**not graph enforcement nodes**, so passing them moves no status.

---

## 2. The acceptance rule this runbook enforces (stricter than I3)

`graph_assert.py::assert_enforcement_path_statuses` requires only a **non-empty
`hardware_artifact_ref` string**. It never opens the file. That is how this
got through:

```console
$ python3 -c "import json;d=json.load(open('agent/hw_test_artifact_azure_bitlocker.json'));
[print(r['test_id'], r['status'], '::', r['detail'][:70]) for r in d['results']]"
E-ENCRYPT-01   PASS  :: 3 files encrypted and decrypted successfully
E-LOCK-SCREEN-01 PASS :: Lock command issued via tsdiscon (session_id=0)
E-GUARDIAN-01  PASS  :: Guardian ran for 12s, re-locked at least once, stopped cleanly
E-BCD-01       FAIL  :: BCD lockdown failed: {'success': False, 'partial': False, 'rolled_back': True}
E-HP-UEFI-01   SKIP  :: Not an HP machine
```

`E-BCD` is `verified-on-hardware` citing that file. The cited artifact records
`FAIL`. (The other cited artifact, `hw_test_artifact_azure.json`, records
`E-BCD-01 FAIL` and `E-HP-UEFI-01 SKIP` as well.)

So this runbook uses a rule I3 does not yet implement:

> **A path may be marked `verified-on-hardware` only when the artifact named in
> `hardware_artifact_ref` contains a result whose `test_id` is that path's test
> and whose `status` is `PASS`.**

`test_id` → path mapping is in §6. A passing `E-ENCRYPT-01` does **not**
evidence `E-DECRYPT`; a passing `E-INTEGRATION-01` does **not** evidence
`E-ACK`.

---

## 3. Phase A — DONE (implemented + executed, 2026-10-27)

Eight tests were added to `agent/hw_test_harness.py`, registered in
`ALL_TESTS` (12 → 20), and executed. Each drives the real agent function named
in its graph node through a local HTTP stub where a transport is involved — no
mocked `requests`, so HMAC signing, payload shaping and retry are exercised for
real.

| Test class | `test_id` | Calls | `is_network` | `default_retries` | Timeout | Asserts |
|---|---|---|---|---|---|---|
| `TestDecrypt` | `E-DECRYPT-01` | `agent.decrypt_folder` | no | — | 30s | 8 |
| `TestAck` | `E-ACK-01` | `agent.ack_command`, `write_pending_ack`, `drain_pending_ack`, `handle_lockdown` | yes | 2 | 30s | 17 |
| `TestRecovery` | `E-RECOVERY-01` | `agent.handle_unlock` | yes | 2 | 60s | 14 |
| `TestTrack` | `E-TRACK-01` | `agent.report_location` | yes | 2 | 60s | 10 |
| `TestDeadman` | `E-DEADMAN-01` | `agent.check_deadman` | no | — | 60s | 6 |
| `TestEffectiveness` | `E-EFFECTIVENESS-01` | `agent.handle_lockdown` (ACK payload) | no | — | 120s | 7 |
| `TestOfflineQueue` | `E-OFFLINE-QUEUE-01` | `agent.queue_offline` / `drain_offline_queue` | yes | 2 | 60s | 7 |
| `TestAutoUpdate` | `E-AUTO-UPDATE-01` | `agent.check_for_update` / `download_update` | yes | 2 | 90s | 12 |

Isolation: every test writes only inside its own `tempfile.TemporaryDirectory`,
and `_patch_agent_state()` repoints the agent's module-level state paths
(`PENDING_ACK_FILE`, `DEADMAN_FILE`, `OFFLINE_QUEUE_DB`, `UPDATE_*`) at that
directory. A hardware run must never read or write the live
`C:\ProgramData\LockdownSystem` state — that is the one thing that would make
a harness run destructive.

Stubs are named in each class docstring (lock screen, BIOS modules, location
report) so an artifact cannot overclaim: E-LOCK-SCREEN, E-BCD and E-HP-UEFI are
the tests that exercise those for real.

### Evidence (executed on this host, 2026-10-27)

```console
$ cd agent && python3 hw_test_harness.py --mode simulate \
    --tag E-DECRYPT,E-ACK,E-RECOVERY,E-TRACK,E-DEADMAN,E-EFFECTIVENESS,E-OFFLINE-QUEUE,E-AUTO-UPDATE
Summary: 8 passed, 0 failed, 0 skipped, 0 errors
Artifact written to: /tmp/DESKTOP-G4PCDHH-20261027-phase-a.json

# per-test detail
E-DECRYPT-01       8/8 assertions passed     E-DEADMAN-01        6/6
E-ACK-01          17/17 assertions passed    E-EFFECTIVENESS-01  7/7
E-RECOVERY-01     14/14 assertions passed    E-OFFLINE-QUEUE-01  7/7
E-TRACK-01        10/10 assertions passed    E-AUTO-UPDATE-01   12/12
```

`--mode check` reports all eight `ELIGIBLE`; `--mode dry-run` registers 20 tests
with 0 errors. Agent suite: **674 passed** (+4 harness tests). `ruff check` and
`ruff format --check` clean.

### What Phase A execution does NOT prove (read before claiming anything)

These ran on **Linux**, not on the hardware target. What that leaves unproven,
and which stream closes it:

| Unproven here | Closed by |
|---|---|
| Windows `LockWorkStation`/`tsdiscon`, Session 0 behaviour | E-LOCK-SCREEN on the machine |
| Real BCD / HP BIOS writes and their rollback | E-BCD, E-HP-UEFI on the machine |
| Signature verification of a *real* signed agent build | E-AUTO-UPDATE on the machine (it uses a generated test key here) |
| TPM-sealed state files | E-TPM with `--services tpm` |
| The firmware boot flow itself | Stream A (§4 step 3) — a serial log, not a harness artifact |

### Defect found by Phase A, and fixed

`handle_lockdown()` wrote its pending-ACK file **without** a `command_uuid`
(`write_pending_ack(..., key_material=key_b64)`), so a crash-before-ACK produced
a retry carrying a *fresh* UUID — the server's Phase 5 dedup would treat it as a
second, different result. That is exactly the "network failure retries via
pending ACK file" claim in `E-ACK`'s risk note, and it was false.

Fixed in `agent/agent.py`: one `command_uuid` per command handling, persisted
into the pending ACK and reused by every ACK of that command (including the two
`failed` paths). `E-ACK-01` now proves the whole chain — a lockdown whose ACK
returns 500 leaves a pending file, and the retry replays the **same** UUID.

---

## 4. Phase B — window day, in order

Phase A is complete (§3), so every command below is runnable as written. Order
matters: **cheap and reversible first, destructive last, so a failure late does
not cost you the evidence you already captured.**

### Step 0 — Rotate the credentials (console, not SSH)

Required because SSH is not available and the credential must be treated as
compromised:

```console
$ for h in <lan-ip> <lan-ip>; do
    timeout 4 bash -c "cat < /dev/tcp/$h/22" 2>&1 | head -1
  done
bash: connect: Connection refused      # <lan-ip>  (host answers ICMP)
bash: connect: No route to host        # <lan-ip> (no ICMP either)
```

At the machine, over console/physical access:

1. Set a new local password for the account used by `scripts/rsh.py`.
2. Record **only** the storage location (password manager), never the value —
   see the S140 incident, where the secret leaked into its own session log.
3. Export it for later steps as `RLS_SSH_PASSWORD` (never in a file in the repo).
4. If the account is not needed for automation any more, disable it instead.

Do not skip this to save time: it is the only moment the credential is
rotatable, and step 5 may want SSH.

### Step 1 — Inventory the machine (5 minutes, needed by §6)

Record, for the runbook artifact:

```powershell
# On the target Windows machine, PowerShell as Administrator
Get-CimInstance Win32_ComputerSystem  | Select-Object Manufacturer,Model
Get-CimInstance Win32_BIOS            | Select-Object SerialNumber
(Get-CimInstance Win32_ComputerSystemProduct).UUID
Get-Tpm | Select-Object TpmPresent,TpmReady,ManufacturerId
Confirm-SecureBootUEFI
Get-MpPreference | Select-Object ExclusionPath
```

Write these into the run log. They become the `hardware` field of every
artifact you file (`model`, `serial`, `uuid`, `tpm`, `secure_boot`), because
`environment` in the harness records the *platform*, not the *machine* — a
CTRF artifact that does not name the machine is not evidence of which machine.

### Step 2 — Decide the Secure Boot posture, and record it

`HARDWARE-TEST-PLAN.md` Step 4 says "Disable Secure Boot (PblApp.efi is not yet
signed — D-130)". D-130 is now settled (owner-cert + provisioning-time `db`
enrollment), so there are two legitimate postures:

| Posture | Use when | Must be recorded in the artifact |
|---|---|---|
| Secure Boot **off**, unsigned `PblApp.efi` | First bring-up; D-130 provisioning not yet done on this unit | `secure_boot: disabled`, and the run proves firmware logic only |
| Secure Boot **on**, owner `db` enrolled, signed `PblApp.efi` | D-130 provisioning has been performed on this unit | `secure_boot: enabled`, cert thumbprint, `efi_image_sha256` |

Either is acceptable evidence for the paths in §6. They are **not**
interchangeable: the second is required before claiming the fleet goal
("any company-owned Windows machine, Secure Boot on"). Record which one you
did, in the run log — an unlabelled run is not evidence.

Signing, if you take the second posture:

```bash
cd firmware/PblPkg
# --pfx <file> [--password <pw>] --efi <in> --output <out>   (sign-efi.sh:56-61)
./sign-efi.sh --pfx /secure/owner-pbl.pfx --efi PblApp.efi --output PblApp.signed.efi
./pack-persist-capsule.sh --sign /secure/owner-pbl.pem --out persist-capsule  # capsule durability
```

### Step 3 — Stream A: firmware boot flow (closes D-129 proper)

Follow `firmware/PblPkg/HARDWARE-TEST-PLAN.md` Steps 1–7, with serial capture
running from before power-on:

```bash
# Capture started BEFORE the machine boots
stty -F /dev/ttyUSB0 115200 cs8 -cstopb -parenb
cat /dev/ttyUSB0 | tee "/tmp/pbl-serial-$(date +%Y%m%d-%H%M).log"
```

Evidence is the log containing the full flow: banner → `[2/8] policy` →
`[3/8] TPM NV` → `[6/8] verdict verified` → `[7/8] PCR 12/13` → `[8/8] Decision`.
`BLOCK` is the expected outcome (no BitLocker / no kernel DMA protection) and is
**correct fail-closed behaviour**, not a failure of the test.

Then Step 7: **reboot and boot again** to prove NV persistence — second boot must
read the cached verdict instead of fetching. One boot is not the test.

### Step 4 — Stream A optional: capsule durability

`docs/HARDWARE-TEST-CAPSULE.md` if the capsule is in scope for this trip. It
proves the DXE driver survives in the firmware volume; independent of D-129's
boot-flow claim. Run it only if the trip allows — do not let it displace
Stream B.

### Step 5 — Stream B: harness runs, ordered

```bash
cd agent
export RLS_SSH_HOST=...   # only if a test needs it; never hardcode
```

**5a. Non-destructive, no service gate (fast, proves the harness works):**

```bash
python3 hw_test_harness.py --mode simulate \
  --tag E-HWID,E-DECRYPT,E-OFFLINE-QUEUE \
  --artifact "hw_test_artifact_$(hostname)-$(date +%Y%m%d)-safe.json"
```

**5b. Non-destructive Windows paths:**

```bash
python3 hw_test_harness.py --mode simulate \
  --tag E-LOCK-SCREEN,E-GUARDIAN,E-DURESS,E-HIDDEN-FILE,E-TAMPER,E-DEADMAN \
  --artifact "hw_test_artifact_$(hostname)-$(date +%Y%m%d)-windows.json"
```

**5c. TPM-gated:**

```bash
python3 hw_test_harness.py --mode simulate --services tpm \
  --tag E-TPM \
  --artifact "hw_test_artifact_$(hostname)-$(date +%Y%m%d)-tpm.json"
```

**5d. Network paths** — these retry twice by default; `--retry` overrides the
count (§7 defect 2 is fixed, so the class default is no longer dead):

```bash
python3 hw_test_harness.py --mode simulate --retry 2 \
  --tag E-ENROLL,E-ACK,E-TRACK,E-RECOVERY \
  --artifact "hw_test_artifact_$(hostname)-$(date +%Y%m%d)-network.json"
```

Requires the API on `http://localhost:3000` **on the test machine** —
`TestEnroll`/`TestIntegration` hardcode `localhost:3000`, so a server on
another host is not usable without editing the test. `TestEnroll` reads its
admin key from `RLS_ADMIN_KEY` (falling back to the dev seed key), so export it
before a real-server run.

**5e. Destructive, admin-gated, each in its own artifact** so a later failure
cannot clobber earlier evidence:

```bash
python3 hw_test_harness.py --mode simulate --services admin \
  --tag E-EFFECTIVENESS \
  --artifact "hw_test_artifact_$(hostname)-$(date +%Y%m%d)-effectiveness.json"

python3 hw_test_harness.py --mode simulate --services admin \
  --tag E-BCD --timeout 120 \
  --artifact "hw_test_artifact_$(hostname)-$(date +%Y%m%d)-bcd.json"

python3 hw_test_harness.py --mode simulate --services hp,admin \
  --tag E-HP-UEFI --timeout 180 \
  --artifact "hw_test_artifact_$(hostname)-$(date +%Y%m%d)-hp-uefi.json"

python3 hw_test_harness.py --mode simulate --retry 2 --timeout 180 \
  --tag E-INTEGRATION \
  --artifact "hw_test_artifact_$(hostname)-$(date +%Y%m%d)-integration.json"
```

**5f. Auto-update last** (it replaces the binary under test, which invalidates
`agent_binary_hash` for every run after it):

```bash
python3 hw_test_harness.py --mode simulate --retry 2 \
  --tag E-AUTO-UPDATE \
  --artifact "hw_test_artifact_$(hostname)-$(date +%Y%m%d)-update.json"
```

### Step 6 — Capture and file the artifacts

```bash
mkdir -p docs/hardware-runs/$(hostname)-$(date +%Y%m%d)
cp hw_test_artifact_*.json docs/hardware-runs/<dir>/
cp /tmp/pbl-serial-*.log  docs/hardware-runs/<dir>/
# plus the §1 inventory block, written by hand as INVENTORY.md in that dir
```

Each artifact must contain, to be usable:

- `results.extra.environment.agent_binary_hash` — non-empty, and matching the
  binary actually under test (CTRF runs only; the legacy v1.0 format lacks it)
- `results.extra.environment.hostname`
- one `results.tests[]` entry per path with `name` = the test's `test_id`
- `status` = `passed` for the paths you intend to claim

Confirmed shape of a CTRF artifact produced on this host (dry-run, three
non-Windows tags skipped, one executed):

```console
$ python3 hw_test_harness.py --mode simulate --tag E-LOCK-SCREEN,E-GUARDIAN,E-DURESS,E-HIDDEN-FILE,E-TAMPER \
    --artifact /tmp/$(hostname)-$(date +%Y%m%d)-windows.json
  [E-HIDDEN-FILE-01] Hidden file trigger -> lockdown... OK (18ms)
  [E-TAMPER-01] Agent binary tamper detection... SKIP (0ms)
Summary: 1 passed, 0 failed, 4 skipped, 0 errors
Artifact written to: /tmp/DESKTOP-G4PCDHH-20261027-windows.json

# results keys:  ['tool', 'summary', 'tests', 'extra']
# env keys:      ['platform', 'is_hp', 'hp_model', 'is_admin', 'session_context',
#                 'bitlocker_enabled', 'tpm_present', 'defender_exclusion',
#                 'agent_binary_hash', 'python_version', 'hostname']
# test names:    ['E-LOCK-SCREEN-01', 'E-GUARDIAN-01', 'E-DURESS-01',
#                 'E-HIDDEN-FILE-01', 'E-TAMPER-01']
```

Note what is **absent** from `environment`: no `model`, no `serial`, no
`uuid`, no `secure_boot`. The harness records the *platform*, not the
*machine* — which is why step 1's inventory must be filed alongside the JSON,
and why the `hardware_artifact_ref` in §6 carries the machine description.

Optional: publish to the dashboard (best-effort, non-fatal on failure):
`--upload http://localhost:3000`.

---

## 5. Abort and rollback rules

The harness already implements rollback for `is_destructive` tests (capture
before → restore after; `rollback_restored` is printed per test). The
operator-level rules on top:

| Condition | Action |
|---|---|
| `E-BCD-01` fails with `rolled_back: True` | Continue. This is the *known* Azure-VM outcome (BCD lockdown unsupported there); on real hardware a `FAIL` with rollback is an honest result, not an emergency |
| `E-BCD-01` fails with `rolled_back: False` | **Stop.** Capture `bcdedit /enum all`, then restore the BCD from the pre-run snapshot before touching anything else |
| `E-HP-UEFI-01` reports Sure Admin (EBAM) active | Expected on some HP models; the test reports `blocked`. Record it as a **capability finding** — do not mark the path verified |
| `E-HP-UEFI-01` reports `critical_applied=0`, `not_hp=false` | **Expect this.** The 2026-08-21 live run on `HP-SPARE-TEST` recorded exactly that (`agent/hw_test_artifact_live_hp.json`), and `E-BCD-01` failed in the same run. Capture the detail, then investigate the WMI setting names (D-009) before concluding the machine is at fault |
| Firmware BLOCKs with no bootable OS after reboot | No Stream B that day; finish Stream A, capture, and reimage from the USB. The USB is the recovery path |
| Any test times out | `ERROR`, not `FAIL`. Re-run once with a higher `--timeout`; a persistent timeout is a finding about the path, not the harness |

---

## 6. Post-window: exactly what to write into the graph

For each path that passed, update the node in `.devin/graph/GRAPH-SPEC.yaml`.
Fields are added to the existing node; `status` and `hardware_artifact_ref` are
the two that matter.

```yaml
  - id: E-RECOVERY
    name: unlock-recovery
    description: "Key release + decrypt + sentinel cleanup on recovery command"
    component: C-AGENT
    entry_function: "agent.handle_unlock"
    verified_by: [V-AGENT, V-SERVER, V-HW-HARNESS]
    status: verified-on-hardware
    hardware_artifact_ref: "docs/hardware-runs/<host>-<date>/hw_test_artifact_<host>-<date>-network.json#E-RECOVERY-01"
    verified_on: "<host> (<model>, UUID <uuid>) <YYYY-MM-DD>"
    risk_notes: "Key release security; sentinel cleanup"
```

The `#E-RECOVERY-01` fragment is deliberate: it names the **result** inside the
file that carries the claim, which is the §2 rule and the thing I3 does not
check today.

### Claim eligibility per path

| Path | Test that must be `PASS` in the cited artifact | Additional condition |
|---|---|---|
| E-DECRYPT | `E-DECRYPT-01` | wrong-key case asserted, not just round-trip |
| E-HP-UEFI | `E-HP-UEFI-01` | machine `is_hp: true`, `is_admin: true`, rollback restored |
| E-ACK | `E-ACK-01` | pending-ACK retry observed, not just a 200 |
| E-RECOVERY | `E-RECOVERY-01` | sentinel cleanup asserted |
| E-TRACK | `E-TRACK-01` | rate-limit/degrade path asserted |
| E-DEADMAN | `E-DEADMAN-01` | network-outage-does-not-fire asserted |
| E-EFFECTIVENESS | `E-EFFECTIVENESS-01` | `critical_applied == 0` ⇒ failure asserted |
| E-OFFLINE-QUEUE | `E-OFFLINE-QUEUE-01` | corruption recovery asserted |
| E-AUTO-UPDATE | `E-AUTO-UPDATE-01` | **bad signature rejected** asserted |

### Then

```bash
make gen-state      # regenerate current-state.md (convergence table 4/13 → n/13)
make graph-check    # all invariants (graph_assert.py, no flags = full sweep)
make graph-status   # convergence report (graph_assert.py --convergence), never raises
```

### Existing claims that do not survive §2 (correct them, don't inherit them)

| Path | Currently cited | What the file actually says | Action |
|---|---|---|---|
| `E-BCD` | `hw_test_artifact_azure_bitlocker.json` | `E-BCD-01 FAIL` | Either re-run `E-BCD` on the HP machine and cite the passing run, or demote to `verified-in-unit-test` |
| `E-ENCRYPT`, `E-LOCK-SCREEN`, `E-GUARDIAN` | `hw_test_artifact_azure.json` | all three `PASS`, but the artifact is **legacy v1.0** and carries no `agent_binary_hash` | Re-run in `--format ctrf` on the same trip to attach the hash; the claims survive either way |

---

## 7. Defects found while preparing the window

Recorded so the window does not rediscover them. Status is per 2026-10-27.

| # | Defect | Status |
|---|--------|--------|
| 1 | **`E-BCD` is `verified-on-hardware` against an artifact recording `FAIL`.** I3 (`assert_enforcement_path_statuses`) checks only that `hardware_artifact_ref` is a **non-empty string** — it never opens the file. | **OPEN** — the §6 rule is manual until I3 reads the artifact |
| 2 | **`--retry` defaulted to `0`, silently disabling `default_retries`** (`effective_retries = retries if self.is_network else 0`), so the two network tests declared retries they never got. | **FIXED** — `retries or self.default_retries` for network tests; CLI `0` now means "use the test's default". Regression test: `test_cli_zero_retries_means_use_test_default` |
| 3 | **`--tag <unknown>` exits 1** (`sys.exit(1)`), so "I ran `--tag E-DECRYPT`" read as a harness failure rather than "that test does not exist". | **OPEN** — still the right exit code (a missing test is a failure), but the message should be louder |
| 4 | **Eight of nine target paths had no harness test at all.** The previous handover ("the window converts the 9 unit-tested paths") was not achievable as planned. | **FIXED** — §3; regression test `test_every_graph_enforcement_path_has_a_harness_tag` |
| 5 | **`TestEncrypt` does the decrypt round-trip but is tagged only `E-ENCRYPT`**, so `E-DECRYPT` could not inherit its evidence. | **FIXED** — separate `E-DECRYPT-01` with the wrong-key case `TestEncrypt` lacks |
| 6 | **`TestEnroll` posted a hardcoded `admin_key: "test-admin-key"`**, so `E-ENROLL` only passes against a server seeded with the dev key — and a real-server failure would look like a path defect. | **FIXED** — reads `RLS_ADMIN_KEY`, falling back to the dev key |
| 7 | **`handle_lockdown` wrote its pending ACK without a `command_uuid`**, so a crash-before-ACK retry carried a *fresh* UUID and the server's Phase 5 dedup would see a second, different result. Found by the new `E-ACK-01`. | **FIXED** — one UUID per command, persisted and reused across every ACK of that command |
| 8 | **The `--mode check` header says "reporting test eligibility" but prints no per-test reason for a platform skip** that is not a missing service (e.g. "Not Windows"). Cosmetic. | **OPEN** — deliberately not fixed; the per-test `SKIP` line already carries the reason in `--mode simulate` |

---

## 8. Reference

| File | Role |
|---|---|
| `agent/hw_test_harness.py` | The harness (v2.0, 12 tests, tri-mode, CTRF/JUnit/legacy) |
| `.devin/skills/hw-test-harness-v2/SKILL.md` | Harness contract, patterns, how to add a test |
| `firmware/PblPkg/HARDWARE-TEST-PLAN.md` | Stream A: firmware boot flow, serial capture |
| `docs/HARDWARE-TEST-CAPSULE.md` | Stream A optional: capsule durability |
| `firmware/PblPkg/CODE-SIGNING-GUIDE.md` | D-130 signing and `db` enrollment |
| `docs/SECURE-BOOT-PROVISIONING.md` | D-130 `PK`/`KEK`/`db` provisioning sequence |
| `.devin/graph/GRAPH-SPEC.yaml` | Where §6 edits land |
| `.devin/graph/graph_assert.py` | I3 — the checker being satisfied |
| `server/src/routes/hwTestArtifact.js` | `POST /api/hw-test-artifact` (the `--upload` target) |
| `firmware/PblPkg/sign-efi.sh` | `--test` \| `--pfx` \| `--azure` signing modes |
| `firmware/PblPkg/pack-persist-capsule.sh` | `--sign <signer.pem>` `--out <dir>` capsule packing |

Make targets: `make hw-test-dry`, `make hw-test-check`, `make hw-test`.

---

## Outcome: Windows Server 2022 VM (2026-10-28)

The Windows-bound half of Phase B was finally executed, on a **KVM/OVMF VM** (8 vCPU,
8 GB, 64 GB) hosted on the ProLiant — not on hardware. Everything in §3 that needs
Windows ran for the first time.

**Result: 16 passed, 0 failed, 4 skipped** in one run (20 tests).
Evidence: `docs/hardware-runs/vm-win2022-20261028/art-full-16passed.json`
(`is_admin: true`, `bitlocker_enabled: false`, `tpm_present: false`, agent hash recorded).

| Outcome | Tests |
|---------|-------|
| **passed** | E-ENCRYPT, E-LOCK-SCREEN, E-GUARDIAN, **E-BCD**, E-DURESS, E-HIDDEN-FILE, E-TAMPER, E-HWID, E-DECRYPT, E-ACK, E-RECOVERY, E-TRACK, E-DEADMAN, E-EFFECTIVENESS, E-OFFLINE-QUEUE, E-AUTO-UPDATE |
| **skipped** | E-HP-UEFI (ProLiant has no HP *client* BIOS), E-TPM (no vTPM on this image), E-ENROLL and E-INTEGRATION (need a server on `localhost:3000`) |

### Three real bugs the run found, all fixed

1. **`bcdedit /query <entry> <element>` is not a valid command.** `_read_bcd_setting`
   used it, so **every** verification read failed and **every** BCD lockdown rolled
   back — which is why `E-BCD` reported `critical_applied=0` on the Azure VM, on real
   HP hardware *and* here. The apply had always worked; the check never did. Now uses
   `bcdedit /enum <entry>` and matches the element line.
2. **`displaybootmenu` targets the wrong entry.** It is a `{bootmgr}` element; the
   table applied it to `{default}`, which Windows rejects with *"The element data type
   specified is not recognized"*. Set/read now dispatch on the entry that owns the
   element, and the restore paths use the same dispatch.
3. **Two-layer SQLite handle leak** in the offline queue (`WinError 32`). Callers
   closed inside `try`, and `_get_queue_db()` leaked its connection when schema init
   failed on a corrupt file — invisible on Linux, fatal on Windows.

Also fixed: `E-DURESS` asserted a `duress` flag while the contract is a truthy
`duress_code` field. That test is Windows-only, so the mistake had never been
executed.

**What this does not do:** the evidence is `emulated`, not `hardware`. It does not
satisfy I3, so enforcement statuses stay as they are (`E-BCD` remains
`verified-in-unit-test` in `GRAPH-SPEC.yaml` until it passes on real hardware).
`E-HP-UEFI` cannot ever be settled by a ProLiant; it needs an HP client machine.
