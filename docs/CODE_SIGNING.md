# Code Signing Guide

Code signing is required for production distribution. Without it:
- **Windows**: SmartScreen warns users ("Windows protected your PC")
- **macOS**: Gatekeeper blocks the app ("cannot be opened because it is from an unidentified developer")

This document covers the signing process for both platforms.

---

## Windows: Azure Trusted Signing (~$10/month)

Azure Trusted Signing (formerly Azure Code Signing) is the most cost-effective
option for Windows code signing. It provides an EV certificate equivalent
without the USB token requirement.

### Prerequisites
1. An Azure subscription
2. A verified business identity (Azure Trusted Signing requires business
   verification — this takes 3-7 business days)
3. The `azuresigntool` .NET tool for signing

### Setup

1. **Create an Azure Trusted Signing account:**
   ```
   az account set --subscription <your-subscription-id>
   az trusted-signing account create \
     --resource-group <rg> \
     --account-name <your-account-name> \
     --location westus2
   ```

2. **Create a certificate profile:**
   ```
   az trusted-signing certificate-profile create \
     --resource-group <rg> \
     --account-name <your-account-name> \
     --profile-name MyCertProfile \
     --identity-validation-id <validation-id>
   ```

3. **Install AzureSignTool:**
   ```
   dotnet tool install --global AzureSignTool
   ```

### Signing the installer

electron-builder supports Azure Trusted Signing via environment variables:

```bash
# Set these in your CI environment or shell before building
export AZURE_TRUSTED_SIGNING_ACCOUNT_NAME=<your-account-name>
export AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME=<profile-name>
export AZURE_TRUSTED_SIGNING_CLIENT_ID=<app-client-id>
export AZURE_TRUSTED_SIGNING_CLIENT_SECRET=<app-client-secret>
export AZURE_TRUSTED_SIGNING_TENANT_ID=<tenant-id>

# Build with signing
cd electron
npm run build:win
```

Add the signing config to `electron/package.json` build section:
```json
"win": {
  "target": ["nsis", "msi"],
  "icon": "build/icon.ico",
  "signingHashAlgorithms": ["sha256"],
  "azureTrustedSigning": {
    "accountName": "<account>",
    "certificateProfileName": "<profile>"
  }
}
```

### Verifying the signature
```powershell
# Check signature on the built installer
Get-AuthenticodeSignature "dist-electron/Remote Lockdown Admin Setup 1.0.0.exe"
```

The `Status` should be `Valid` and `SignerCertificate` should show your
company name.

---

## macOS: Apple Developer Program ($99/year)

### Prerequisites
1. An Apple Developer Program membership
2. A "Developer ID Application" certificate (for distribution outside the
   Mac App Store)
3. A "Developer ID Installer" certificate (for DMG/PKG signing)

### Setup

1. **Create a Developer ID certificate:**
   - Go to https://developer.apple.com/account
   - Certificates, Identifiers & Profiles → Certificates → Create
   - Choose "Developer ID Application" (for apps distributed outside the
     Mac App Store)
   - Upload the CSR from Keychain Access
   - Download and install the certificate

2. **Notarize the app (required for macOS 10.15+):**
   - Notarization is Apple's automated security scan
   - The app must be notarized before distribution

### Signing and notarizing

electron-builder handles signing automatically if the certificates are
installed in Keychain Access:

```bash
# Set these in your CI environment or shell before building
export APPLE_ID=<your-apple-id>
export APPLE_APP_SPECIFIC_PASSWORD=<app-specific-password>
export APPLE_TEAM_ID=<your-team-id>
export CSC_LINK=<path-to-developer-id-certificate.p12>
export CSC_KEY_PASSWORD=<p12-password>

# Build with signing and notarization
cd electron
npm run build:mac
```

Add the notarize config to `electron/package.json` build section:
```json
"mac": {
  "target": "dmg",
  "icon": "build/icon.icns",
  "category": "public.app-category.security",
  "hardenedRuntime": true,
  "gatekeeperAssess": false,
  "entitlements": "build/entitlements.mac.plist",
  "entitlementsInherit": "build/entitlements.mac.plist",
  "notarize": true
}
```

### Verifying the signature
```bash
# Check code signature
codesign -dv --verbose=4 "dist-electron/Remote Lockdown Admin-1.0.0.dmg"

# Check notarization
spctl --assess --verbose "dist-electron/Remote Lockdown Admin.app"
```

---

## CI/CD Integration

For GitHub Actions, set the signing credentials as repository secrets:

### Windows (Azure Trusted Signing)
```yaml
- name: Build and sign Windows installer
  env:
    AZURE_TRUSTED_SIGNING_ACCOUNT_NAME: ${{ secrets.AZURE_SIGNING_ACCOUNT }}
    AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME: ${{ secrets.AZURE_SIGNING_PROFILE }}
    AZURE_TRUSTED_SIGNING_CLIENT_ID: ${{ secrets.AZURE_SIGNING_CLIENT_ID }}
    AZURE_TRUSTED_SIGNING_CLIENT_SECRET: ${{ secrets.AZURE_SIGNING_CLIENT_SECRET }}
    AZURE_TRUSTED_SIGNING_TENANT_ID: ${{ secrets.AZURE_SIGNING_TENANT_ID }}
  run: cd electron && npm run build:win
```

### macOS (Apple Developer)
```yaml
- name: Build and sign macOS DMG
  env:
    APPLE_ID: ${{ secrets.APPLE_ID }}
    APPLE_APP_SPECIFIC_PASSWORD: ${{ secrets.APPLE_APP_SPECIFIC_PASSWORD }}
    APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}
    CSC_LINK: ${{ secrets.MAC_CERT_P12_BASE64 }}
    CSC_KEY_PASSWORD: ${{ secrets.MAC_CERT_PASSWORD }}
  run: cd electron && npm run build:mac
```

---

## Publishing to GitHub Releases

Once signed, publish the installers to GitHub Releases for auto-update:

```bash
# Set GitHub token for publishing
export GH_TOKEN=<your-github-personal-access-token>

# Build and publish (creates a GitHub Release with all installers)
cd electron
npm run publish
```

electron-builder will:
1. Build the installers for the current platform
2. Create a GitHub Release (if not exists for this version)
3. Upload the installers + `latest.yml` / `latest-mac.yml`
4. The `latest.yml` files are used by electron-updater to check for updates

### Release process
1. Update `version` in `electron/package.json`
2. Update `version` in root `package.json`
3. Commit: `git commit -m "release: v1.0.1"`
4. Tag: `git tag v1.0.1 && git push --tags`
5. Run `npm run publish` (or let CI do it on tag push)
6. The auto-updater will notify existing users of the new version

---

## Without Code Signing (Development/Test Only)

If you don't have signing certificates, you can still build unsigned installers:

```bash
cd electron
npm run build:win  # Produces unsigned installer
```

**Warnings:**
- Windows SmartScreen will warn users — they must click "More info" → "Run anyway"
- macOS Gatekeeper will block the app — users must right-click → "Open" → "Open"
- Auto-update will NOT work for unsigned Windows builds (electron-updater
  requires signature verification by default; set `verifyUpdateCodeSignature: false`
  in the build config to disable this)

---

## Automated Signing

The repository ships two helper scripts that automate signing configuration and
verification:

| Script | Purpose |
| --- | --- |
| `scripts/setup-signing.sh` | Interactively collect signing credentials and write them to a gitignored `.signing.env` file |
| `scripts/verify-signing.sh` | Verify the signature on a built Electron app/installer or agent binary |

### Configuring your environment with `setup-signing.sh`

`setup-signing.sh` walks you through collecting the credentials required for
your target platform(s) and writes them to `.signing.env` (mode 600, gitignored).
The generated file can be `source`d before a local build, and the same values
can be added as GitHub Secrets for CI/CD.

```bash
# Configure both Windows (Azure Trusted Signing) and macOS
./scripts/setup-signing.sh --platform both --method azure

# Configure Windows only, using a local PFX certificate
./scripts/setup-signing.sh --platform windows --method pfx

# Configure macOS only (Apple Developer ID + notarization)
./scripts/setup-signing.sh --platform macos --method developer-id
```

Options:
- `--platform <windows|macos|both>` — which platform to configure (default: `both`)
- `--method <azure|pfx|developer-id>` — signing method
  - `azure` (Windows): Azure Trusted Signing
  - `pfx` (Windows): local PFX code-signing certificate
  - `developer-id` (macOS): Apple Developer ID + notarization
- `--non-interactive` — read values from env/stdin without a TTY (useful in CI)

After running the script:

```bash
source .signing.env
cd electron && npm run build:win   # or build:mac
```

The script validates that all required env vars are set and prints the exact
GitHub Secret names to configure for CI.

---

## Azure Trusted Signing

Azure Trusted Signing (formerly Azure Code Signing) is the recommended approach
for CI/CD Windows signing because it does not require a USB hardware token.

### Required environment variables

| Variable | Description |
| --- | --- |
| `AZURE_TRUSTED_SIGNING_TENANT_ID` | Azure AD tenant ID |
| `AZURE_TRUSTED_SIGNING_ACCOUNT_NAME` | Trusted Signing account name |
| `AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE` | Certificate profile name |
| `AZURE_TRUSTED_SIGNING_CLIENT_ID` | Service principal (app) client ID |
| `AZURE_TRUSTED_SIGNING_CLIENT_SECRET` | Service principal client secret |

> Note: `setup-signing.sh` collects the first three interactively. The client
> ID/secret are only needed for unattended (CI) signing and should be configured
> as GitHub Secrets.

### CI configuration (GitHub Actions)

Add the following repository secrets
(`Settings → Secrets and variables → Actions`):

- `AZURE_TRUSTED_SIGNING_TENANT_ID`
- `AZURE_TRUSTED_SIGNING_ACCOUNT_NAME`
- `AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE`
- `AZURE_TRUSTED_SIGNING_CLIENT_ID`
- `AZURE_TRUSTED_SIGNING_CLIENT_SECRET`

Then in the workflow:

```yaml
- name: Build and sign Windows installer
  env:
    AZURE_TRUSTED_SIGNING_TENANT_ID: ${{ secrets.AZURE_TRUSTED_SIGNING_TENANT_ID }}
    AZURE_TRUSTED_SIGNING_ACCOUNT_NAME: ${{ secrets.AZURE_TRUSTED_SIGNING_ACCOUNT_NAME }}
    AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE: ${{ secrets.AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE }}
    AZURE_TRUSTED_SIGNING_CLIENT_ID: ${{ secrets.AZURE_TRUSTED_SIGNING_CLIENT_ID }}
    AZURE_TRUSTED_SIGNING_CLIENT_SECRET: ${{ secrets.AZURE_TRUSTED_SIGNING_CLIENT_SECRET }}
  run: cd electron && npm run build:win
```

electron-builder detects these env vars automatically and signs the installer
with Azure Trusted Signing — no additional `package.json` config is required.

---

## Agent Binary Signing

The agent is distributed as PyInstaller-built binaries (`lockdown-agent`,
`lockdown-watchdog`, `lockdown-recovery`). PyInstaller does not sign binaries
by default, so unsigned agent binaries may be flagged by Windows Defender /
SmartScreen and macOS Gatekeeper.

### Windows

Sign each built `.exe` with `signtool.exe` (or `AzureSignTool` for Azure
Trusted Signing):

```powershell
# Traditional PFX
signtool sign /fd SHA256 /a /f cert.pfx /p <password> agent\dist\lockdown-agent.exe

# Azure Trusted Signing (requires AzureSignTool)
AzureSignTool sign -kvu "https://<account>.eus.codesigning.azure.net/" \
  -kvi "$AZURE_TRUSTED_SIGNING_CLIENT_ID" \
  -kvt "$AZURE_TRUSTED_SIGNING_TENANT_ID" \
  -kvs "$AZURE_TRUSTED_SIGNING_CLIENT_SECRET" \
  -kvc "$AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE" \
  -tr "http://timestamp.digicert.com" -v agent\dist\lockdown-agent.exe
```

### macOS

Sign the agent binary with your Developer ID Application certificate:

```bash
codesign --sign "Developer ID Application: <Your Name> (<TEAM_ID>)" \
  --options runtime --timestamp agent/dist/lockdown-agent
```

For notarization, submit the signed binary with `xcrun notarytool submit` and
staple the ticket with `xcrun stapler staple`.

### Verifying agent signatures

```bash
./scripts/verify-signing.sh --agent agent/dist/lockdown-agent.exe
./scripts/verify-signing.sh --agent agent/dist/lockdown-agent
```

---

## Auto-Update Verification

electron-updater verifies the code signature of update packages before
installing them. For this to work:

1. **The initial install must be signed.** If the installed app is unsigned,
   electron-updater cannot verify the publisher of the downloaded update and
   will refuse to install it (or, if `verifyUpdateCodeSignature` is `false`,
   install it without verification — which is insecure).
2. **The update package must be signed with the same certificate.** A
   certificate mismatch causes the update to be rejected.
3. **The `latest.yml` / `latest-mac.yml` manifests** published to GitHub
   Releases contain the SHA512 checksum and signature metadata that
   electron-updater uses for verification.

### Verifying before release

Run `verify-signing.sh` against every artifact you intend to publish:

```bash
# Electron installer
./scripts/verify-signing.sh --app electron/dist-electron/"Remote Lockdown Admin Setup 1.0.0.exe"

# macOS DMG / app bundle
./scripts/verify-signing.sh --app electron/dist-electron/"Remote Lockdown Admin-1.0.0.dmg"

# Agent binary (optional but recommended)
./scripts/verify-signing.sh --agent agent/dist/lockdown-agent.exe
```

Exit codes:
- `0` — signed and valid
- `1` — unsigned
- `2` — signature present but invalid

### Manifest sanity check

Confirm that `latest.yml` (Windows) and `latest-mac.yml` (macOS) are present in
the GitHub Release and that the `sha512` field matches the published installer.
electron-builder generates these automatically when publishing with
`--publish always`.

---

## Troubleshooting

### "signtool not found" (Windows)
Install the Windows SDK, or run `verify-signing.sh` on a Windows host. The
script searches common Windows Kits paths and `PATH` for `signtool.exe`.

### "Azure Trusted Signing" build fails with auth error
- Verify the service principal has been granted the **Trusted Signing Certificate
  Profile Signer** role on the certificate profile.
- Confirm `AZURE_TRUSTED_SIGNING_CLIENT_SECRET` has not expired.
- Ensure the tenant ID, account name, and certificate profile name match
  exactly (case-sensitive).

### electron-builder does not sign on Windows
- Ensure `CSC_LINK` (PFX) **or** the `AZURE_TRUSTED_SIGNING_*` env vars are set
  — not both. Having both can confuse the signer.
- For PFX, `CSC_LINK` may be a file path or a base64-encoded string. If using a
  path, ensure it is readable by the build process.
- Check `win.signingHashAlgorithms` includes `sha256`.

### macOS build is not notarized
- Confirm `mac.notarize: true` is set in `electron/package.json`.
- Ensure `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID` are all
  set. Notarization fails silently (or warns) if any are missing.
- The app-specific password is generated at
  https://appleid.apple.com → Sign-In and Security → App-Specific Passwords.
- After notarization, electron-builder staples the ticket automatically. Verify
  with `spctl --assess --type execute <path>`.

### "codesign verification FAILED" on macOS
- The signature may have been broken by post-build modification (e.g. editing
  the `.app` bundle). Rebuild from a clean `dist-electron/`.
- Deep verification (`--deep --strict`) can fail if an embedded framework is
  unsigned. Ensure all bundled frameworks are signed with the same Developer ID.
- Run `codesign -dv --verbose=4 <path>` for detailed identity information.

### Auto-update rejected with "signature verification failed"
- The update was signed with a different certificate than the installed app.
  Use the same certificate for every release.
- If you are migrating certificates, ship one release signed with **both** the
  old and new certificates, then drop the old one in the following release.
- As a last resort for development, `verifyUpdateCodeSignature: false` disables
  verification — **never use this in production**.

### `.signing.env` not loaded
- The file is gitignored and must be `source`d explicitly:
  `source .signing.env`.
- In CI, do not commit `.signing.env`; configure the same values as GitHub
  Secrets instead.
