# T10: Phase 3 — Dashboard PBA Recovery panel + recovery runbook

> **Label:** `wayfinder:task`
> **Status:** OPEN
> **Blocks:** none
> **Blocked by:** T9
> **Implements:** Q10

## Question

Add the PBA Recovery panel to the dashboard and write the recovery runbook
documentation.

## Work

### Dashboard
1. In `dashboard/src/pages/DeviceDetailPage.jsx`, add a "PBA Recovery" panel
   that shows when PBA is active:
   - BitLocker PIN (decrypted from server)
   - 48-digit recovery password (decrypted from server)
   - HP Power-On Password (decrypted from server)
   - HP Setup Password (already shown)
   - Prominent warning: "Remote unlock will not work if the device has
     rebooted. Physical access required to enter these credentials at the
     pre-boot prompt."
2. Add a "PBA Active" badge to the device status.
3. Add tests for the new panel.

### Server API
1. Add an endpoint to retrieve PBA credentials for a device (admin-only).
2. Return decrypted credentials in the response.

### Documentation
1. Create `docs/PBA_RECOVERY_RUNBOOK.md`:
   - Step 1: Retrieve credentials from dashboard.
   - Step 2: Physical access to device.
   - Step 3: Enter PIN or 48-digit recovery password at pre-boot prompt.
   - Step 4: Device boots, agent starts, checks in.
   - Step 5: Server sends `remove_boot_lockdown`, agent clears PBA.
   - Note: If no one can physically access the device, there is no remote
     recovery path.

## Files to edit

- `dashboard/src/pages/DeviceDetailPage.jsx` (PBA Recovery panel, badge)
- `dashboard/src/pages/DeviceDetailPage.test.jsx` (tests)
- `server/src/routes/devices.js` (PBA credentials endpoint)
- `docs/PBA_RECOVERY_RUNBOOK.md` (new)

## Acceptance

- Dashboard shows PBA Recovery panel with credentials when PBA is active.
- "PBA Active" badge visible.
- Recovery runbook exists with step-by-step instructions.
- All dashboard tests pass. ESLint clean.
