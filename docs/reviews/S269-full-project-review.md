# Full project review — 2026-11-16 (session 269)

Scope: firmware (PBL), agent, serverless Worker, Express server, dashboard, CI and
test gates, state/ledger honesty, security posture, and readiness for the D-129
hardware window.

Method: every number below was **measured on this host** during this review;
every claim about code is cited to file:line. Nothing is taken from a previous
session's notes. Where a gate could not run, the reason is recorded rather than
the gap left silent. The repository's own rule is the standard applied here:
*a documented green and a measured green are different objects.*

---

## 1. Gate matrix — measured

| Gate | Command | Result |
|---|---|---|
| Agent tests | `scripts/run-agent-tests.sh` | **866 passed** (36.6 s) |
| Server tests | `make test-server` | **843 passed**, 51 suites (60 s) |
| Worker tests | `cd serverless && npx vitest run` | **429 passed**, 2 files |
| Dashboard tests | `cd dashboard && npx vitest run` | **260 passed**, 29 files |
| API/agent E2E | `make test-e2e` | **14 passed**, 4 suites |
| Firmware host tests | `make firmware-host-tests` | **195 checks / 0 failures** (CBOR 19/97, TPM 8/86, COSE 8/12) |
| Script harness | each `scripts/test_*.py` individually | 13 pass, 1 blocked |
| Graph invariants | `make graph-check` | all pass |
| Enforcement citations | `artifact_supports_claim` over all 11 refs | **11 valid / 0 invalid** |
| QEMU + swtpm smoke | PBL CI run 43581206874 | **14 PASS / 0 FAIL** |

**Could not run here, with the reason:**

| Gate | Why |
|---|---|
| `scripts/test_tls_floor.py` | starts `docker run caddy`; docker daemon inactive, needs root |
| `make firmware-qemu` | needs docker (same) |
| `make firmware-build` (local) | no `nasm`, no `iasl`; available only in CI |
| Electron tests (30 claimed) | `electron/node_modules` absent |
| `make test-coverage` (5 components, floors) | not re-measured in this review — floors were last verified S267; not re-asserted here |
| `make sast` / Semgrep | semgrep not installed; 19 unparsed files remain the last known state |
| CodeQL | private-repo feature unavailable |

---

## 2. Documentation drift — documented vs measured

| Claim | Where | Documented | Measured | Status |
|---|---|---|---|---|
| Agent test count | `AGENTS.md:261,446,508` | 863 | **866** | stale (+3 from S268's upload tests) |
| `test_hw_window_preflight.py` size | `AGENTS.md:572` | 14 | **21** | stale (+4 status tests S268, +2 empty-fleet S269) |
| Server / dashboard / worker / E2E | `AGENTS.md:260,262,264` | 843 / 260 / 429 / 14 | same | accurate |
| Firmware host tests | `AGENTS.md:364` | 35 cases / 195 checks | same | accurate |
| Enforcement paths on hardware | `current-state.md` | 11 / 13 | 11 refs valid | accurate |

Two counts drifted within days of S267 re-measuring them, both from S268's own
work. That is the failure mode the repo already diagnosed; it recurred because
nothing forces a count update when a test is added.

---

## 3. Debt and ceiling honesty

### D-129 — "No real hardware validation" — **criteria conflict, decide it**

Two authoritative documents disagree:

- `docs/adr/PBL-DEBT-LEDGER.md` (D-129, close criteria): *"Boot PblApp.efi on real
  UEFI hardware **(or a real UEFI VM with swtpm)**. Capture serial/log output
  showing the full PBL boot flow."*
- `.devin/graph/GRAPH-SPEC.yaml:1162`: *"Boot PblApp.efi on **real UEFI hardware**,
  capture serial/log output"* — no VM allowance. `trace.md:448` repeats the
  stricter reading.

Measured today: the QEMU+swtpm harness boots PblApp under real UEFI firmware
(OVMF), with a TPM 2.0 simulator, and captures the full flow —
`[1/8]` through `[8/8] Decision: BLOCK`, `[OK] Lock state cached to TPM NV`,
self-image hash match. **That satisfies the ledger's text and not the spec's.**

Verdict: the item cannot be assessed as "honest either way" until someone rules.
Either close D-129 under the ledger's own criteria and amend the spec to match,
or amend the ledger to drop the VM allowance and record why physical hardware is
required. Leaving two contradictory criteria is the worst of the three.

### D-134 — platform-hierarchy NV — **honest, hardware-bound**

Close criteria require the *HP machine's* log showing `device_id from AK Name`
with a `TPM2_Clear` treated as unenrolled, and the ledger states explicitly that
QEMU cannot answer the firmware half because it depends on the target firmware's
`platformAuth` policy. Measured in QEMU: `NV_Read(AK_NAME) RC=0x18B` — Device
Error, platform hierarchy unavailable. Consistent, correctly scoped, honest.

### D-120 — BitLocker detection — **summary surfaces are stale; ledger is right**

`current-state.md` and `GRAPH-SPEC.yaml:1085` describe D-120 as *"BitLocker
detection not implemented"*. The ledger and the code say otherwise:

- `PblCollectBcdState` parses the real BCD hive (`firmware/PblPkg/PblApp/Bcd.c`).
- `Fve.c` / `PblCheckFve` scans DiskIo for `-FVE-FS-`, walks VMK records and sets
  `FveProtectionMask` / `FveClearKeyOnly` (`PBL-DEBT-LEDGER.md`, update 2026-09-17).
- Ledger's own blocker: *"BCD still does not contain the actual BitLocker
  locked/unlocked state; that requires FVE volume metadata and TPM state."*

So the real remaining gap is *no real BitLocker-protected volume has been
measured*, not "not implemented". Two surfaces understate work already done.

### D-130 — code signing — **honest, narrowed**

Ledger records signing proven in QEMU (sbsign + `sbverify` + Secure Boot load,
Step 5 passing) with remaining items named (db/dbx content, provisioning). The
shipped artifact under review is **unsigned** (`secure_boot:false` posture), which
is consistent with the open item.

### E-BCD / E-HP-UEFI — **honest ceilings**

Both are recorded as not hardware-verifiable by decision (S264) because a failed
run rewrites boot configuration or sets a firmware Setup Password that the test
cannot undo. Nothing in this review found a way to verify them safely, so the
11/13 ceiling stands as stated.

---

## 4. Security posture

### 4.1 Password hashing is inconsistent across surfaces — **the finding of this review**

| Surface | Scheme | Evidence |
|---|---|---|
| Express server | bcrypt, cost **12** | `server/src/routes/admins.js:81` |
| Worker, new admin | PBKDF2-SHA256, **100,000** iterations | `serverless/worker.ts:447` |
| Worker, legacy admin | PBKDF2-SHA256, **210,000** iterations | `serverless/worker.ts:451` |

Two problems, both measured:

1. **The work factor went down.** A newly created Worker admin is hashed with
   100k iterations while older admins keep 210k — new credentials are the weakest
   ones. OWASP's current guidance for PBKDF2-HMAC-SHA256 is ~600k.
2. **The two surfaces disagree on the algorithm entirely.** There is no migration
   path between them: an admin record copied from KV to SQLite (or the reverse)
   cannot authenticate. `scripts/test_cross_surface_contract.py` passes, so
   nothing currently pins this.

### 4.2 Everything else checked, with the verdict

| Item | Measurement | Verdict |
|---|---|---|
| Break-glass `ADMIN_TOKEN` | compared with `===` to a Cloudflare secret; no repo fallback (`worker.ts:374`) | correct — no fallback constant to guess |
| Session token | HS256, `exp` enforced, constant-time compare (`worker.ts:596-624`) | correct |
| Token TTL | 8 h (`worker.ts:452`) | acceptable for an admin console; no refresh/rotation |
| Dashboard token storage | `localStorage` (`dashboard/src/api/client.js:16`) | exfiltratable by any XSS in the console; acceptable trade-off, undocumented |
| CORS | `Access-Control-Allow-Origin: *` with Bearer-only auth (`worker.ts:TOKEN_API_CORS_ORIGIN`) | defensible, rationale documented in code |
| Agent TLS | `https` required unless `verify_tls=false` explicitly (`agent.py:508-519`) | good guard; the override is the documented dev path |
| Repo secrets | `git ls-files secrets/` → empty; no `.pem/.pfx/.key/.env` tracked; `serverless/.dev.vars` ignored | clean |
| Firmware signing | artifact is unsigned; Secure Boot must be off | consistent with D-130 being open; blocks the fleet claim |
| TpmClient documentation | header says HMAC session + NV write are *"stubbed with TODO markers"* (`TpmClient.c:16`) | **false**: both are implemented and exercised (`PblApp.c:481`, `PblApp.c:781`); no TODO markers remain in the file |

---

## 5. Verification integrity (CI)

- **The QEMU smoke test was theatre until this session.** It reported 0/14 on
  every run because (a) `-nographic` and `-serial mon:stdio` contended for stdio,
  (b) OVMF hung in `PlatformPei` on the CPU-hotplug bugcheck before `BdsDxe`, and
  (c) the completion check demanded a string the BLOCK path never prints. All
  three are fixed; the gate now reports 14/14 on a real boot. Any historical
  statement of the form "the smoke test fails" carried no information.
- **`build-aarch64` can never pass.** `PblPkg.dsc:18` declares
  `SUPPORTED_ARCHITECTURES = X64|AARCH64` and maps `TimerLib` to
  `SecPeiDxeTimerLibCpu`, whose sources are x86-only — hence
  `F000: No files to be built in module [RELEASE, GCC, AARCH64]`. A permanently
  red job trains reviewers to ignore red.
- **`make test-scripts` stops at the first failure** (`|| exit 1`), and on this
  host that is `test_tls_floor.py` (docker). Everything alphabetically after it —
  including `test_worker_update_e2e.py` — never runs under `make`, though all 13
  files pass individually.
- **`make lint-agent` is red at HEAD** with 6 findings in `agent/agent.py`, three
  of which are a proven ruff-0.5.0 flow false positive (eight-line repro in
  `trace.md`, S268 Addendum 6). The other three are `UP038` style.
- Gates that cannot run here (coverage, SAST, CodeQL, electron) are listed in §1
  rather than assumed green.

---

## 6. Risks not tracked by any ledger item or graph node

| # | Risk | Evidence | Suggested disposition |
|---|---|---|---|
| R1 | Admin password work factor varies by surface and by age (§4.1) | three code sites above | new debt item: *admin hashing is per-surface and non-increasing* |
| R2 | No path to migrate admins between KV and SQLite | bcrypt vs PBKDF2 | record as constraint, or add a re-hash-on-login migration |
| R3 | `TpmClient.c` header misdescribes the shipped implementation (§4.2) | `TpmClient.c:8-18` | documentation fix, no code change |
| R4 | D-129 close criteria contradict the graph spec (§3) | ledger vs `GRAPH-SPEC.yaml:1162` | ruling required; either close or amend |
| R5 | `build-aarch64` is a permanently failing job (§5) | run logs | drop the AARCH64 claim from the DSC + job, or port |
| R6 | Firmware comment claims a security path is stubbed when it is not | same as R3 | merge with R3 |
| R7 | Semgrep cannot parse 19 files, including the newest firmware (`host_tpm.c`, `host_crypto.c`, `test_cose_verify.c`) | S267 record, not re-measured here (semgrep absent) | re-measure when semgrep is available |

Two of these (R1, R4) are decisions, not chores; both are cheap now and expensive
after the fleet claim is made.

---

## 7. Operational readiness for the D-129 window

Ready, and evidenced without the laptop:

- artifact built, hashed and published: `firmware/PblPkg/artifacts/PblApp-6fa6ac418b726075.efi`,
  `sha256 6fa6ac41…`, PE32+ x86-64 with `.reloc`, verified after copy on the target ESP;
- behaviour asserted in firmware: loads, runs `[1/8]`→`[8/8]`, writes TPM NV,
  self-image hash matches, decides `BLOCK`;
- precondition gate real: `hw-preflight --check` fails on `tracking`/`locked`/`stolen`
  and reports `status=active` from live KV.

Remaining input: **real firmware on the target machine**. The single line that
closes D-134 is `[3/8]`'s `NV_Read(AK_NAME) RC=…` — `[OK]` closes it as
"production PCD is fine"; `0x9A2`/`0x18B` closes it the other way and requires a
rebuild with `PcdPblTpmUsePlatformHierarchy=FALSE` plus both logs.

Constraint to record in the artifact: the run is under **Secure Boot off**, which
means no run today can evidence the fleet claim ("any company-owned machine,
Secure Boot on"); that needs D-130 provisioning.

---

## 8. Ranked findings

| # | Severity | Finding | Evidence | Action |
|---|---|---|---|---|
| 1 | **High** | D-129's close criteria conflict between ledger and graph spec; the repository now contains a run that satisfies one and not the other | §3, `GRAPH-SPEC.yaml:1162`, ledger D-129 | rule on it; then amend the loser |
| 2 | **High** | Admin password hashing is weaker for new admins than old, and differs per surface | §4.1, three code sites | raise iterations to a modern floor, or migrate to one scheme; add a test |
| 3 | **Medium** | D-120 is described as "not implemented" while BCD and FVE parsing are implemented and QEMU-tested | §3, `Fve.c`, ledger update 2026-09-17 | correct `GRAPH-SPEC.yaml:1085` and the state summary |
| 4 | **Medium** | `TpmClient.c` says HMAC sessions and NV cache write are stubbed; they are implemented and exercised | §4.2 | fix the comment |
| 5 | **Medium** | Documented test counts drifted again (863→866, 14→21) days after a re-measure | §2 | update `AGENTS.md`; consider asserting counts in a test |
| 6 | **Medium** | `build-aarch64` can never pass, and the DSC claims AARCH64 | §5, `PblPkg.dsc:18` | drop the claim or port; do not leave a red job |
| 7 | **Low** | `make test-scripts` never reaches the last file under `make` | §5 | run each file, or make the docker test opt-in |
| 8 | **Low** | Dashboard stores the JWT in `localStorage`; undocumented trade-off | §4.2 | state the trade-off next to the decision, or move to memory + refresh |

---

## 9. What this review did not establish

- Coverage floors were **not** re-measured (§1). The last verified values are from
  S267; treat them as unverified until `make test-coverage` runs.
- SAST/CodeQL status is unchanged and unverified here (tools unavailable).
- Electron behaviour is unverified (`node_modules` absent); the 30-test claim is
  inherited, not measured.
- No conclusion is drawn about the target machine's firmware behaviour until it
  boots the artifact.
