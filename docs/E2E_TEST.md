# End-to-End Test Guide

This document describes the full end-to-end test flow for the Remote Lockdown
System: from installing the admin app to enrolling an agent, flagging a device
as stolen, verifying lockdown, recovering, and verifying unlock.

---

## Prerequisites

- Admin app (Electron desktop app or cloud deployment)
- A test VM (Windows or Linux) — **never test on a production machine**
- Network connectivity between the test VM and the admin server

---

## Test Flow

### Step 1: Install the Admin App

**Option A: Desktop App (Electron)**
1. Download the installer from GitHub Releases
   - Windows: `Remote-Lockdown-Admin-Setup-x.y.z.exe`
   - macOS: `Remote-Lockdown-Admin-x.y.z.dmg`
   - Linux: `Remote-Lockdown-Admin-x.y.z.AppImage`
2. Run the installer
3. Launch "Remote Lockdown Admin"
4. Create your admin account (first run)

**Option B: Cloud Deployment**
1. Deploy using `docker-compose.prod.yml`:
   ```bash
   cp .env.prod.example .env.prod
   # Edit .env.prod with your values
   docker compose -f docker-compose.prod.yml up -d
   ```
2. Navigate to `https://your-domain.com`
3. Create your admin account

**Expected:** Admin dashboard loads, showing empty device list.

---

### Step 2: Enroll a Device

1. In the admin dashboard, click **"Enroll New Device"**
2. Enter the device hostname and owner name
3. Click **"Enroll Device"**
4. Download the agent installer (Windows or Linux)
5. Transfer the installer ZIP to the test VM

**Expected:** Device appears in the dashboard with status `active` (or `inactive`
until first check-in).

---

### Step 3: Install the Agent on the Test VM

1. Unzip the installer package on the test VM
2. Run the install script:
   - **Windows:** Right-click `install.ps1` → "Run with PowerShell"
     (requires Administrator)
   - **Linux:** `sudo ./install.sh`
3. Read the EULA disclosure — type `yes` to accept
4. The agent installs as a service and starts automatically

**Expected:**
- EULA + tracking disclosure is shown
- Agent installs as a Windows service (NSSM) or systemd service
- On Windows: "Remote Lockdown Agent" appears in Add/Remove Programs
- Agent starts checking in within 30 seconds

---

### Step 4: Verify Check-in

1. In the admin dashboard, go to the device detail page
2. Check the "Last Check-in" field

**Expected:** Last check-in shows "less than a minute ago" and updates every
30–60 seconds. Device status is `active`.

---

### Step 5: Flag Device as Stolen (Lockdown)

1. In the device detail page, click **"Flag as Stolen"**
2. Type the device hostname to confirm
3. Click **"Flag as Stolen"** in the confirmation modal

**Expected:**
- Dashboard shows status changing to `stolen`
- Audit log records `flag_stolen` action
- Within 30 seconds, the agent receives the lockdown command

---

### Step 6: Verify Lockdown

On the test VM:
1. **File encryption:** Check `~/SecureData` (or configured lockdown folder)
   - Files should be encrypted (`.enc` extensions)
   - Original plaintext files should be deleted
2. **Lock screen:** The device should show a lock screen
3. **Boot lockdown (Windows):** Reboot the VM
   - If BCD lockdown was applied, boot should be restricted
   - If UEFI lockdown was applied (HP only), BIOS password is set
4. **User notification:** A desktop notification should appear:
   - Windows: MessageBox "Device Security Alert"
   - Linux: notify-send notification

In the admin dashboard:
1. Check the device status — should show `locked`
2. Check the audit log — should show `lockdown_executed`
3. The encryption key should be stored on the server

**Expected:** Device is fully locked, files encrypted, boot protected,
user notified.

---

### Step 7: Track Device Location (Optional)

1. While the device is in `stolen` or `locked` state, click **"Locate Now"**
   for a one-time location ping
2. Or the device automatically reports location when stolen (adaptive polling)

**Expected:**
- Location appears on the device detail page map
- Location history shows entries with lat/long, source, accuracy
- Location data is encrypted at rest in the database

---

### Step 8: Recover Device (Unlock)

1. In the device detail page, click **"Recover Device"**
2. Type the device hostname to confirm
3. Click **"Recover Device"** in the confirmation modal

**Expected:**
- Dashboard shows status changing to `recovering`
- Within 30 seconds, the agent receives the unlock command with the key
- Agent decrypts the folder, removes the lock screen, removes boot lockdown
- Device status returns to `active`
- Audit log records `recover` and `unlock_executed`

---

### Step 9: Verify Unlock

On the test VM:
1. **File decryption:** Check `~/SecureData`
   - Files should be decrypted (original extensions restored)
   - `.enc` files should be removed
2. **Lock screen:** The lock screen should be removed
3. **Boot lockdown:** Reboot the VM
   - Boot should work normally (BCD lockdown removed)
   - BIOS password may need manual clearing (HP UEFI)

**Expected:** Device is fully restored to normal operation.

---

### Step 10: Release Device (Ownership Transfer / GDPR Erasure)

1. In the device detail page, click **"Release Device"**
2. Type the device hostname to confirm
3. Click **"Release & Delete Data"**

**Expected:**
- All device data is deleted (locations, keys, commands)
- Audit log entries are anonymized (device_id set to NULL)
- Device disappears from the dashboard
- Audit log retains `device_released` entry for accountability

---

## Automated Tests

### Python Agent Tests
```bash
cd agent
pip install -r requirements.txt
pip install pytest
pytest tests/ -v
```

### Server API Tests
```bash
cd server
npm install
npm test
```

### Dashboard Tests
```bash
cd dashboard
npm install
npm test
```

---

## Troubleshooting

### Agent not checking in
- Verify the agent service is running: `sc query LockdownAgent` (Windows) or
  `systemctl status lockdown-agent` (Linux)
- Check the agent log: `C:\Program Files\LockdownAgent\agent.log` or
  `journalctl -u lockdown-agent`
- Verify network connectivity to the server
- Verify the API key in `config.json` matches the server

### Lockdown not working
- Verify the lockdown folder exists and contains files
- Check the agent log for encryption errors
- On Windows, verify NSSM is installed for service mode
- Boot lockdown requires supported hardware (HP UEFI for BIOS password)

### Recovery not working
- Verify the encryption key was transmitted to the server (check audit log)
- Check that the agent is online and receiving the unlock command
- If boot lockdown was applied, may need manual BIOS password clearing
