# T3: Error messages with fix instructions

> **Label:** `wayfinder:task`
> **Status:** CLOSED (2026-08-13)
> **Blocks:** none
> **Blocked by:** none
> **Implements:** H4 (error messages with fix instructions)

## Question

The WalkingLabs course (Lecture 10) prescribes that error messages should
include HOW to fix the problem, not just WHAT'S wrong. An audit of 147 error
messages across the codebase found:
- 24 (14.5%) include fix instructions (FIX-INSTRUCTION)
- 115 (69.7%) describe the problem only (DESCRIPTION-ONLY)
- 26 (15.8%) are vague/useless (GENERIC)

Fix the highest-impact errors: all 26 GENERIC errors + the worst DESCRIPTION-ONLY
offenders (~24 repeated patterns like "Device not found" appearing 12+ times).

## Work

### Scope: ~50 highest-impact errors

**All 26 GENERIC errors** (vague/useless):
- Server: "Internal server error", "Not found", "Conflict — resource already
  exists", "Invalid credentials" (x2), "Unauthorized", "Insufficient permissions"
- Dashboard: "Something went wrong", "An unexpected error occurred",
  "Failed to load devices", "Failed to load device", "Failed to update role",
  "Failed to load audit log", "Login failed", "Enrollment failed", "Setup failed"
- Agent: 4 generic PowerShell failure messages
- Electron: 5 generic startup/config errors

**Worst DESCRIPTION-ONLY offenders** (repeated patterns, ~24 instances):
- "Device not found" (12+ instances in devices.js, agent.js, installer.js)
- "Device not registered" (4 instances in agent.js)
- "hostname required" / "X required" validation errors (~8 instances)
- "Confirmation hostname does not match" (3 instances)

### Fix pattern

Each error message should follow the pattern:
`<what went wrong>. <how to fix it>`

Examples:
- "Device not found" -> "Device not found. Verify the device ID is correct
  and the device is enrolled in the system."
- "Invalid credentials" -> "Invalid credentials. Check your username and
  password and try again."
- "Something went wrong" -> "Something went wrong. Refresh the page. If the
  issue persists, check the browser console for details."
- "Internal server error" -> "Internal server error. Check server logs for
  details and contact support if the issue persists."

### Implementation approach

1. Fix errors by component (server first — highest count and API-facing):
   - `server/src/routes/devices.js` — 12+ "Device not found" + validation errors
   - `server/src/routes/agent.js` — "Device not registered" + header errors
   - `server/src/routes/auth.js` — "Invalid credentials"
   - `server/src/routes/setup.js` — validation errors
   - `server/src/routes/admins.js` — validation + state errors
   - `server/src/routes/audit.js` — format errors
   - `server/src/routes/index.js` — generic 404/500 handlers
   - `server/src/middleware/auth.js` — auth errors
   - `server/src/middleware/hmacAuth.js` — HMAC errors
2. Agent: `agent/agent.py`, `agent/hp_uefi_lockdown.py`,
   `agent/bitlocker_pba.py` — PowerShell failure messages
3. Dashboard: `dashboard/src/pages/*.jsx`, `dashboard/src/components/ErrorBoundary.jsx`
4. Electron: `electron/main.js`, `electron/server-starter.js`, `electron/config.js`

### Tests

1. Update existing tests that assert on error message text — the messages
   are changing, so test assertions must be updated to match
2. Add a test that verifies key error messages contain fix instructions
   (e.g., a test that checks error responses include a period followed by
   guidance text, or a `hint` field if we standardize the response format)
3. Do NOT add tests for every single error message — test the pattern, not
   every instance

## Files to edit

- `server/src/routes/devices.js`
- `server/src/routes/agent.js`
- `server/src/routes/auth.js`
- `server/src/routes/setup.js`
- `server/src/routes/admins.js`
- `server/src/routes/audit.js`
- `server/src/routes/index.js`
- `server/src/middleware/auth.js`
- `server/src/middleware/hmacAuth.js`
- `agent/agent.py`
- `agent/hp_uefi_lockdown.py`
- `agent/bitlocker_pba.py`
- `dashboard/src/components/ErrorBoundary.jsx`
- `dashboard/src/pages/DevicesPage.jsx`
- `dashboard/src/pages/DeviceDetailPage.jsx`
- `dashboard/src/pages/AdminsPage.jsx`
- `dashboard/src/pages/AuditPage.jsx`
- `dashboard/src/pages/LoginPage.jsx`
- `dashboard/src/pages/EnrollPage.jsx`
- `dashboard/src/pages/SetupPage.jsx`
- `electron/main.js`
- `electron/server-starter.js`
- `electron/config.js`
- Test files that assert on error message text (update assertions)

## Acceptance

- All 26 GENERIC errors are replaced with fix-instruction messages
- All repeated "Device not found" / "Device not registered" / "X required"
  patterns include fix instructions
- All existing tests pass (assertions updated to match new messages)
- New test verifies the fix-instruction pattern on a representative sample
- ESLint clean (server + dashboard)
- Ruff clean (agent)
- `make graph-check` passes

### Demonstration (red-green)

**Before**: Pick 3 error messages (one server, one dashboard, one agent).
Show the current message and what an API consumer / operator sees when they
hit it (no guidance on how to fix).

**After**: Show the same 3 errors with fix instructions. Demonstrate that
the test suite catches an error message that lacks fix instructions (the
new pattern test fails if a message is reverted to description-only).
