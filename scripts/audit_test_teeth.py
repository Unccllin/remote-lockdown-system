#!/usr/bin/env python3
"""audit_test_teeth.py — would each 'verified-in-unit-test' path's suite notice a regression?

Why this exists
---------------
The graph marks ten enforcement paths `verified-in-unit-test`. That status means
"a test exists and passes", which is not the same as "the test would fail if the
feature regressed". The difference is not academic: session 169 shipped an
assertion that read the lock state through a path the bug never touched, so it
would have passed with the defect reinstated.

This script answers the question the only way that actually settles it — by
reintroducing the defect and running the suite. Each row is a *semantic* mutation
of the line that makes the feature work (skip the decryption, always claim the
setting applied, never check the deadman switch), not a cosmetic edit.

  KILLED    the suite failed -> the test has teeth
  SURVIVED  the suite passed -> the test does not test this behaviour

Usage:
  scripts/audit_test_teeth.py                 # run every mutation (~2 min)
  scripts/audit_test_teeth.py --path E-ACK    # one path
  scripts/audit_test_teeth.py --list          # show the table, change nothing

Exit code: 0 when every mutation is killed, 1 when any survives (a finding).

Safety: the mutated file is snapshotted in memory and restored in a `finally`
block, so a crash cannot leave a mutated source tree. It never runs git commands
that could discard unrelated work.
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent

# Each row: enforcement path, file, unique text to replace, replacement.
#
# Mutations run against the WHOLE agent suite, not one file. Picking a suite per
# path invites a mapping error — session 171 pointed E-EFFECTIVENESS at the BCD
# module's tests while the mutated aggregator lived in agent.py, so a bad mapping
# masqueraded as a test gap. The operational question is "would the suite notice
# this regression?", and the suite is all of it.
MUTATIONS: list[dict] = [
    {
        "path": "E-DECRYPT",
        "file": "agent/agent.py",
        "old": "            decrypted = fernet.decrypt(data)",
        "new": "            decrypted = data  # MUTATION: skip decryption",
        "why": "decryption becomes a no-op (ciphertext written back as plaintext)",
    },
    {
        "path": "E-ACK",
        "file": "agent/agent.py",
        "old": '    state = {\n        "command_id": command_id,',
        "new": '    return  # MUTATION: never persist the pending ACK\n    state = {\n        "command_id": command_id,',
        "why": "the pending ACK is never written, so a lost ACK cannot be retried",
    },
    {
        "path": "E-EFFECTIVENESS",
        "file": "agent/agent.py",
        "old": '        bcd_crit = bcd_result.get("critical_applied", 0) if bcd_result else 0',
        "new": "        bcd_crit = 1  # MUTATION: always claim critical controls applied",
        "hint": "aggregator in agent.py; covered by test_agent_ack_recovery/_encryption",
        "why": "critical_applied=0 is reported as success (the gap this path exists to close)",
    },
    {
        "path": "E-OFFLINE-QUEUE",
        "file": "agent/agent.py",
        "old": '    """Queue a request for later delivery when the server is unreachable."""',
        "new": '    """Queue a request for later delivery when the server is unreachable."""\n    return  # MUTATION: never queue anything',
        "why": "offline requests are dropped instead of queued",
    },
    {
        "path": "E-TRACK",
        "file": "agent/agent.py",
        "old": "    networks = []\n    system = platform.system()",
        "new": "    networks = []\n    return networks  # MUTATION: never scan\n    system = platform.system()",
        "why": "WiFi scan returns nothing, so covert tracking reports no neighbours",
    },
    {
        "path": "E-DEADMAN",
        "file": "agent/agent.py",
        "old": '        if state.get("status") != "stolen":\n            return',
        "new": '        if True:  # MUTATION: never evaluate the deadman switch\n            return',
        "why": "the deadman switch can never fire",
    },
    {
        "path": "E-RECOVERY",
        "file": "agent/agent.py",
        "old": "        decrypt_folder(folder, key)",
        "new": "        pass  # MUTATION: skip decryption on recovery",
        "why": "recovery reports success but leaves the files encrypted",
    },
    {
        "path": "E-BCD",
        "file": "agent/bcd_lockdown.py",
        "old": "    if setting in BOOTMGR_SCOPED_SETTINGS:\n        return _set_bcd_setting_bootmgr(setting, value)\n    return _set_bcd_setting(setting, value)",
        "new": "    return True  # MUTATION: claim every BCD setting applied",
        "why": "no bcdedit command runs, but the lockdown reports the setting applied",
    },
    {
        "path": "E-HP-UEFI",
        "file": "agent/hp_uefi_lockdown.py",
        "old": "    # Phase 4.1: Admin check — fail-fast before any state writes\n    if not _is_admin():",
        "new": "    # Phase 4.1: Admin check — fail-fast before any state writes\n    if False:  # MUTATION: skip the admin fail-fast",
        "hint": "aggregator in agent.py; covered by test_agent_ack_recovery/_encryption",
        "why": "the admin check no longer fails fast before state writes",
    },
    {
        "path": "E-AUTO-UPDATE",
        "file": "agent/agent.py",
        "old": "    if not signature_b64:\n        return False",
        "new": "    if True:  # MUTATION: accept any update\n        return True",
        "why": "any update is accepted without a signature",
    },
    {
        "path": "E-DECRYPT",
        "label": "E-DECRYPT/encrypt",
        "file": "agent/agent.py",
        "old": "                    encrypted = fernet.encrypt(data)",
        "new": "                    encrypted = data  # MUTATION: store plaintext as ciphertext",
        "why": "encryption is a no-op: the .enc file holds the plaintext",
    },
    {
        "path": "E-BCD",
        "label": "E-BCD/rollback",
        "file": "agent/bcd_lockdown.py",
        "old": '    log.warning("Rolling back BCD changes due to critical failure...")',
        "new": '    log.warning("Rolling back BCD changes due to critical failure...")\n    return True  # MUTATION: pretend the rollback restored everything',
        "why": "a critical failure leaves the BCD altered, reported as rolled back",
    },
    {
        "path": "E-HP-UEFI",
        "label": "E-HP-UEFI/verify",
        "file": "agent/hp_uefi_lockdown.py",
        "old": '    current = _read_setting(name)\n    if current is None:\n        log.warning("Could not verify BIOS setting \'%s\' (read failed)", name)',
        "new": '    return True  # MUTATION: claim every setting verified\n    current = _read_setting(name)\n    if current is None:\n        log.warning("Could not verify BIOS setting \'%s\' (read failed)", name)',
        "why": "post-set verification (Phase 4.5 / D-013) never reads the value back",
    },
    # --- server (jest): the class where a toothless test costs the most ------
    {
        "path": "server/auth",
        "label": "SVC/requireAuth",
        "runner": "jest",
        "file": "server/src/middleware/auth.js",
        "old": "    req.admin = jwt.verify(token, process.env.JWT_SECRET, { algorithms: JWT_ALGORITHMS });",
        "new": "    req.admin = { role: 'super-admin', username: 'forged' };  // MUTATION",
        "why": "requireAuth accepts a forged token and grants super-admin",
    },
    {
        "path": "server/auth",
        "label": "SVC/requireRole",
        "runner": "jest",
        "file": "server/src/middleware/auth.js",
        "old": "    if (userLevel < requiredLevel) {",
        "new": "    if (false) {  // MUTATION: ignore the role hierarchy",
        "why": "requireRole lets a viewer reach operator/super-admin endpoints",
    },
    {
        "path": "server/hmac",
        "label": "SVC/hmacAuth",
        "runner": "jest",
        "file": "server/src/middleware/hmacAuth.js",
        "old": "  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {",
        "new": "  if (false) {  // MUTATION: accept any signature",
        "why": "HMAC verification accepts a wrong signature",
    },
    # --- serverless Worker (vitest): the product's worst failure --------------
    {
        "path": "worker/verdict",
        "label": "WRK/verdict-locked",
        "runner": "vitest",
        "file": "serverless/pbl/routes/verdict.ts",
        "old": "    case 'locked':\n      return { verdict: VERDICT_LOCKED, reason: 'admin_lock' };",
        "new": "    case 'locked':\n      return { verdict: VERDICT_UNLOCKED, reason: 'admin_lock' };  // MUTATION",
        "why": "a LOCKED device is handed an UNLOCKED verdict — it boots",
    },
    {
        "path": "worker/release",
        "label": "WRK/release-guard",
        "runner": "vitest",
        "file": "serverless/worker.ts",
        "old": "  if (['locked', 'stolen', 'recovering'].includes(device.status)) {",
        "new": "  if (false) {  // MUTATION: allow releasing a locked/stolen device",
        "why": "an admin release unlocks a device that is locked or stolen",
    },
    {
        "path": "worker/ack",
        "label": "WRK/ack-ownership",
        "runner": "vitest",
        "file": "serverless/worker.ts",
        "old": "  // Update command status\n  const commands = await listCommands(env);\n  const cmdIdx = commands.findIndex(\n    (c) => c.id === command_id && c.device_id === device.id,\n  );",
        "new": "  // Update command status\n  const commands = await listCommands(env);\n  const cmdIdx = commands.findIndex(\n    (c) => c.id === command_id,  // MUTATION: no ownership check\n  );",
        "why": "any device can ACK another device's command",
    },
    {
        "path": "worker/duress",
        "label": "WRK/duress",
        "runner": "vitest",
        "file": "serverless/worker.ts",
        "old": "    duress_code: payload.duress_code === true ? true : null,",
        "new": "    duress_code: null,  // MUTATION: a duress recover becomes a real unlock",
        "why": "a coerced (duress) recovery really unlocks instead of faking it",
    },
    {
        "path": "worker/recover",
        "label": "WRK/recover-unlock",
        "runner": "vitest",
        "file": "serverless/worker.ts",
        "old": "    duress_code: payload.duress_code === true ? true : null,\n  };\n  commands.push(cmd);",
        "new": "    duress_code: payload.duress_code === true ? true : null,\n  };\n  // MUTATION: never queue the unlock command",
        "why": "recovery releases the key and marks the device recovering but never unlocks it",
    },
    {
        "path": "worker/escrow",
        "label": "WRK/escrow-ownership",
        "runner": "vitest",
        "file": "serverless/worker.ts",
        "old": "  const cmd = commands.find(\n    (c) => c.id === command_id && c.device_id === device.id,\n  );\n  if (!cmd) {\n    return errorResponse('Command not found for this device', 404);",
        "new": "  const cmd = commands.find(\n    (c) => c.id === command_id,  // MUTATION: no ownership check\n  );\n  if (!cmd) {\n    return errorResponse('Command not found for this device', 404);",
        "why": "a device can escrow a key against another device's command id",
    },
    {
        "path": "worker/ack-terminal",
        "label": "WRK/ack-terminal",
        "runner": "vitest",
        "file": "serverless/worker.ts",
        "old": "  // Idempotent: if already executed, return success\n  if (commands[cmdIdx].status === 'executed') {\n    return jsonResponse({ ok: true, deduplicated: true });\n  }",
        "new": "  // MUTATION: an executed command can be rewritten",
        "why": "an already-executed command can be flipped to failed (history rewritten)",
    },
    {
        "path": "worker/ack-uuid",
        "label": "WRK/ack-uuid",
        "runner": "vitest",
        "file": "serverless/worker.ts",
        "old": "  if (payload.command_uuid) {\n    commands[cmdIdx].command_uuid = payload.command_uuid;\n  }",
        "new": "  // MUTATION: command_uuid is never persisted",
        "why": "retry idempotency loses the uuid the agent uses to suppress duplicates",
    },
    {
        "path": "worker/checkin-device",
        "label": "WRK/checkin-device-filter",
        "runner": "vitest",
        "file": "serverless/worker.ts",
        "old": "  const pendingCmds = commands\n    .filter((c) => c.device_id === device.id && c.status === 'pending')\n    .sort((a, b) => a.created_at.localeCompare(b.created_at));",
        "new": "  const pendingCmds = commands\n    .filter((c) => c.status === 'pending')  // MUTATION: no device filter\n    .sort((a, b) => a.created_at.localeCompare(b.created_at));",
        "why": "a device is handed ANOTHER device's pending command (tell B to lock)",
    },
    {
        "path": "worker/checkin-pending",
        "label": "WRK/checkin-pending-filter",
        "runner": "vitest",
        "file": "serverless/worker.ts",
        "old": "  const pendingCmds = commands\n    .filter((c) => c.device_id === device.id && c.status === 'pending')\n    .sort((a, b) => a.created_at.localeCompare(b.created_at));",
        "new": "  const pendingCmds = commands\n    .filter((c) => c.device_id === device.id)  // MUTATION: any status\n    .sort((a, b) => a.created_at.localeCompare(b.created_at));",
        "why": "an executed command is re-delivered, so a recovered device re-locks",
    },
    {
        "path": "worker/ping",
        "label": "WRK/ping-device-filter",
        "runner": "vitest",
        "file": "serverless/worker.ts",
        "old": "  const pendingCmd = commands.find(\n    (c) => c.device_id === device.id && c.status === 'pending',\n  );",
        "new": "  const pendingCmd = commands.find(\n    (c) => c.status === 'pending',  // MUTATION: no device filter\n  );",
        "why": "the ping path hands a device ANOTHER device's pending command",
    },
    {
        "path": "worker/uninstall-authz",
        "label": "WRK/uninstall-authz",
        "runner": "vitest",
        "file": "serverless/worker.ts",
        "old": "async function handleUninstallAuth(request: Request, env: Env): Promise<Response> {\n  // Accept either admin bearer auth or agent API key auth\n  const authHeader = request.headers.get('Authorization') || '';\n  const apiKey = request.headers.get('X-API-Key') || '';\n  const token = authHeader.replace(/^Bearer\\s+/i, '');\n\n  let authorized = false;\n  if (apiKey) {\n    const devices = await listDevices(env);\n    const apiKeyHash = await sha256(apiKey);\n    authorized = devices.some((d) => d.api_key_hash === apiKeyHash);\n  }",
        "new": "async function handleUninstallAuth(request: Request, env: Env): Promise<Response> {\n  // Accept either admin bearer auth or agent API key auth\n  const authHeader = request.headers.get('Authorization') || '';\n  const apiKey = request.headers.get('X-API-Key') || '';\n  const token = authHeader.replace(/^Bearer\\s+/i, '');\n\n  let authorized = true;  // MUTATION: any caller may request an uninstall token\n  if (apiKey) {\n    const devices = await listDevices(env);\n    const apiKeyHash = await sha256(apiKey);\n    authorized = devices.some((d) => d.api_key_hash === apiKeyHash);\n  }",
        "why": "any caller obtains an uninstall token, i.e. a device can authorise its own removal",
    },
    {
        "path": "worker/uninstall-verify",
        "label": "WRK/uninstall-verify",
        "runner": "vitest",
        "file": "serverless/worker.ts",
        "old": "    if (providedToken === expectedToken) {",
        "new": "    if (true) {  // MUTATION: any token verifies",
        "why": "the verify endpoint accepts any uninstall token",
    },
    {
        "path": "worker/update-auth",
        "label": "WRK/update-auth",
        "runner": "vitest",
        "file": "serverless/worker.ts",
        "old": "  const device = await verifyAgentAuth(request, env, '');\n  if (!device) {\n    return errorResponse('Authentication failed', 401);\n  }\n\n  const currentVersion = request.headers.get('x-agent-version') || '0.0.0';",
        "new": "  const device = await verifyAgentAuth(request, env, '');\n  if (false) {  // MUTATION: no agent auth on the update check\n    return errorResponse('Authentication failed', 401);\n  }\n\n  const currentVersion = request.headers.get('x-agent-version') || '0.0.0';",
        "why": "any caller can read fleet update metadata without an agent key",
    },
    {
        "path": "worker/update-version",
        "label": "WRK/update-version",
        "runner": "vitest",
        "file": "serverless/worker.ts",
        "old": "    update_available: compareVersions(currentVersion, release.latest_version) < 0,",
        "new": "    update_available: true,  // MUTATION: always offer an update",
        "why": "every agent is told an update is available on every check",
    },
    {
        "path": "worker/update-incomplete",
        "label": "WRK/update-incomplete",
        "runner": "vitest",
        "file": "serverless/worker.ts",
        "old": "  if (!sha256 || typeof size !== 'number') {",
        "new": "  if (false) {  // MUTATION: serve metadata that cannot be verified",
        "why": "an agent is offered an update whose hash it cannot check",
    },
    {
        "path": "worker/agent-version",
        "label": "WRK/agent-version",
        "runner": "vitest",
        "file": "serverless/worker.ts",
        "old": "    version: release.latest_version || null,",
        "new": "    version: '1.0.0',  // MUTATION: hardcoded, ignoring the published metadata",
        "why": "the dashboard is told a version unrelated to the published release",
    },
    {
        "path": "worker/latest-newest",
        "label": "WRK/location-latest-newest",
        "runner": "vitest",
        "file": "serverless/worker.ts",
        "old": "  const latest = deviceLocs[deviceLocs.length - 1];",
        "new": "  const latest = deviceLocs[0];  // MUTATION: oldest instead of newest",
        "why": "the \"last seen\" pin shows where the device was first reported",
    },
    {
        "path": "worker/latest-404",
        "label": "WRK/location-latest-404",
        "runner": "vitest",
        "file": "serverless/worker.ts",
        "old": "  if (!latest) {\n    return errorResponse(\n      'No location data. The device has not reported any location reports yet.',\n      404,\n    );\n  }",
        "new": "  if (false) {  // MUTATION: never report \"no location data\"\n    return errorResponse(\n      'No location data. The device has not reported any location reports yet.',\n      404,\n    );\n  }",
        "why": "a device with no reports returns 200 with a malformed payload instead of 404",
    },
    {
        "path": "worker/link-pbl",
        "label": "WRK/link-pbl-collision",
        "runner": "vitest",
        "file": "serverless/worker.ts",
        "old": "  if (collision) {",
        "new": "  if (false) {  // MUTATION: one firmware identity may be claimed by two agents",
        "why": "two agents claim the same PBL device_id, making the verdict target ambiguous",
    },
    {
        "path": "worker/rotate-key",
        "label": "WRK/rotate-key-hash",
        "runner": "vitest",
        "file": "serverless/worker.ts",
        "old": "  device.api_key_hash = await sha256(newApiKey);",
        "new": "  // MUTATION: the stored hash is never updated, so the old key stays valid",
        "why": "rotation reports success while the compromised key keeps working",
    },
    {
        "path": "worker/unlink-pbl",
        "label": "WRK/unlink-pbl-400",
        "runner": "vitest",
        "file": "serverless/worker.ts",
        "old": "  if (!device.pbl_device_id) {",
        "new": "  if (false) {  // MUTATION: unlink on an unlinked device reports success",
        "why": "an operator is told the unlink worked when there was nothing to unlink",
    },
]


def repo_path(rel: str) -> Path:
    """Resolve a table path and refuse anything outside the repository.

    The table is a module constant, so this is defence against a future edit
    rather than against input: a row with `..` must not be able to make this
    script rewrite a file outside the tree.
    """
    target = (REPO / rel).resolve()
    if not target.is_relative_to(REPO):
        raise SystemExit(f"refusing path outside the repo: {rel}")
    return target


NODE = Path("/home/cllin/.local/node/bin/node")


def _jest_failures(lines: list[str]) -> set[str]:
    """Failing case names, as `describe › test`."""
    return {
        ln.strip().lstrip("● ").strip()
        for ln in lines
        if ln.strip().startswith("●") and "›" in ln
    }


def _vitest_failures(lines: list[str]) -> set[str]:
    """Failing case names, as vitest prints them (`FAIL  file > describe > test`)."""
    out = set()
    for ln in lines:
        s = ln.strip()
        if s.startswith("FAIL "):
            out.add(s[5:].strip())
        elif s.startswith(("×", "✗")):
            out.add(s.lstrip("×✗ ").strip())
    return out


def _pytest_failures(lines: list[str]) -> set[str]:
    """Failing case ids, as pytest prints them under `-q`."""
    out = set()
    for ln in lines:
        if ln.startswith(("FAILED ", "ERROR ")):
            out.add(ln.split(" - ")[0].strip())
    return out


def run_suite(runner: str = "pytest") -> tuple[bool | None, str, set[str]]:
    """Run a component suite. Returns (passed, summary); None means invalid.

    Two traps this guards against, both found the hard way in session 171:
      * `scripts/run-agent-tests.sh` does `cd agent` and always passes `tests/`,
        so a repo-relative path never resolves — the first version of this audit
        reported ten "KILLED" that were all collection errors;
      * a non-zero exit for a *collection* failure is indistinguishable from a
        failing test, so "the command failed" is not evidence that a test failed
        (and with `-x` there is no summary line to inspect either).

    Validity therefore comes from the exit code — 0 passed, 1 failed — with text
    markers only for the ways a runner says "I ran nothing".
    """
    if runner == "vitest":
        node = str(NODE) if NODE.exists() else "node"
        proc = subprocess.run(
            [node, "node_modules/vitest/vitest.mjs", "run"],
            cwd=REPO / "serverless", capture_output=True, text=True, timeout=900,
        )
        out = proc.stdout + proc.stderr
        lines = [ln for ln in out.strip().splitlines() if ln.strip()]
        summary = lines[-1][:90] if lines else "(no output)"
        # vitest prints a "Tests  N passed" tally; without it the run did not
        # finish (same validity rule as jest).
        finished = any(ln.strip().startswith("Tests") for ln in lines)
        if not finished or "Error: Cannot find module" in out:
            return None, summary, set()
        if proc.returncode in (0, 1):
            return proc.returncode == 0, summary, _vitest_failures(lines)
        return None, summary, set()

    if runner == "jest":
        node = str(NODE) if NODE.exists() else "node"
        # Same flags as server/package.json's test script. Without
        # --experimental-vm-modules the suite crashes partway through
        # (ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING_FLAG from pglite), which looks
        # exactly like "tests failed" — session 173 nearly reported three security
        # mutations as caught on the strength of a crash.
        proc = subprocess.run(
            [node, "--experimental-vm-modules", "node_modules/jest/bin/jest.js",
             "--forceExit", "--silent"],
            cwd=REPO / "server", capture_output=True, text=True, timeout=900,
        )
        out = proc.stdout + proc.stderr
        lines = [ln for ln in out.strip().splitlines() if ln.strip()]
        summary = lines[-1][:90] if lines else "(no output)"
        # Jest always prints its own tallies. Without them the run did not finish,
        # whatever the exit code says.
        finished = any(ln.startswith(("Tests:", "Test Suites:")) for ln in lines)
        crashed = "ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING_FLAG" in out or "Node.js v" in out
        if not finished or crashed:
            return None, summary, set()
        if any(m in out for m in ("No tests found", "Cannot find module")):
            return None, summary, set()
        if proc.returncode in (0, 1):
            return proc.returncode == 0, summary, _jest_failures(lines)
        return None, summary, set()

    agent_dir = REPO / "agent"
    venv_py = agent_dir / ".venv" / "bin" / "python"
    py = str(venv_py) if venv_py.exists() else "python3"
    proc = subprocess.run(
        [py, "-m", "pytest", "tests/", "-x", "-q"],
        cwd=agent_dir, capture_output=True, text=True, timeout=900,
    )
    out = proc.stdout + proc.stderr
    lines = [ln for ln in out.strip().splitlines() if ln.strip()]
    summary = lines[-1][:90] if lines else "(no output)"

    #   0 passed | 1 tests failed | 2 interrupted | 3 internal | 4 usage | 5 none collected
    if "file or directory not found" in out or "errors during collection" in out:
        return None, summary, set()
    if proc.returncode in (0, 1):
        return proc.returncode == 0, summary, _pytest_failures(lines)
    return None, summary, set()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--path", help="only this enforcement path")
    ap.add_argument("--list", action="store_true", help="print the mutation table and exit")
    ap.add_argument("--label", help="only rows whose label contains this")
    args = ap.parse_args()

    table = [m for m in MUTATIONS if not args.path or m["path"] == args.path]
    if args.label:
        table = [m for m in table if args.label in m.get("label", m["path"])]
    if not table:
        print(f"no mutation for {args.path!r}", file=sys.stderr)
        return 2

    if args.list:
        for m in table:
            print(f"{m.get('label', m['path']):22} {m['file']:28} {m['why']}")
        return 0

    # A mutation verdict is only meaningful against a green baseline, and only for
    # failures the mutation NEWLY causes. Session 173 learned both the hard way: a
    # crashed run and an intermittently flaky admins test each looked like a kill.
    baseline: dict[str, set[str]] = {}
    for runner in {m.get("runner", "pytest") for m in table}:
        passed, summary, failures = run_suite(runner)
        if passed is None:
            print(f"BASELINE for {runner} could not run ({summary}) — aborting",
                  file=sys.stderr)
            return 1
        if not passed:
            print(f"BASELINE for {runner} is RED ({summary}) — a mutation verdict "
                  f"would be meaningless. Fix the suite first.", file=sys.stderr)
            for f in sorted(failures)[:5]:
                print(f"  {f}", file=sys.stderr)
            return 1
        baseline[runner] = failures
        print(f"baseline {runner}: green ({summary})")

    survivors = []
    invalid = []
    for m in table:
        target = repo_path(m["file"])
        original = target.read_text()
        hits = original.count(m["old"])
        if hits != 1:
            print(f"{m['path']:16} SKIPPED — anchor matched {hits} times in {m['file']}")
            continue
        try:
            target.write_text(original.replace(m["old"], m["new"], 1))
            runner = m.get("runner", "pytest")
            passed, summary, failures = run_suite(runner)
        finally:
            target.write_text(original)

        new_failures = (failures - baseline.get(runner, set())) if failures else set()
        if passed is None:
            invalid.append(m)
            verdict = "INVALID"
        elif passed or not new_failures:
            survivors.append(m)
            verdict = "SURVIVED"
        else:
            verdict = "KILLED"
            summary = "caught by: " + sorted(new_failures)[0][:70]
        print(f"{m.get('label', m['path']):22} {verdict:9} {summary}")

    print()
    if invalid:
        print(f"{len(invalid)} of {len(table)} runs were INVALID — pytest did not "
              f"execute the suite, so the mutation was neither caught nor missed:")
        for m in invalid:
            print(f"  {m['path']}: {m.get('hint', m['file'])}")
        print()
    if survivors:
        print(f"{len(survivors)} of {len(table)} mutations SURVIVED — these suites do not "
              f"test the behaviour they are credited with:")
        for m in survivors:
            print(f"  {m.get('label', m['path'])}: {m['why']}")
        print("\n  the full agent suite passed with these defects reintroduced:")
        return 1
    if invalid:
        return 1
    print(f"all {len(table)} mutations killed — every audited suite has teeth")
    return 0


if __name__ == "__main__":
    sys.exit(main())
