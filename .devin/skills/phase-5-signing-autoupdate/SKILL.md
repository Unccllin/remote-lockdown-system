# Skill Domain: Phase 5 — Code Signing & Auto-Update

## Context

Code signing is critical for an anti-theft tool:
- **Windows**: Unsigned executables trigger SmartScreen warnings, making installation suspicious
- **macOS**: Unsigned apps are blocked by Gatekeeper. Notarization is required for distribution
- **Auto-update**: electron-updater verifies signatures on update packages

## Current State

### release.yml
- Windows build: `npx electron-builder --win --publish always`
  - Azure Trusted Signing env vars are commented out
  - No CSC_LINK or certificate configuration
- macOS build: `npx electron-builder --mac --arch --publish never`
  - Apple signing env vars are commented out (CSC_LINK, APPLE_ID, etc.)
- Linux build: `npx electron-builder --linux --publish always`
  - No signing (not required for Linux)

### docs/CODE_SIGNING.md
- Documents Windows (Authenticode) and macOS (Developer ID + notarization) signing
- Manual process — no automation scripts
- No Azure Trusted Signing instructions
- No notarization automation

### electron/package.json
- `win.signingHashAlgorithms`: present
- `mac.notarize`: not configured
- No `certificateFile` or `cscLink` in build config

## Research Findings

### Windows Code Signing (2024/2025)
1. **Traditional**: Purchase OV/EV code signing certificate, export as PFX, use `CSC_LINK` env var
2. **Azure Trusted Signing**: Cloud-based signing, no local certificate. electron-builder supports it via env vars:
   - `AZURE_TRUSTED_SIGNING_TENANT_ID`
   - `AZURE_TRUSTED_SIGNING_ACCOUNT_NAME`
   - `AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE`
3. **Hardware token**: EV certificates require hardware token. CI needs the token or Azure Trusted Signing
4. **Recommendation**: Azure Trusted Signing for CI (no hardware token needed)

### macOS Code Signing + Notarization
1. **Developer ID Application certificate**: Required for distribution outside Mac App Store
2. **Notarization**: Apple's notary service verifies the app is malware-free
3. **electron-builder automation**:
   - `CSC_LINK`: base64-encoded P12 certificate
   - `CSC_KEY_PASSWORD`: certificate password
   - `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`: for notarization
4. **Notarization process**: electron-builder handles notarization automatically when `notarize: true` in mac config
5. **Stapling**: electron-builder staples the notarization ticket to the app

### Auto-Update (electron-updater)
- `electron/updater.js` exists — uses `electron-updater` package
- Update flow: check GitHub Releases → download `latest.yml` (Win) / `latest-mac.yml` (Mac) → verify signature → download update → install
- **Verification**: electron-updater verifies the update's code signature matches the installed app's publisher
- **Critical**: If the initial install is unsigned, auto-updates can't verify signatures → update fails or is insecure
- **latest-mac.yml merging**: release.yml already handles per-arch manifest merging

### Agent Binary Signing
- PyInstaller binaries are NOT signed by default
- Windows: `signtool.exe sign` on the built .exe
- macOS: `codesign --sign` on the built binary
- The release.yml currently doesn't sign agent binaries
- **Important**: Unsigned agent binaries may be flagged by antivirus/EDR

## Reasoning Questions

1. **Should we implement signing in CI or provide local scripts?**
   - Answer: Both. CI signing for releases (automated), local scripts for testing. `setup-signing.sh` helps developers configure their environment. CI uses secrets.

2. **Should we sign agent binaries in addition to the Electron app?**
   - Answer: Yes. Unsigned agent binaries will be flagged by Windows Defender and macOS Gatekeeper. Add signing steps to the `publish-agent-binaries` job in release.yml.

3. **Should notarization be required or optional?**
   - Answer: Required for macOS. Without notarization, macOS Sequoia and later block the app entirely. Set `notarize: true` in electron-builder mac config.

4. **Should we use Azure Trusted Signing or traditional PFX?**
   - Answer: Support both. `setup-signing.sh` detects which is configured. Azure Trusted Signing is recommended for CI (no hardware token). Document both paths.

5. **Should auto-update verification be tested?**
   - Answer: Yes. `verify-signing.sh` should: (a) verify the Electron app is signed, (b) verify the signature is valid, (c) verify the auto-update manifest format is correct.

## Implementation Guidelines

### scripts/setup-signing.sh
- `--platform <windows|macos|both>` — which platform to configure
- `--method <azure|pfx|developer-id>` — signing method
- For Windows Azure: prompt for tenant ID, account name, certificate profile
- For Windows PFX: prompt for PFX file path and password
- For macOS: prompt for Apple Developer ID P12, Apple ID, app-specific password, team ID
- Write configuration to `.signing.env` (gitignored)
- Validate configuration by checking required env vars are set
- Print next steps (how to use in CI)

### scripts/verify-signing.sh
- `--app <path>` — path to built Electron app/installer
- `--agent <path>` — path to agent binary
- Windows: `signtool verify /pa /v <path>` (if signtool available)
- macOS: `codesign --verify --deep --strict <path>` + `spctl --assess --type execute <path>`
- Linux: skip (no signing required)
- Report: signed/unsigned, valid/invalid, publisher/identity
- Exit 0 if valid, 1 if unsigned, 2 if invalid

### docs/CODE_SIGNING.md updates
- Add "Automated Signing" section with setup-signing.sh usage
- Add Azure Trusted Signing instructions
- Add CI/CD signing configuration (GitHub Secrets)
- Add agent binary signing instructions
- Add auto-update verification documentation
- Add troubleshooting section

### electron/package.json
- Add `mac.notarize: true` to build config
- Ensure `win.signingHashAlgorithms` is correct
- Document (in comments or README) which env vars enable signing

## File Boundaries
- CREATE: `scripts/setup-signing.sh`, `scripts/verify-signing.sh`
- EDIT: `docs/CODE_SIGNING.md` (add automation sections)
- EDIT: `electron/package.json` (add `notarize: true` to mac config)
- DO NOT EDIT: `.github/workflows/release.yml` (Phase 4 owns workflow files — coordinate if needed)
- DO NOT EDIT: `electron/updater.js`, `electron/main.js`

## Graph Integration

**Phase node**: `P5` in `.devin/graph/GRAPH-SPEC.yaml`

This phase is part of the node graph — the center and heart of the project.
Before working on this phase, an agent MUST:

1. Read `.devin/graph/GRAPH-SPEC.yaml` — locate the `P5` node
2. Read `.devin/graph/trace.md` — check last session's context
3. Read `docs/adr/DEBT-LEDGER.md` — check for open debt items blocking this phase
4. Complete RULE-ZERO (read this skill file + source code before coding)
5. At session end, append a status block to `trace.md`

**Verification nodes gating this phase**: V-ELECTRON-SYNTAX

**Enforcement paths touched by this phase**: E-AUTO-UPDATE

**Debt items related to this phase**: —

**Graph invariants that apply**:
- I1: Phase dependencies must be COMPLETE before this phase runs
- I5: RULE-ZERO must be complete before any code changes
- I7: If this phase is COMPLETE, its `.complete` file must have a commit hash + artifact ref

