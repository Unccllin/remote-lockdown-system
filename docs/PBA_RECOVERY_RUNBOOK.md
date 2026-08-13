# PBA Recovery Runbook

> **Purpose:** Step-by-step instructions for recovering a device that has
> Pre-Boot Authentication (PBA) active and has rebooted.

This runbook covers the recovery procedure when a device has PBA active
(HP Power-On Password and/or BitLocker TPM+PIN) and has rebooted. Once
rebooted, the device cannot be remotely unlocked — the agent cannot boot
to receive unlock commands. Physical access is required.

## When to use this runbook

- A stolen/locked device with PBA active has been recovered and needs to be
  unlocked.
- A device with PBA active was accidentally rebooted (e.g., Windows Update,
  power outage) and needs to be restored to normal operation.
- The operator needs to retrieve PBA credentials for a field technician.

## Prerequisites

- Dashboard access (super-admin role).
- Physical access to the device (someone must be at the keyboard).
- The device must have been enrolled in the lockdown system and had PBA
  enabled during lockdown (`enable_pba: true`).

## Recovery Procedure

### Step 1: Retrieve PBA credentials from the dashboard

1. Log in to the lockdown dashboard.
2. Navigate to the device detail page for the affected device.
3. Look for the **"PBA Active"** badge next to the device status.
4. In the **"PBA Recovery"** panel, click **"Show PBA Credentials"**.
5. The following credentials will be displayed (if applicable):
   - **BitLocker PIN** — 6-digit numeric PIN for TPM+PIN pre-boot prompt.
   - **BitLocker Recovery Password** — 48-digit numerical password
     (format: `XXXXXX-XXXXXX-XXXXXX-XXXXXX-XXXXXX-XXXXXX-XXXXXX-XXXXXX`).
   - **HP Power-On Password** — BIOS Power-On Password required at boot.
   - **HP Setup Password** — BIOS Setup Password (may be needed for BIOS
     changes during recovery).
6. Use the reveal (eye) button to view each credential.
7. Use the copy button to copy each credential to clipboard.
8. Securely transmit the credentials to the person at the device (e.g.,
   encrypted message, phone call — do NOT send via email).

> **Security note:** The dashboard logs all PBA credential access in the
> audit log. Only super-admins can access this endpoint.

### Step 2: Physical access to the device

1. The person at the device powers it on.
2. The device will prompt for PBA credentials at the pre-boot stage.

### Step 3: Enter credentials at the pre-boot prompt

The exact prompt depends on which PBA layers are active:

#### If HP Power-On Password is active (Tier 1 PBA)

1. The HP BIOS will prompt for a password before boot.
2. Enter the **HP Power-On Password**.
3. The device proceeds to the next boot stage.

#### If BitLocker TPM+PIN is active (Tier 2 PBA)

1. After the BIOS stage, the BitLocker pre-boot prompt appears.
2. Enter the **BitLocker PIN** (6-digit numeric).
3. The device unlocks the BitLocker-encrypted drive and boots Windows.

#### If the BitLocker PIN is lost or doesn't work

1. At the BitLocker recovery screen, select "Enter recovery key."
2. Enter the **48-digit BitLocker Recovery Password** (type the digits
   with hyphens as shown in the dashboard).
3. The device unlocks and boots Windows.

> **Note:** The recovery password can also be used if the TPM has been
> reset or the PIN protector is corrupted.

### Step 4: Device boots, agent starts, checks in

1. After entering the correct PBA credentials, Windows boots normally.
2. The lockdown agent starts automatically (as a Windows service).
3. The agent checks in with the server.
4. The server sends the `remove_boot_lockdown` command (if recovery was
   initiated from the dashboard).

### Step 5: Agent clears PBA and restores normal operation

1. The agent receives the `remove_boot_lockdown` command.
2. The agent:
   - Removes the BitLocker TPM+PIN protector (restores TPM-only boot).
   - Clears the HP Power-On Password.
   - Restores BIOS settings to pre-lockdown state.
   - Removes BCD boot restrictions.
3. The agent decrypts the sensitive folder.
4. The device returns to `active` status.

> **Important:** The agent can only clear PBA if it successfully booted
> and checked in. If the device reboots again before the agent clears PBA,
> the operator must repeat Steps 2-4.

## If no one can physically access the device

**There is no remote recovery path for a rebooted PBA device.**

This is by design — PBA (Pre-Boot Authentication) exists specifically to
prevent the operating system from booting without physical presence. The
agent cannot run until the device has booted, and the device cannot boot
without the PBA credentials being entered at the pre-boot prompt.

If the device has been stolen and the thief cannot enter the PBA credentials:
- The data on the drive is protected by BitLocker encryption.
- The device cannot boot without the PIN or recovery password.
- This is the intended security posture — the data is inaccessible without
  physical access and the correct credentials.

## Troubleshooting

### The PBA Recovery panel doesn't appear

- Verify the device status is `stolen` or `locked` (the panel only shows
  for these statuses).
- Verify the `pba_active` flag is true in the lockdown detail (check the
  audit log for the most recent `agent_lockdown_confirmed` entry).
- If PBA was not enabled for this lockdown (`enable_pba: false`), the panel
  will not appear — the device can be remotely unlocked normally.

### The credentials are all null

- The agent may not have successfully set PBA credentials during lockdown
  (e.g., BitLocker was not enabled, or the HP WMI call failed).
- Check the audit log for the lockdown confirmation entry — the
  `boot_lock_detail` will show whether PBA was actually applied.
- If the agent crashed before sending the ACK, the credentials may not
  have been stored on the server. Check the agent's pending ACK file on
  the device.

### The BitLocker PIN doesn't work

- The PIN may have been changed by the user after lockdown.
- Use the 48-digit recovery password instead — it always works if the
  drive is BitLocker-encrypted.
- If the recovery password also doesn't work, the drive may have been
  reformatted or the encryption state changed.

### The HP Power-On Password doesn't work

- The password may have been cleared by someone with BIOS access.
- If the BIOS prompts for a Setup Password instead of a Power-On Password,
  use the **HP Setup Password** from the dashboard.
