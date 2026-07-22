# Remote Lockdown Admin — Electron App

The admin desktop application for the Remote Lockdown System. Built with
Electron + React, packaged with electron-builder, auto-updated via
electron-updater.

---

## Prerequisites

- Node.js 18+
- npm
- For Windows builds: Windows 10+ (or cross-compile from Linux with Wine)
- For macOS builds: macOS (Xcode + Apple Developer certificate)
- For Linux builds: Linux (fpm for AppImage)

---

## Development

```bash
# Install dependencies
npm install

# Run in development mode (loads dashboard from Vite dev server)
npm run dev
# Or start the dashboard dev server separately:
cd ../dashboard && npm run dev
# Then start electron:
cd ../electron && npm start
```

### Project Structure
```
electron/
├── main.js              # Electron main process
├── preload.js           # Preload script (context bridge)
├── config.js            # App configuration (SQLite path, dashboard path)
├── updater.js           # Auto-update logic (electron-updater)
├── server-starter.js    # Starts the embedded Node.js server
├── package.json         # electron-builder config + scripts
├── build/               # App icons + macOS entitlements
│   ├── icon.ico         # Windows icon
│   ├── icon.icns        # macOS icon
│   ├── icon.png         # Linux icon
│   └── entitlements.mac.plist
└── dist-electtron/      # Built main/preload (gitignored)
```

---

## Building

### Build for current platform
```bash
npm run build
```
Output: `dist/` directory with the installer.

### Build for specific platform
```bash
# Windows (NSIS .exe + MSI)
npm run build:win

# macOS (DMG)
npm run build:mac

# Linux (AppImage)
npm run build:linux
```

### Build for all platforms (from CI)
```bash
npm run build:all
```

---

## Code Signing

See [docs/CODE_SIGNING.md](../docs/CODE_SIGNING.md) for detailed instructions.

### Windows (Azure Trusted Signing)
1. Set up Azure Trusted Signing account (~$10/mo)
2. Configure environment variables:
   ```bash
   AZURE_TRUSTED_SIGNING_TENANT_ID=your-tenant-id
   AZURE_TRUSTED_SIGNING_ACCOUNT_NAME=your-account
   AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE=your-profile
   ```
3. Build with signing:
   ```bash
   npm run build:win
   ```

### macOS (Apple Developer)
1. Obtain a Developer ID Application certificate from Apple ($99/yr)
2. Export certificate as .p12 and set environment variables:
   ```bash
   CSC_LINK=path/to/cert.p12
   CSC_KEY_PASSWORD=your-password
   APPLE_ID=your-apple-id@example.com
   APPLE_APP_SPECIFIC_PASSWORD=app-specific-password
   APPLE_TEAM_ID=your-team-id
   ```
3. Build with signing + notarization:
   ```bash
   npm run build:mac
   ```

### Unsigned builds (development only)
```bash
CSC_IDENTITY_AUTO_DISCOVERY=false npm run build
```
Unsigned builds will show "Unknown Publisher" warnings on Windows and
"app is from an unidentified developer" on macOS.

---

## Auto-Update

The app uses `electron-updater` to check for updates on GitHub Releases.

### How it works
1. On startup (10s delay), the app checks GitHub Releases for a newer version
2. If an update is available, a dialog asks the user to download
3. Download progress is shown in the taskbar
4. When complete, the user is prompted to restart and install

### Publishing an update
1. Bump the version in `package.json`:
   ```bash
   npm version patch  # or minor, major
   ```
2. Build and publish:
   ```bash
   npm run publish
   ```
   This builds the app and uploads to GitHub Releases.
3. Users will see the update on next app launch.

### Requirements for auto-update
- Code signing (Windows requires signed builds for auto-update)
- GitHub repository with Releases
- `GH_TOKEN` environment variable for publishing
- Semver version numbers in `package.json`

---

## Configuration

### electron-builder config (package.json `build` field)
- **Windows:** NSIS (primary) + MSI (enterprise), x64
- **macOS:** DMG, x64 + arm64, hardened runtime + entitlements
- **Linux:** AppImage, x64
- **App ID:** `com.remotelockdown.admin`
- **Publisher:** Remote Lockdown

### Embedded resources
- `extraResources/`: Agent binaries (built from `agent/` directory)
  - `lockdown-agent.exe` / `lockdown-agent` (main agent)
  - `lockdown-watchdog.exe` / `lockdown-watchdog` (process monitor)
- `dashboard/dist/`: Built React dashboard (static files)

### Building agent binaries for embedding
Before building the Electron app, build the agent binaries:
```bash
cd ../agent
./build.sh        # Linux
# or
./build.ps1       # Windows
```
The built binaries should be in `agent/dist/` and will be copied to
`extraResources/` during the Electron build.

---

## Scripts

| Script | Description |
|--------|-------------|
| `npm start` | Start Electron in dev mode |
| `npm run dev` | Start with Vite dev server |
| `npm run build` | Build for current platform |
| `npm run build:win` | Build Windows installer |
| `npm run build:mac` | Build macOS DMG |
| `npm run build:linux` | Build Linux AppImage |
| `npm run build:all` | Build all platforms |
| `npm run publish` | Build + publish to GitHub Releases |
