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
