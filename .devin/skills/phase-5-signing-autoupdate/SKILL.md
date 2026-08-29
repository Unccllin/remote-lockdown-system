---
name: phase-5-signing-autoupdate
description: Code signing setup, verification scripts, and auto-update documentation for Windows and macOS
---

# Phase 5 — Code Signing & Auto-Update

## Context

Code signing is critical for an anti-theft tool:
- **Windows**: Unsigned executables trigger SmartScreen warnings, making installation suspicious
- **macOS**: Unsigned apps are blocked by Gatekeeper. Notarization is required for distribution
- **Auto-update**: electron-updater verifies signatures on update packages

## Current State

### Signing Scripts
- `scripts/setup-signing.sh` — configures signing environment
  - `--platform <windows|macos|both>` — which platform to configure
  - `--method <azure|pfx|developer-id>` — signing method
  - For Windows Azure: prompts for tenant ID, account name, certificate profile
  - For Windows PFX: prompts for PFX file path and password
  - For macOS: prompts for Apple Developer ID P12, Apple ID, app-specific password, team ID
  - Writes configuration to `.signing.env` (gitignored)
  - Validates configuration by checking required env vars are set
  - Prints next steps (how to use in CI)
- `scripts/verify-signing.sh` — verifies code signatures
  - `--app <path>` — path to built Electron app/installer
  - `--agent <path>` — path to agent binary
  - Windows: `signtool verify /pa /v <path>` (if signtool available)
  - macOS: `codesign --verify --deep --strict <path>` + `spctl --assess --type execute <path>`
  - Linux: skip (no signing required)
  - Reports: signed/unsigned, valid/invalid, publisher/identity
  - Exit 0 if valid, 1 if unsigned, 2 if invalid

### Documentation
- `docs/CODE_SIGNING.md` — comprehensive signing documentation
  - Windows (Authenticode) and macOS (Developer ID + notarization) signing
  - Automated Signing section with setup-signing.sh usage
  - Azure Trusted Signing instructions
  - CI/CD signing configuration (GitHub Secrets)
  - Agent binary signing instructions
  - Auto-update verification documentation
  - Troubleshooting section

### Electron Config
- `electron/package.json` — `win.signingHashAlgorithms` present, `mac.notarize` configured
- `electron/updater.js` — uses `electron-updater` package
  - Update flow: check GitHub Releases → download `latest.yml` (Win) / `latest-mac.yml` (Mac) → verify signature → download update → install
  - electron-updater verifies the update's code signature matches the installed app's publisher

### Release Workflow
- `.github/workflows/release.yml` — Windows build with Azure Trusted Signing env vars, macOS build with Apple signing env vars, Linux build (no signing)
- Agent binary signing steps added to publish-agent-binaries job

## Verification

```bash
# Verify signing scripts exist
ls scripts/setup-signing.sh scripts/verify-signing.sh

# Verify signing documentation exists
ls docs/CODE_SIGNING.md

# Verify electron config has notarize
grep -i "notarize" electron/package.json

# Verify signing env template
scripts/setup-signing.sh --help 2>/dev/null || head -20 scripts/setup-signing.sh

# Full environment verification (includes signing dry-run)
make verify-env

# Full verification sweep
make full-verify
```

## Regression checks

1. **Verify setup-signing.sh supports both Azure and PFX**: `grep -c "azure\|pfx" scripts/setup-signing.sh`
2. **Verify verify-signing.sh checks both app and agent**: `grep -c "\-\-app\|\-\-agent" scripts/verify-signing.sh`
3. **Verify notarization is required for macOS**: `grep -i "notarize" electron/package.json docs/CODE_SIGNING.md`
4. **Verify auto-update verification is documented**: `grep -i "auto.update\|electron-updater" docs/CODE_SIGNING.md`
5. **Verify agent binary signing is documented**: `grep -i "agent.*sign\|signtool\|codesign" docs/CODE_SIGNING.md`

## Gotchas

- If the initial install is unsigned, auto-updates can't verify signatures → update fails or is insecure
- Azure Trusted Signing is recommended for CI (no hardware token needed) — traditional PFX requires a hardware token for EV certificates
- macOS notarization is required for macOS Sequoia and later — without it, the app is blocked entirely
- Unsigned agent binaries may be flagged by antivirus/EDR — signing steps are in release.yml
- `latest-mac.yml` merging for per-arch builds is handled in release.yml

## Graph Integration

**Phase node**: `P5` in `.devin/graph/GRAPH-SPEC.yaml` — status: COMPLETE

This phase is part of the node graph — the center and heart of the project.
Before working on this phase, an agent MUST:

1. Read `.devin/graph/GRAPH-SPEC.yaml` — locate the `P5` node
2. Read `.devin/graph/current-state.md` — compact session state (read FIRST)
3. Read `docs/adr/DEBT-LEDGER.md` — check for open debt items blocking this phase
4. Complete RULE-ZERO (read this skill file + source code before coding)
5. At session end, append a status block to `trace.md` and run `make gen-state`

**Verification nodes gating this phase**: V-ELECTRON-SYNTAX

**Enforcement paths touched by this phase**: E-AUTO-UPDATE

**Debt items related to this phase**: — (none)

**Graph invariants that apply**:
- I1: Phase dependencies must be COMPLETE before this phase runs
- I5: RULE-ZERO must be complete before any code changes
- I7: If this phase is COMPLETE, its `.complete` file must have a commit hash + artifact ref (D-002 CLOSED)
