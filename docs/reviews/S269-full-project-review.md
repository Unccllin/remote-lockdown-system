# Full project review — 2026-11-16 (session 269, rev 2)

Scope: firmware (PBL), agent, serverless Worker, Express server, dashboard, CI and
test gates, state/ledger honesty, security posture, and readiness for the D-129
hardware window.

Method: every number below was **measured on this host** during this review; every
claim about code is cited to file:line. Where a gate could not run, the reason is
recorded. Rev 2 corrections, all forced by review feedback: the coverage gates were
re-run rather than excused, `make trace-review` was run (it was red) and its false
positives were fixed, and the admin-hashing finding was rewritten because the code's
own comment contradicts the way rev 1 framed it.

---

## 1. Gate matrix — measured

### 1.1 Suite results

| Gate | Command | Result |
|---|---|---|
| Agent tests | `scripts/run-agent-tests.sh` | **866 passed** (36.6 s) |
| Server tests | `make test-server` | **843 passed**, 51 suites |
| Worker tests | `serverless && npx vitest run` | **429 passed**, 2 files |
| Dashboard tests | `dashboard && npx vitest run` | **260 passed**, 29 files |
| API/agent E2E | `make test-e2e` | **14 passed**, 4 suites |
| Firmware host tests | `make firmware-host-tests` | **195 checks / 0 failures** (19+8+8 cases) |
| Script harness | each `scripts/test_*.py` | 13 pass, 1 blocked (see 1.4) |
| QEMU + swtpm smoke | PBL CI run 43581206874 | **14 PASS / 0 FAIL** |
| Graph invariants | `make graph-check` | all pass |
| Graph session suite | `scripts/test_graph_session.py` | **40 passed** |
| Enforcement citations | `artifact_supports_claim` × 11 refs | **11 valid / 0 invalid** |
| Trace honesty gate | `make trace-review` | **7 passed / 0 failed** (see §5.1) |
| Worker smoke (HTTP) | `make verify-worker` | **pass** — with a correct `.dev.vars`; see §5.4 |
| Worker update E2E | `make test-worker-e2e` | **5 passed** (38 s) |
| Formatting | `make format-check` | **63 files already formatted** |
| Licence inventory | `make check-licenses` | exit 0; reports `react-leaflet` / `@react-leaflet/core` Hippocratic-2.1 and **rewrites `THIRD-PARTY-NOTICES.md`** as a side effect |

### 1.2 Coverage gates — run, not assumed

| Component | Statements | Branches | Functions | Lines | Floor | Verdict |
|---|---|---|---|---|---|---|
| Agent | **64.63 %** (TOTAL) | — | — | — | 59 % | reached |
| Server | **74.43 %** (2818/3786) | 71.05 % | 79.80 % | **75.32 %** | per-component | reached |
| Dashboard | **69.98 %** (963/1376) | 65.49 % | 62.03 % | **70.88 %** | 68 / 61 / 62 / 70 | reached on all four |
| Worker | **90.25 %** (1399/1550) | **85.69 %** (1120/1307) | 95.97 % | **92.74 %** | per-component | reached (a second independent run reported 85.46 % branches, so treat it as ≈85.5 %) |
| Electron | not measured | — | — | — | — | blocked, see 1.3 |

`make test-coverage` as a single target aborts at the Electron step (it runs last), so
the agent and server components were run from their own recipes to get the numbers
above. The aggregate target therefore reports failure while four of five components
are green.

### 1.3 Lint / type / contract gates

| Gate | Result |
|---|---|
| `lint-server` | pass |
| `lint-dashboard` | pass |
| `typecheck-worker` | pass |
| `check-openapi` | pass |
| `check-debt-ledger` | pass |
| `check-firmware-todos` | pass |
| `verify-env` | pass (51 PASS / 8 SKIP by its own summary) |
| `check-artifacts` | pass |

### 1.4 Gates that genuinely cannot run here, with the reason

| Gate | Why |
|---|---|
| `scripts/test_tls_floor.py` | starts `docker run caddy`; daemon inactive (`permission denied /var/run/docker.sock`) |
| `make firmware-qemu` | needs docker (same) |
| local `make firmware-build` | no `nasm`, no `iasl`; available only in CI |
| Electron tests and coverage | `electron/node_modules` absent |
| `test-e2e-dashboard` | **Playwright browser binary missing**: `browserType.launch: Executable doesn't exist at ~/.cache/ms-playwright/chromium_headless_shell-1234/...` — no test executed |
| `lint-workflows` | `actionlint` not installed (CI pins v1.7.12) |
| `make sast` (Semgrep) | semgrep not installed |
| CodeQL | private-repo feature unavailable |

---

## 2. Documentation drift — documented vs measured

| Claim | Where | Documented | Measured | Status |
|---|---|---|---|---|
| Agent test count | `AGENTS.md:261,446,508` | 863 | **866** | stale (+3 from S268) |
| `test_hw_window_preflight.py` size | `AGENTS.md:572` | 14 | **21** | stale (+4 S268, +2 S269) |
| Server / dashboard / worker / E2E | `AGENTS.md:260,262,264` | 843 / 260 / 429 / 14 | same | accurate |
| Firmware host tests | `AGENTS.md:364` | 35 cases / 195 checks | same | accurate |
| Coverage floors | `AGENTS.md:266` | 68 / 61 / 62 / 70 (dashboard) | 69.98 / 65.49 / 62.03 / 70.88 | accurate |

Two counts drifted within days of S267 re-measuring them, both from S268's own work.

---

## 3. Debt and ceiling honesty

### D-129 — "No real hardware validation" — **criteria conflict; needs a ruling**

- `docs/adr/PBL-DEBT-LEDGER.md` (D-129): *"Boot PblApp.efi on real UEFI hardware **(or a
  real UEFI VM with swtpm)**. Capture serial/log output showing the full PBL boot flow."*
- `.devin/graph/GRAPH-SPEC.yaml:1162`: *"Boot PblApp.efi on **real UEFI hardware**, capture
  serial/log output"* — no VM allowance. `trace.md:448` repeats the stricter reading.

Measured: the QEMU+swtpm harness boots the artifact under OVMF (real UEFI firmware) with a
TPM 2.0 simulator and captures the whole flow — `[1/8]`→`[8/8] Decision: BLOCK`,
`[OK] Lock state cached to TPM NV`, self-image hash match. **That satisfies the ledger text
and not the spec.** Closing or amending is a decision; leaving both is the worst option.

### D-134 — platform-hierarchy NV — **honest, hardware-bound**

Close criteria require the HP machine's log (`device_id from AK Name`) plus `TPM2_Clear`
handling, and the ledger states QEMU cannot answer the firmware half because it depends on
the target's `platformAuth` policy. Measured in QEMU: `NV_Read(AK_NAME) RC=0x18B` — Device
Error, hierarchy unavailable. Consistent and correctly scoped.

### D-120 — BitLocker detection — **summary surfaces stale; ledger right**

`GRAPH-SPEC.yaml:1085` and the state summary say *"BitLocker detection not implemented"*.
The code and ledger say otherwise:

- `PblCollectBcdState` parses the real BCD hive (`Bcd.c`);
- `Fve.c` / `PblCheckFve` scans DiskIo for `-FVE-FS-`, walks VMK records, sets
  `FveProtectionMask` / `FveClearKeyOnly` (ledger update 2026-09-17);
- the ledger's own blocker: *"BCD still does not contain the actual BitLocker
  locked/unlocked state; that requires FVE volume metadata and TPM state."*

Honest residual: **never measured against a real BitLocker-protected volume.** Two surfaces
understate work already done.

### D-130 — code signing — **honest, narrowed**

Ledger records signing proven in QEMU (sbsign/`sbverify`, Secure Boot load, Step 5
passing) with named remainders (db/dbx content, provisioning). The reviewed artifact is
unsigned and `secure_boot:false`, consistent with the item being open.

### E-BCD / E-HP-UEFI — **honest ceilings**

Both recorded as not hardware-verifiable by decision (S264): a failed run rewrites boot
configuration or sets a firmware Setup Password the test cannot undo. Nothing in this review
found a safe path, so 11/13 stands as stated.

---

## 4. Security posture

### 4.1 Admin password hashing — a platform ceiling and a cross-surface divergence

Rev 1 called this "new admins are weaker than old". That framing was wrong, and the code
says so in the place it matters (`serverless/worker.ts:442-449`):

> Cloudflare Workers' WebCrypto caps PBKDF2 at 100,000 iterations (`NotSupportedError` above
> that). 210k was the NIST floor we targeted but it crashes on the real Workers runtime
> (error 1101 on create-admin). 100k is the platform max… *Iteration count used for admins
> created before `pbkdf2_iterations` was recorded — which only ever ran in Node tests, never
> on the live Worker, so no live admin uses it.*

So there is no regression. What is actually true, measured:

| Surface | Scheme | Evidence | Note |
|---|---|---|---|
| Express server | bcrypt, cost **12** | `server/src/routes/admins.js:81` | modern work factor |
| Worker | PBKDF2-SHA256, **100,000** | `worker.ts:447` | hard platform maximum, documented |
| Worker (legacy record path) | PBKDF2, 210,000 | `worker.ts:451` | never used on the live Worker |

Two honest findings remain:

1. **The platform caps the Worker below current guidance.** OWASP's figure for
   PBKDF2-HMAC-SHA256 is ~600k; Workers allows 100k. That is a real, accepted constraint —
   but it is only recorded in a code comment, and it belongs in the debt ledger or an ADR so
   the acceptance is reviewable rather than incidental.
2. **The two surfaces use different algorithms, with no migration path.** An admin record
   copied from KV to SQLite (or the reverse) cannot authenticate, and nothing pins the
   contracts against each other — `test_cross_surface_contract.py` passes without covering
   this. If the deployment ever consolidates surfaces, every admin must reset.

### 4.2 Everything else checked

| Item | Measurement | Verdict |
|---|---|---|
| Break-glass `ADMIN_TOKEN` | `===` against a Cloudflare secret; no repo fallback (`worker.ts:374`) | correct |
| Session token | HS256, `exp` enforced, constant-time compare (`worker.ts:596-624`) | correct |
| TTL | 8 h (`worker.ts:452`) | acceptable; no rotation/refresh |
| Dashboard token | `localStorage` (`dashboard/src/api/client.js:16`) | XSS-exfiltratable; undocumented trade-off |
| CORS | `*` with Bearer-only auth (`worker.ts:TOKEN_API_CORS_ORIGIN`) | defensible, rationale in code |
| Agent TLS | `https` required unless `verify_tls=false` (`agent.py:508-519`) | good guard |
| Repo secrets | `git ls-files secrets/` empty; no `.pem/.pfx/.key/.env` tracked; `.dev.vars` ignored | clean |
| Firmware signing | artifact unsigned → Secure Boot must be off | consistent with D-130 open |
| `TpmClient.c` header | claims HMAC session + NV cache write are *"stubbed with TODO markers"* (`TpmClient.c:16`) | **false**: both implemented and exercised (`PblApp.c:481`, `PblApp.c:781`), no TODO markers remain |

---

## 5. Verification integrity

### 5.1 `make trace-review` was red — and its checks were misreading prose

At HEAD it reported **12 passed / 3 failed** for session 269, none of them a real missing
file:

| Failed check | Cause |
|---|---|
| `file PblApp.efi` | a bare artifact filename in prose parsed as a repo-root path |
| `file MdePkg/…/SecPeiDxeTimerLibCpu.inf` | an **EDK II submodule** path; it lives in `EDK2_DIR`, never in this repo |
| `function PblApp is defined` | the CI job title *Build PblApp (X64, GCC)* matched the `PblXxx(` pattern |

Fixed in `scripts/trace_reviewer.py`: bare filenames are no longer treated as path claims,
EDK II package prefixes (`MdePkg/`, `OvmfPkg/`, `CryptoPkg/`, `SecurityPkg/`,
`NetworkPkg/`, `MdeModulePkg/`, `BaseTools/`) are recognised as external, and `PblApp` (the
application, not a function) is excluded. The gate now reports **6 passed / 0 failed**, so
it is green *and* still checks the claims it was built for.

### 5.2 The QEMU smoke test was theatre until S269

Three harness defects hid the firmware completely: `-nographic` vs `-serial mon:stdio`
contending for stdio; OVMF hanging in `PlatformPei` on the CPU-hotplug bugcheck before
`BdsDxe`; and a completion check demanding a string the BLOCK path never prints. All fixed;
the gate now reports 14/14 on a real boot. Any earlier statement of the form "the smoke test
fails" carried no information.

### 5.3 Standing integrity gaps

- **`build-aarch64` can never pass.** `PblPkg.dsc:18` claims `X64|AARCH64` while `TimerLib`
  maps to `SecPeiDxeTimerLibCpu`, whose sources are x86-only →
  `F000: No files to be built in module [RELEASE, GCC, AARCH64]`.
- **`make test-scripts` stops at the first failure** (`|| exit 1`); on this host that is the
  docker-dependent `test_tls_floor.py`, so everything alphabetically after it — including
  `test_worker_update_e2e.py` — never runs under `make`.
- **Two ruff versions disagree about `agent/`, and `make` uses whichever is first on `PATH`.**
  `make lint-agent` (PATH `python3` → ruff **0.17.5**) reports **All checks passed**. The
  repository's own `agent/.venv` carries ruff **0.5.0**, which reports **6 findings** in
  `agent/agent.py` (3 proven flow false positives — eight-line repro in `trace.md`, S268
  Addendum 6 — and 3 `UP038`). CI does `pip install ruff`, i.e. latest, so CI is green. Rev 2 of
  this review called `make lint-agent` red; that was wrong, and the version was undisclosed.
  The real finding is that the linter is **unpinned**, so "green" depends on which interpreter
  runs it.
- **`make test-coverage` aborts at Electron**, so one blocked optional component makes the
  aggregate gate report failure while four components are green.
- **`actionlint` and Playwright browsers are absent here**, so `lint-workflows` and
  `test-e2e-dashboard` cannot be evaluated on this host at all.

### 5.4 A verification gate silently poisoned by a local dev file

`make verify-worker` was red on this host — `POST /v1/verdict -> 500`,
`GET /v1/policy/1 -> 500`, "worker verification FAILED" — while all 429 Worker unit tests passed.
Cause, measured: `wrangler dev` merges `serverless/.dev.vars` unconditionally, and that file
carried `PBL_SIGNING_KEY` / `PBL_POLICY_SIGNING_KEY` set to random hex created earlier in this
session for local development. The Worker tries to parse them as keys, throws, and `/v1/*`
answers 500. Moving the file aside makes the gate **pass (exit 0)**; so does removing just the two
`PBL_*` lines, after which `/v1/verdict` answers 400 to a junk body and `/v1/policy/1` serves a
blob.

Two things are wrong here, and neither is in the Worker's logic:

1. **The gate does not isolate itself from developer state.** A verification target that is
   supposed to prove the bundle builds and routes answer should not be at the mercy of a
   gitignored file; it should pass its own `--var`s for every secret it depends on.
2. **The README asserted the opposite of the truth** — that random `PBL_*` values "make those
   paths fail closed, which is the right local default". They make them 500. Corrected in
   `serverless/README.md`.

This is the same class as §5.1: a gate whose result depends on something other than what it
claims to measure, which is why it is recorded here rather than dismissed as a local quirk.

---

## 6. Risks not tracked by any ledger item or graph node

| # | Risk | Evidence | Suggested disposition |
|---|---|---|---|
| R1 | Worker admin hashes are capped at 100k PBKDF2 iterations by the platform, below current guidance | `worker.ts:442-449` | record the accepted constraint in the ledger/ADR, not only a code comment |
| R2 | No migration path between bcrypt (server) and PBKDF2 (Worker) admin records | `admins.js:81` vs `worker.ts:447` | add a re-hash-on-login path, or pin the divergence with a contract test |
| R3 | `TpmClient.c` misdescribes the shipped implementation | `TpmClient.c:8-18` | documentation fix |
| R4 | D-129 close criteria contradict the graph spec | ledger vs `GRAPH-SPEC.yaml:1162` | ruling required |
| R5 | `build-aarch64` permanently red while the DSC claims AARCH64 | run logs, `PblPkg.dsc:18` | drop the claim or port |
| R6 | Semgrep cannot parse 19 files incl. newest firmware | S267 record, not re-measured (semgrep absent) | re-measure when available |
| R7 | `trace-review` had a false-positive class that could hide real red | §5.1 | fixed; keep the negative tests |
| R8 | `make verify-worker` reads developer `.dev.vars`, so local secrets can fail a verification gate | §5.4 | pass every needed secret as `--var` in the script |
| R9 | Ruff is unpinned: `make lint-agent` is green under 0.17.5 and red under the venv's 0.5.0 | §5.3 | pin the version in both places, or record which one is authoritative |
| R10 | `make check-licenses` rewrites a tracked file (`THIRD-PARTY-NOTICES.md`) as a side effect of a read-only-looking gate | measured, §1.1 | make it write only with an explicit flag |

---

## 7. Operational readiness for the D-129 window

Ready and evidenced without the laptop:

- artifact published and hash-verified after copy on the target ESP:
  `firmware/PblPkg/artifacts/PblApp-6fa6ac418b726075.efi`, `sha256 6fa6ac41…`, PE32+ x86-64
  with `.reloc`;
- behaviour asserted in firmware: loads, runs `[1/8]`→`[8/8]`, writes TPM NV, self-image hash
  matches, decides `BLOCK`;
- precondition gate real: `hw-preflight --check` fails on `tracking`/`locked`/`stolen` and
  reports `status=active` from live KV.

Remaining input: real firmware on the target machine. The line that closes D-134 is `[3/8]`'s
`NV_Read(AK_NAME) RC=…`. The run is under **Secure Boot off**, so nothing today can evidence
the fleet claim ("any company-owned machine, Secure Boot on") — that needs D-130.

---

## 8. Ranked findings

| # | Severity | Finding | Evidence | Action |
|---|---|---|---|---|
| 1 | **High** | D-129's close criteria conflict; the repository now contains a run satisfying one and not the other | §3, `GRAPH-SPEC.yaml:1162`, ledger D-129 | rule, then amend the loser |
| 2 | **Medium** | Admin hashing differs per surface (bcrypt 12 vs PBKDF2 100k) with no migration path | §4.1 | re-hash on login, or pin with a contract test |
| 3 | **Medium** | Worker PBKDF2 is capped at 100k by the platform, below current guidance; recorded only in a comment | §4.1, `worker.ts:442-449` | record the accepted constraint in the ledger/ADR |
| 4 | **Medium** | D-120 described as "not implemented" while BCD and FVE parsing exist and are QEMU-tested | §3, `Fve.c` | correct `GRAPH-SPEC.yaml:1085` + state summary |
| 5 | **Medium** | `TpmClient.c` says HMAC sessions and NV writes are stubbed; they are implemented and exercised | §4.2 | fix the comment |
| 6 | **Medium** | Documented counts drifted again (863→866, 14→21) | §2 | update `AGENTS.md`; consider asserting counts |
| 7 | **Medium** | `build-aarch64` can never pass while the DSC claims AARCH64 | §5.3 | drop the claim or port |
| 8 | **Low** | Screening tools that cannot run here are indistinguishable from passing ones (`actionlint`, Playwright, docker tests) unless recorded | §1.4 | keep this matrix in the repo, refresh per session |
| 9 | **Low** | `make test-scripts` never reaches its last file under `make` | §5.3 | run each file, or make the docker test opt-in |
| 10 | **Low** | Dashboard keeps its JWT in `localStorage` | §4.2 | state the trade-off beside the decision |
| 11 | **Medium** | `make verify-worker` is poisoned by developer `.dev.vars`: a red gate on the Worker that says nothing about the Worker | §5.4 | pass secrets via `--var`; drop `PBL_*` from the README's dev recipe (done) |
| 12 | **Low** | Ruff is unpinned, so `make lint-agent` is green or red depending on which interpreter runs it | §5.3 | pin one version |
| 13 | **Low** | `make check-licenses` mutates `THIRD-PARTY-NOTICES.md` while reporting | §1.1 | write only on an explicit flag |

---

## 9. What this review did not establish

- **Electron**: tests and coverage unverified (`node_modules` absent); the 30-test claim is
  inherited, not measured.
- **Coverage aggregate**: measured per component (§1.2) but `make test-coverage` as a whole
  cannot pass on this host because Electron is blocked.
- **Gate isolation**: §5.4 shows at least one gate (`verify-worker`) depends on developer state;
  no attempt was made to audit the other ~20 targets for the same property.
- **SAST / CodeQL**: unverified (semgrep absent, private-repo CodeQL unavailable); the "19
  unparsed files" figure is S267's, not re-measured.
- **Playwright E2E** and **actionlint**: not evaluated here (missing browser binary and tool).
- **Target firmware behaviour**: no conclusion until the artifact boots on the machine.
