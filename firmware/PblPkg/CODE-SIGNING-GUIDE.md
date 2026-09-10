# PBL Code Signing Guide (D-130)

## Why signing is required

PBL is a UEFI application that runs during the BDS phase, before Windows Boot
Manager. UEFI Secure Boot verifies the signature of every bootloader before
executing it. An unsigned `PblApp.efi` will be **rejected by Secure Boot**.

## What certificates are needed

### Option 1: Self-signed certificate (development/testing)

For testing on your own hardware where you control the UEFI db:

1. Generate a self-signed cert (the `sign-efi.sh --test` script does this)
2. Enroll the public key in the UEFI db signature database
3. Sign `PblApp.efi` with the private key

**Cost:** Free
**Limitation:** Only works on machines where you've enrolled the cert in db.

### Option 2: OEM certificate (production deployment)

For deploying on specific OEM hardware (HP, Dell, Lenovo):

1. Obtain a certificate signed by the OEM's CA
2. The OEM's public CA must be in the machine's db
3. Sign `PblApp.efi` with your private key (signed by OEM CA)

**Cost:** Varies by OEM partnership agreement
**Limitation:** Only works on that OEM's hardware.

### Option 3: Microsoft UEFI signing (universal deployment)

For deployment on any Secure Boot-enabled Windows machine:

1. Submit `PblApp.efi` to Microsoft's UEFI signing portal
2. Microsoft signs it with their UEFI signing key (in every Secure Boot db)
3. The signed binary works on all Windows machines with Secure Boot

**Cost:** Free (Microsoft does not charge for UEFI signing)
**Requirement:** Microsoft Partner Center account
**Portal:** https://partner.microsoft.com/dashboard/uefi
**Process:**
1. Register at Microsoft Partner Center
2. Submit the EFI binary for signing
3. Microsoft reviews and signs it
4. Download the signed binary

**Limitation:** Microsoft reviews the binary. The signing process can take
days to weeks. The binary must not be malicious.

## How to sign PblApp.efi

### Prerequisites

```bash
# Linux (Debian/Ubuntu):
sudo apt install sbsigntool openssl

# Linux (Arch):
sudo pacman -S sbsigntool

# macOS:
brew install sbsigntool
```

### Test signing (self-signed, for development)

```bash
cd firmware/PblPkg

# Sign with a self-signed cert
./sign-efi.sh --test --efi PblApp.efi --output PblApp.signed.efi

# This generates:
#   /tmp/pbl-test-signing.key  (private key)
#   /tmp/pbl-test-signing.crt  (certificate)
#   PblApp.signed.efi          (signed firmware)
```

To use the signed firmware with Secure Boot, enroll the cert in db:

```bash
# Convert cert to DER format
openssl x509 -in /tmp/pbl-test-signing.crt -outform DER -out /tmp/pbl-test-signing.der

# Method 1: Use your UEFI setup menu
#   - Find "Secure Boot" → "Keys" → "db" → "Enroll"
#   - Select the .der file

# Method 2: Use sbctl (Linux with UEFI)
sudo sbctl enroll-keys --microsoft --tpm-eventlog
sudo sbctl sign -s PblApp.signed.efi
```

### Production signing (with PFX certificate)

```bash
cd firmware/PblPkg

# Sign with a PFX certificate
./sign-efi.sh --pfx /path/to/cert.pfx --password <password> \
  --efi PblApp.efi --output PblApp.signed.efi

# Verify the signature
sbverify PblApp.signed.efi
```

### Microsoft UEFI signing

```bash
# 1. Build the unsigned firmware
./build-pbl.sh

# 2. Submit PblApp.efi to Microsoft's UEFI signing portal
#    https://partner.microsoft.com/dashboard/uefi

# 3. Download the signed binary from the portal

# 4. Verify the signature
sbverify PblApp.signed.efi
```

## What to do right now (no certificates available)

Since the company does not have code signing certificates:

1. **For hardware testing:** Use `sign-efi.sh --test` to generate a self-signed
   cert. Disable Secure Boot on the test machine, or enroll the self-signed
   cert in db. This lets you test the firmware on real hardware.

2. **For production deployment:** Submit `PblApp.efi` to Microsoft's UEFI
   signing portal. This is free and works on all Secure Boot machines.

3. **For OEM-specific deployment:** Contact the OEM (HP, Dell, Lenovo) to
   obtain a certificate signed by their CA.

## Verification

After signing, verify the signature:

```bash
# Verify with sbverify
sbverify PblApp.signed.efi

# Verify with sbsign
sbsign --verify PblApp.signed.efi

# Check the signature details
sbverify --cert /tmp/pbl-test-signing.crt PblApp.signed.efi
```

## File locations

| File | Purpose |
|------|---------|
| `firmware/PblPkg/sign-efi.sh` | Signing script (test + PFX + Azure) |
| `firmware/PblPkg/PblApp.efi` | Unsigned firmware (build output) |
| `firmware/PblPkg/PblApp.signed.efi` | Signed firmware (after signing) |
| `scripts/setup-signing.sh` | Electron app signing setup (separate from EFI) |
| `scripts/verify-signing.sh` | Electron app signature verification |
