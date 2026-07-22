/**
 * installer.js — Agent installer generation endpoint.
 *
 * Phase 4: When the admin clicks "Download Agent Installer" for a device,
 * this endpoint packages the pre-built agent binary + device-specific config
 * + install script into a ZIP file and streams it to the browser.
 *
 * The agent binaries are bundled in the Electron app's extraResources:
 *   Production:  process.resourcesPath/agent/lockdown-agent.exe
 *   Dev:         ../agent/dist/lockdown-agent  (or .exe on Windows)
 *
 * Cross-platform support (Solution A — Hybrid):
 *   The admin app bundles its own platform's agent binaries locally.
 *   If the admin requests an installer for a DIFFERENT platform (e.g.,
 *   running on Linux but generating a Windows installer), the endpoint
 *   downloads the missing binary from GitHub Releases on-demand, caches
 *   it in the userData directory, and packages it into the ZIP.
 *
 *   Binary lookup order:
 *     1. Local bundled binary (resources/agent/ or agent/dist/)
 *     2. Cached binary in userData/agent-cache/{platform}/
 *     3. Download from GitHub Releases (cached after download)
 *
 *   GitHub Releases assets are named:
 *     lockdown-agent-{platform}-{arch}{ext}
 *     lockdown-watchdog-{platform}-{arch}{ext}
 *     lockdown-recovery-{platform}-{arch}{ext}
 *
 *   Checksums are verified against the SHA256SUMS file in the Release.
 *
 * The ZIP contains:
 *   - lockdown-agent (or .exe)   — the standalone agent binary
 *   - lockdown-watchdog (or .exe) — the process monitor
 *   - config.json                 — device-specific config (server_url, api_key, hostname)
 *   - install.ps1 (Windows)       — PowerShell install script (registers NSSM service)
 *   - install.sh (Linux/macOS)    — Shell install script (systemd service)
 *   - README.txt                  — Quick start instructions
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const https = require('https');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { hashApiKey } = require('../db/apiKey');

const router = express.Router();

// ---------------------------------------------------------------------------
// Agent binary discovery
// ---------------------------------------------------------------------------

/**
 * Find the directory containing the pre-built agent binaries.
 *
 * In production (Electron packaged): process.resourcesPath/agent/
 * In development: agent/dist/ relative to the server directory
 */
function getAgentBinariesDir() {
  const candidates = [];

  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'agent'));
  }

  // Dev mode: agent/dist relative to repo root
  // server/src/routes/installer.js → ../../../../agent/dist
  candidates.push(path.join(__dirname, '..', '..', '..', '..', 'agent', 'dist'));

  // Also check relative to electron directory (when running via Electron dev)
  candidates.push(path.join(__dirname, '..', '..', '..', 'agent', 'dist'));

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      // Verify at least one agent binary exists
      const hasBinary =
        fs.existsSync(path.join(candidate, 'lockdown-agent')) ||
        fs.existsSync(path.join(candidate, 'lockdown-agent.exe'));
      if (hasBinary) {
        return candidate;
      }
    }
  }

  return null;
}

/**
 * Determine the target platform from query param or default to the server's platform.
 * @param {string} requestedPlatform - 'win' or 'linux' from query param
 * @returns {{platform: string, ext: string, agentName: string, watchdogName: string}}
 */
function getPlatformConfig(requestedPlatform) {
  const platform = requestedPlatform || (process.platform === 'win32' ? 'win' : 'linux');
  if (platform === 'win') {
    return {
      platform: 'win',
      ext: '.exe',
      agentName: 'lockdown-agent.exe',
      watchdogName: 'lockdown-watchdog.exe',
    };
  }
  return {
    platform: 'linux',
    ext: '',
    agentName: 'lockdown-agent',
    watchdogName: 'lockdown-watchdog',
  };
}

// ---------------------------------------------------------------------------
// Cross-platform binary resolution (Solution A — Hybrid local + remote)
// ---------------------------------------------------------------------------
//
// When the admin app runs on platform X and requests an installer for
// platform Y, the Y-platform agent binary won't be in the local bundle.
// This module downloads it from GitHub Releases on-demand, caches it,
// and verifies its SHA256 checksum.
//
// Lookup order for each binary:
//   1. Local bundled binary (resources/agent/ or agent/dist/)
//   2. Cached binary in userData/agent-cache/{platform}/
//   3. Download from GitHub Releases → cache → return
//

/**
 * Map our internal platform names to GitHub Releases asset naming.
 * 'win' → 'windows', 'linux' → 'linux', 'mac' → 'darwin'
 */
function getReleasePlatformName(internalPlatform) {
  if (internalPlatform === 'win') return 'windows';
  if (internalPlatform === 'mac') return 'darwin';
  return 'linux';
}

/**
 * Get the cache directory for downloaded agent binaries.
 * Uses userData/agent-cache in Electron, or a temp dir in standalone mode.
 */
function getCacheDir() {
  // In Electron: use userData directory (set via env var by server-starter)
  if (process.env.USER_DATA_DIR) {
    return path.join(process.env.USER_DATA_DIR, 'agent-cache');
  }
  // In Electron production: process.resourcesPath is set, userData is nearby
  if (process.resourcesPath) {
    // userData is typically ../ from resourcesPath on most platforms
    const candidates = [
      path.join(process.resourcesPath, '..', 'agent-cache'),
      path.join(process.env.HOME || '/tmp', '.remote-lockdown-cache'),
    ];
    for (const c of candidates) {
      try {
        if (!fs.existsSync(c)) fs.mkdirSync(c, { recursive: true });
        return c;
      } catch (e) { /* try next */ }
    }
  }
  // Standalone server: use a temp directory
  const fallback = path.join(require('os').tmpdir(), 'remote-lockdown-agent-cache');
  if (!fs.existsSync(fallback)) fs.mkdirSync(fallback, { recursive: true });
  return fallback;
}

/**
 * Get GitHub Releases configuration from env vars.
 * Defaults to the public repo, but can be overridden for self-hosted forks.
 */
function getGitHubReleaseConfig() {
  return {
    owner: process.env.AGENT_BINARY_RELEASE_OWNER || 'unccllin',
    repo: process.env.AGENT_BINARY_RELEASE_REPO || 'remote-lockdown-system',
    tag: process.env.AGENT_BINARY_RELEASE_TAG || 'latest', // 'latest' or 'v1.0.0'
    token: process.env.GITHUB_TOKEN || null, // optional, for private repos / rate limits
  };
}

/**
 * Make an HTTPS GET request and return the response body as a Buffer or string.
 * Follows up to 5 redirects (GitHub Releases uses 302 redirects to CDN).
 * @returns {Promise<{data: Buffer, statusCode: number, headers: Object}>}
 */
function httpsGet(url, options = {}) {
  return new Promise((resolve, reject) => {
    const timeout = options.timeout || 60000; // 60s default
    const maxRedirects = options.maxRedirects || 5;

    const req = https.get(url, {
      headers: {
        'User-Agent': 'remote-lockdown-admin/1.0',
        'Accept': options.accept || 'application/octet-stream',
        ...(options.token ? { 'Authorization': `Bearer ${options.token}` } : {}),
      },
    }, (res) => {
      // Handle redirects
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && maxRedirects > 0) {
        res.resume(); // drain
        return resolve(httpsGet(res.headers.location, { ...options, maxRedirects: maxRedirects - 1 }));
      }

      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }

      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          data: Buffer.concat(chunks),
          statusCode: res.statusCode,
          headers: res.headers,
        });
      });
      res.on('error', reject);
    });

    req.on('error', reject);
    req.setTimeout(timeout, () => {
      req.destroy(new Error(`Request timeout after ${timeout}ms`));
    });
  });
}

/**
 * Fetch the latest GitHub Release info (or a specific tag) via the REST API.
 * Returns the release object with assets array.
 * @returns {Promise<{tag_name: string, assets: Array<{name: string, browser_download_url: string, size: number}>}>}
 */
async function fetchReleaseInfo() {
  const config = getGitHubReleaseConfig();
  const url = config.tag === 'latest'
    ? `https://api.github.com/repos/${config.owner}/${config.repo}/releases/latest`
    : `https://api.github.com/repos/${config.owner}/${config.repo}/releases/tags/${config.tag}`;

  const { data } = await httpsGet(url, {
    accept: 'application/vnd.github+json',
    token: config.token,
    timeout: 15000,
  });

  const release = JSON.parse(data.toString('utf8'));
  if (!release || !release.assets) {
    throw new Error(`Invalid release response from GitHub API`);
  }
  return release;
}

/**
 * Fetch and parse the SHA256SUMS file from the release assets.
 * Returns a map of { filename: sha256hex }.
 * @param {object} release - Release object from fetchReleaseInfo()
 * @returns {Promise<Object<string, string>>}
 */
async function fetchChecksums(release) {
  const checksumsAsset = release.assets.find(a => a.name === 'SHA256SUMS');
  if (!checksumsAsset) {
    console.warn('[installer] No SHA256SUMS file in release — checksum verification disabled');
    return {};
  }

  const { data } = await httpsGet(checksumsAsset.browser_download_url, {
    timeout: 15000,
    token: getGitHubReleaseConfig().token,
  });

  const text = data.toString('utf8');
  const checksums = {};
  for (const line of text.split('\n')) {
    const match = line.match(/^([a-f0-9]{64})\s+\*?(.+)$/);
    if (match) {
      checksums[match[2].trim()] = match[1];
    }
  }
  return checksums;
}

/**
 * Download a specific agent binary from GitHub Releases.
 * Verifies SHA256 checksum if SHA256SUMS is available.
 * Caches the binary in the cache directory.
 *
 * @param {string} internalPlatform - 'win', 'linux', or 'mac'
 * @param {string} binaryName - 'lockdown-agent', 'lockdown-watchdog', or 'lockdown-recovery'
 * @returns {Promise<string>} Path to the downloaded (and cached) binary
 */
async function downloadBinaryFromGitHub(internalPlatform, binaryName) {
  const releasePlatform = getReleasePlatformName(internalPlatform);
  const arch = 'x64';
  const ext = internalPlatform === 'win' ? '.exe' : '';
  const assetName = `${binaryName}-${releasePlatform}-${arch}${ext}`;

  console.log(`[installer] Downloading ${assetName} from GitHub Releases...`);

  // Fetch release info
  const release = await fetchReleaseInfo();

  // Find the asset
  const asset = release.assets.find(a => a.name === assetName);
  if (!asset) {
    throw new Error(`Agent binary not found in GitHub Release ${release.tag_name}: ${assetName}. ` +
      `Available assets: ${release.assets.map(a => a.name).join(', ')}`);
  }

  // Download the binary
  const { data } = await httpsGet(asset.browser_download_url, {
    timeout: 120000, // 2 minutes for large binaries
    token: getGitHubReleaseConfig().token,
  });

  // Verify checksum
  const checksums = await fetchChecksums(release);
  if (checksums[assetName]) {
    const hash = crypto.createHash('sha256').update(data).digest('hex');
    if (hash !== checksums[assetName]) {
      throw new Error(`Checksum mismatch for ${assetName}: expected ${checksums[assetName]}, got ${hash}`);
    }
    console.log(`[installer] Checksum verified for ${assetName}`);
  }

  // Cache the binary
  const cacheDir = getCacheDir();
  const platformCacheDir = path.join(cacheDir, internalPlatform);
  if (!fs.existsSync(platformCacheDir)) {
    fs.mkdirSync(platformCacheDir, { recursive: true });
  }

  // Use the local platform's naming convention for the cached file
  const plat = getPlatformConfig(internalPlatform);
  const localName = internalPlatform === 'win'
    ? `${binaryName}.exe`
    : binaryName;
  const cachedPath = path.join(platformCacheDir, localName);

  fs.writeFileSync(cachedPath, data);
  // Make executable on Unix
  if (internalPlatform !== 'win') {
    fs.chmodSync(cachedPath, 0o755);
  }

  console.log(`[installer] Cached ${assetName} → ${cachedPath} (${(data.length / 1024 / 1024).toFixed(1)}MB)`);
  return cachedPath;
}

/**
 * Resolve an agent binary path for the requested platform.
 *
 * Lookup order:
 *   1. Local bundled binary (resources/agent/ or agent/dist/)
 *   2. Cached binary in cacheDir/{platform}/
 *   3. Download from GitHub Releases → cache → return
 *
 * @param {string} internalPlatform - 'win' or 'linux'
 * @param {string} binaryName - e.g. 'lockdown-agent.exe' or 'lockdown-agent'
 * @param {string} binaryBaseName - e.g. 'lockdown-agent' (without extension)
 * @returns {Promise<string|null>} Path to the binary, or null if not available
 */
async function resolveAgentBinary(internalPlatform, binaryName, binaryBaseName) {
  // 1. Check local bundled binaries
  const binariesDir = getAgentBinariesDir();
  if (binariesDir) {
    const localPath = path.join(binariesDir, binaryName);
    if (fs.existsSync(localPath)) {
      return localPath;
    }
  }

  // 2. Check cache
  const cacheDir = getCacheDir();
  const platformCacheDir = path.join(cacheDir, internalPlatform);
  const cachedPath = path.join(platformCacheDir, binaryName);
  if (fs.existsSync(cachedPath)) {
    console.log(`[installer] Using cached binary: ${cachedPath}`);
    return cachedPath;
  }

  // 3. Download from GitHub Releases
  try {
    const downloadedPath = await downloadBinaryFromGitHub(internalPlatform, binaryBaseName);
    return downloadedPath;
  } catch (err) {
    console.error(`[installer] Failed to download ${binaryBaseName} for ${internalPlatform}:`, err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Install script templates
// ---------------------------------------------------------------------------

/**
 * Generate the Windows PowerShell install script.
 * Installs the agent + watchdog as a Windows service using NSSM.
 * Phase 7: Shows EULA + tracking disclosure, registers uninstaller.
 */
function generateInstallPs1(config, hostname) {
  const serviceName = 'LockdownAgent';
  const watchdogServiceName = 'LockdownWatchdog';
  const installDir = 'C:\\Program Files\\LockdownAgent';

  return `# PowerShell install script for Remote Lockdown Agent
# Device: ${hostname}
# Generated: ${new Date().toISOString()}
#
# Run as Administrator: Right-click → Run with PowerShell
# Or: powershell -ExecutionPolicy Bypass -File install.ps1

#Requires -RunAsAdministrator

$ErrorActionPreference = "Stop"
$serviceName = "${serviceName}"
$watchdogServiceName = "${watchdogServiceName}"
$installDir = "${installDir}"

# --- Phase 7: EULA + Tracking Disclosure ---
Write-Host "=== Remote Lockdown Agent Installer ===" -ForegroundColor Green
Write-Host "Device: ${hostname}"
Write-Host ""
Write-Host "IMPORTANT — PLEASE READ CAREFULLY" -ForegroundColor Yellow
Write-Host ""
Write-Host "This software is an anti-theft device protection agent."
Write-Host "By installing this software, you acknowledge that:"
Write-Host ""
Write-Host "  1. You own or are authorized to manage this device"
Write-Host "  2. This agent will periodically check in with the admin server"
Write-Host "  3. If this device is reported stolen, the agent will:"
Write-Host "     - Encrypt the locked folder to prevent unauthorized access"
Write-Host "     - Lock the boot loader (BIOS/UEFI) on supported hardware"
Write-Host "     - Collect location data (IP-based and/or GPS/WiFi if available)"
Write-Host "  4. Location data is only collected when the device is flagged as stolen"
Write-Host "  5. Location data is retained for 90 days (configurable) then auto-deleted"
Write-Host "  6. The agent does NOT monitor: browsing, files, keystrokes, audio, video"
Write-Host ""
Write-Host "See EULA.txt and PRIVACY_POLICY.txt for full terms."
Write-Host ""

$eulaAccepted = $false

# Check if running in interactive mode
if ($Host.Name -eq "ConsoleHost") {
    $response = Read-Host "Do you accept the EULA and acknowledge the tracking capabilities? (yes/no)"
    if ($response -match "^[Yy]es$") {
        $eulaAccepted = $true
    }
} else {
    # Non-interactive (e.g., double-click): show dialog
    Add-Type -AssemblyName Microsoft.VisualBasic
    $result = [Microsoft.VisualBasic.Interaction]::MsgBox(
        "Remote Lockdown Agent will be installed on this device.\`n\`n" +
        "This agent includes anti-theft tracking capabilities:\`n" +
        "- If this device is reported stolen, location data will be collected\`n" +
        "- The locked folder will be encrypted\`n" +
        "- Boot loader may be locked (BIOS/UEFI)\`n\`n" +
        "Location data is only collected when the device is flagged as stolen.\`n\`n" +
        "Do you accept the EULA and acknowledge these capabilities?",
        4,  # vbYesNo
        "Remote Lockdown Agent — EULA Acceptance"
    )
    if ($result -eq 6) {  # vbYes
        $eulaAccepted = $true
    }
}

if (-not $eulaAccepted) {
    Write-Host "EULA not accepted. Installation cancelled." -ForegroundColor Red
    exit 1
}

Write-Host "EULA accepted. Proceeding with installation..." -ForegroundColor Green
Write-Host ""

# Create install directory
if (!(Test-Path $installDir)) {
    New-Item -ItemType Directory -Path $installDir -Force | Out-Null
}

# Copy binaries
Copy-Item "lockdown-agent.exe" "$installDir\\lockdown-agent.exe" -Force
Copy-Item "lockdown-watchdog.exe" "$installDir\\lockdown-watchdog.exe" -Force
Write-Host "Binaries copied to $installDir"

# Copy config
Copy-Item "config.json" "$installDir\\config.json" -Force
Write-Host "Config copied to $installDir\\config.json"

# Check if NSSM is available (bundled or on PATH)
$nssmPath = Join-Path $installDir "nssm.exe"
if (!(Test-Path $nssmPath)) {
    # Try PATH
    $nssmPath = (Get-Command nssm.exe -ErrorAction SilentlyContinue).Source
}

if ($nssmPath) {
    Write-Host "Using NSSM: $nssmPath"

    # Install agent service
    & $nssmPath install $serviceName "$installDir\\lockdown-agent.exe" --config "$installDir\\config.json"
    & $nssmPath set $serviceName DisplayName "Remote Lockdown Agent"
    & $nssmPath set $serviceName Description "Anti-theft agent for ${hostname}"
    & $nssmPath set $serviceName Start SERVICE_AUTO_START
    & $nssmPath set $serviceName AppStdout "$installDir\\agent.log"
    & $nssmPath set $serviceName AppStderr "$installDir\\agent.log"

    # Install watchdog service
    & $nssmPath install $watchdogServiceName "$installDir\\lockdown-watchdog.exe"
    & $nssmPath set $watchdogServiceName DisplayName "Remote Lockdown Watchdog"
    & $nssmPath set $watchdogServiceName Description "Monitors and restarts the Lockdown Agent"
    & $nssmPath set $watchdogServiceName Start SERVICE_AUTO_START
    & $nssmPath set $watchdogServiceName AppStdout "$installDir\\watchdog.log"
    & $nssmPath set $watchdogServiceName AppStderr "$installDir\\watchdog.log"

    # Start services
    & $nssmPath start $serviceName
    & $nssmPath start $watchdogServiceName

    Write-Host "Services installed and started." -ForegroundColor Green
} else {
    Write-Host "NSSM not found. Starting agent directly..." -ForegroundColor Yellow
    Write-Host "For production, install NSSM to run as a service." -ForegroundColor Yellow
    Start-Process "$installDir\\lockdown-agent.exe" -ArgumentList "--config", "$installDir\\config.json" -WorkingDirectory $installDir
    Write-Host "Agent started in background."
}

# --- Phase 7: Register uninstaller in Add/Remove Programs ---
$uninstallerPath = "$installDir\\uninstall.ps1"
# Create uninstaller script
$uninstallerScript = @"
#Requires -RunAsAdministrator
Write-Host "Uninstalling Remote Lockdown Agent..." -ForegroundColor Yellow
# Stop and remove services
& nssm stop $serviceName 2>\`$null
& nssm remove $serviceName confirm 2>\`$null
& nssm stop $watchdogServiceName 2>\`$null
& nssm remove $watchdogServiceName confirm 2>\`$null
# Remove install directory
Remove-Item "$installDir" -Recurse -Force -ErrorAction SilentlyContinue
# Remove registry entry
Remove-Item "HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\LockdownAgent" -ErrorAction SilentlyContinue
Write-Host "Uninstallation complete." -ForegroundColor Green
"@
Set-Content -Path $uninstallerPath -Value $uninstallerScript -Encoding UTF8

# Register in Add/Remove Programs
$regKey = "HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\LockdownAgent"
New-Item -Path $regKey -Force | Out-Null
Set-ItemProperty -Path $regKey -Name "DisplayName" -Value "Remote Lockdown Agent"
Set-ItemProperty -Path $regKey -Name "DisplayVersion" -Value "1.0.0"
Set-ItemProperty -Path $regKey -Name "Publisher" -Value "Remote Lockdown"
Set-ItemProperty -Path $regKey -Name "InstallLocation" -Value $installDir
Set-ItemProperty -Path $regKey -Name "UninstallString" -Value "powershell -ExecutionPolicy Bypass -File \`"$uninstallerPath\`""
Set-ItemProperty -Path $regKey -Name "DisplayIcon" -Value "$installDir\\lockdown-agent.exe"
Set-ItemProperty -Path $regKey -Name "NoModify" -Value 1 -Type DWord
Set-ItemProperty -Path $regKey -Name "NoRepair" -Value 1 -Type DWord
Write-Host "Uninstaller registered in Add/Remove Programs." -ForegroundColor Green

Write-Host ""
Write-Host "Installation complete!" -ForegroundColor Green
Write-Host "The agent will check in with the server at: ${config.server_url}"
Write-Host "Verify checkin in the admin dashboard."
Write-Host ""
Write-Host "To uninstall: Use Add/Remove Programs or run: $uninstallerPath"
`;
}

/**
 * Generate the Linux/macOS install script.
 * Installs the agent + watchdog as a systemd service.
 * Phase 7: Shows EULA + tracking disclosure before installation.
 */
function generateInstallSh(config, hostname) {
  const serviceName = 'lockdown-agent';
  const watchdogServiceName = 'lockdown-watchdog';
  const installDir = '/opt/lockdown-agent';
  const configDir = '/etc/lockdown-agent';

  return `#!/bin/bash
# Install script for Remote Lockdown Agent
# Device: ${hostname}
# Generated: ${new Date().toISOString()}
#
# Run as root: sudo ./install.sh

set -e

SERVICE_NAME="${serviceName}"
WATCHDOG_SERVICE_NAME="${watchdogServiceName}"
INSTALL_DIR="${installDir}"
CONFIG_DIR="${configDir}"

echo "=== Remote Lockdown Agent Installer ==="
echo "Device: ${hostname}"
echo ""
echo "IMPORTANT — PLEASE READ CAREFULLY"
echo ""
echo "This software is an anti-theft device protection agent."
echo "By installing this software, you acknowledge that:"
echo ""
echo "  1. You own or are authorized to manage this device"
echo "  2. This agent will periodically check in with the admin server"
echo "  3. If this device is reported stolen, the agent will:"
echo "     - Encrypt the locked folder to prevent unauthorized access"
echo "     - Lock the boot loader (BIOS/UEFI) on supported hardware"
echo "     - Collect location data (IP-based and/or GPS/WiFi if available)"
echo "  4. Location data is only collected when the device is flagged as stolen"
echo "  5. Location data is retained for 90 days (configurable) then auto-deleted"
echo "  6. The agent does NOT monitor: browsing, files, keystrokes, audio, video"
echo ""
echo "See EULA.txt and PRIVACY_POLICY.txt for full terms."
echo ""

# Check if running interactively
if [ -t 0 ]; then
    read -p "Do you accept the EULA and acknowledge the tracking capabilities? (yes/no) " response
    if [ "$response" != "yes" ] && [ "$response" != "Yes" ]; then
        echo "EULA not accepted. Installation cancelled."
        exit 1
    fi
else
    # Non-interactive: accept by default (e.g., automated deployment)
    echo "Non-interactive mode — EULA accepted by default."
    echo "Ensure you have read and accepted the EULA before running this script."
fi

echo "EULA accepted. Proceeding with installation..."
echo ""

# Check root
if [ "$(id -u)" -ne 0 ]; then
    echo "Error: This script must be run as root (use sudo)"
    exit 1
fi

# Create directories
mkdir -p "$INSTALL_DIR"
mkdir -p "$CONFIG_DIR"
chmod 700 "$CONFIG_DIR"

# Copy binaries
cp lockdown-agent "$INSTALL_DIR/lockdown-agent"
cp lockdown-watchdog "$INSTALL_DIR/lockdown-watchdog"
chmod +x "$INSTALL_DIR/lockdown-agent"
chmod +x "$INSTALL_DIR/lockdown-watchdog"
echo "Binaries copied to $INSTALL_DIR"

# Copy config
cp config.json "$CONFIG_DIR/agent-config.json"
chmod 600 "$CONFIG_DIR/agent-config.json"
chown root:root "$CONFIG_DIR/agent-config.json"
echo "Config copied to $CONFIG_DIR/agent-config.json"

# Create systemd service for agent
cat > "/etc/systemd/system/$SERVICE_NAME.service" << EOF
[Unit]
Description=Remote Lockdown Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=$INSTALL_DIR/lockdown-agent --config $CONFIG_DIR/agent-config.json
Restart=always
RestartSec=30
User=root

[Install]
WantedBy=multi-user.target
EOF

# Create systemd service for watchdog
cat > "/etc/systemd/system/$WATCHDOG_SERVICE_NAME.service" << EOF
[Unit]
Description=Remote Lockdown Watchdog
After=$SERVICE_NAME.service
Requires=$SERVICE_NAME.service

[Service]
Type=simple
ExecStart=$INSTALL_DIR/lockdown-watchdog
Restart=always
RestartSec=60
User=root

[Install]
WantedBy=multi-user.target
EOF

# Enable and start services
systemctl daemon-reload
systemctl enable $SERVICE_NAME $WATCHDOG_SERVICE_NAME
systemctl start $SERVICE_NAME
systemctl start $WATCHDOG_SERVICE_NAME

echo "Services installed and started."
echo ""
echo "Installation complete!"
echo "The agent will check in with the server at: ${config.server_url}"
echo "Verify checkin in the admin dashboard."
echo ""
echo "Manage the service:"
echo "  systemctl status $SERVICE_NAME"
echo "  journalctl -u $SERVICE_NAME -f"
`;
}

/**
 * Generate a README.txt with quick start instructions.
 */
function generateReadme(hostname, platform) {
  const isWin = platform === 'win';
  return `Remote Lockdown Agent — Installation Package
================================================
Device: ${hostname}
Generated: ${new Date().toISOString()}
Platform: ${isWin ? 'Windows' : 'Linux/macOS'}

Contents:
  ${isWin ? 'lockdown-agent.exe' : 'lockdown-agent'}      — The main agent binary
  ${isWin ? 'lockdown-watchdog.exe' : 'lockdown-watchdog'}   — Process monitor (restarts agent if it crashes)
  config.json              — Device-specific configuration (server URL, API key)
  ${isWin ? 'install.ps1' : 'install.sh'}              — Installation script
  README.txt               — This file

Quick Start:
${isWin ? `
  1. Right-click install.ps1 → "Run with PowerShell"
     (or: powershell -ExecutionPolicy Bypass -File install.ps1)
  2. Approve the UAC prompt (administrator required)
  3. The agent installs as a Windows service and starts automatically
` : `
  1. Open a terminal in this directory
  2. Run: sudo ./install.sh
  3. The agent installs as a systemd service and starts automatically
`}

Verification:
  After installation, check the admin dashboard — the device should
  show a recent "last checkin" time within 30 seconds.

Uninstall:
${isWin ? `
  sc stop LockdownAgent
  sc stop LockdownWatchdog
  sc delete LockdownAgent
  sc delete LockdownWatchdog
  rmdir /s /q "C:\\Program Files\\LockdownAgent"
` : `
  sudo systemctl stop lockdown-agent lockdown-watchdog
  sudo systemctl disable lockdown-agent lockdown-watchdog
  sudo rm /etc/systemd/system/lockdown-agent.service
  sudo rm /etc/systemd/system/lockdown-watchdog.service
  sudo rm -rf /opt/lockdown-agent /etc/lockdown-agent
  sudo systemctl daemon-reload
`}

Support:
  This agent is part of the Remote Lockdown System.
  The agent is visible in ${isWin ? 'Add/Remove Programs' : 'systemctl list-units'}.
  It does NOT hide itself — this is intentional for ethical transparency.
`;
}

/**
 * Phase 7: Generate a short EULA for the installer package.
 * The full Terms of Service are in docs/TERMS_OF_SERVICE.md.
 */
function generateEula(hostname) {
  return `Remote Lockdown Agent — End User License Agreement
=========================================================
Device: ${hostname}
Date: ${new Date().toISOString()}

IMPORTANT — READ CAREFULLY

By installing this software, you agree to the following terms:

1. AUTHORIZATION
   You represent and warrant that you own or are authorized to manage
   this device. Installing monitoring software on a device without the
   owner's consent may be illegal in your jurisdiction.

2. TRACKING CAPABILITIES
   This agent includes anti-theft tracking capabilities. When this device
   is reported stolen via the admin dashboard, the agent will:
   - Encrypt the locked folder to prevent unauthorized access
   - Lock the boot loader (BIOS/UEFI) on supported hardware
   - Collect location data (IP-based and/or GPS/WiFi if available)

   Location data is ONLY collected when the device is flagged as stolen.
   The agent does NOT monitor: browsing history, files, keystrokes,
   audio, video, emails, or application usage.

3. DATA RETENTION
   Location data is retained for 90 days (configurable) and then
   automatically deleted. Audit logs are retained for 365 days.
   Device records are retained until the device is released from
   the admin account.

4. TRANSPARENCY
   This agent is visible in the system's program list (Add/Remove
   Programs on Windows, systemctl on Linux). It does NOT hide itself,
   run in stealth mode, or attempt to evade detection. This is
   intentional for ethical transparency.

5. CONSENT
   For corporate/institutional devices, ensure employees are notified
   per applicable labor laws (GDPR Art. 88 in the EU). For personal
   devices, your installation constitutes consent.

6. DISCLAIMER
   This software is provided "AS IS" without warranty. The provider
   is not liable for data loss, device damage, or failure to recover
   a stolen device. Boot-level protection is only available on
   supported hardware.

7. GOVERNING LAW
   This EULA is governed by the laws of your jurisdiction. You are
   responsible for complying with all applicable privacy, surveillance,
   and monitoring laws.

For the full Terms of Service, see:
https://github.com/unccllin/remote-lockdown-system/blob/main/docs/TERMS_OF_SERVICE.md

To object to this agreement, do not install the software. If already
installed, use the uninstall script or Add/Remove Programs to remove it.
`;
}

/**
 * Phase 7: Generate a short privacy summary for the installer package.
 * The full Privacy Policy is in docs/PRIVACY_POLICY.md.
 */
function generatePrivacySummary() {
  return `Remote Lockdown Agent — Privacy Summary
==========================================

WHAT DATA IS COLLECTED?

  When enrolled (always):
  - Device hostname, owner name, MAC address, hardware UUID
  - Check-in timestamps (when the device last contacted the server)

  When flagged as stolen (only):
  - GPS coordinates (if available)
  - IP-based geolocation (approximate location)
  - Wi-Fi access points (for WiFi-based positioning)
  - City/region/country (derived from location)

WHAT DATA IS NOT COLLECTED?

  The agent does NOT collect:
  - Browsing history or web activity
  - File contents, photos, or documents
  - Keystrokes or mouse input
  - Audio or video recordings
  - Email, chat, or social media activity
  - Application usage data

HOW LONG IS DATA RETAINED?

  - Location reports: 90 days (configurable: 7-180 days), then auto-deleted
  - Audit logs: 365 days
  - Device records: Until device is released from account
  - Encryption keys: Until device is recovered and unlocked

YOUR RIGHTS

  - Access: Request a copy of your data
  - Deletion: Request deletion of your data
  - Objection: Object to data processing
  - Portability: Receive your data in machine-readable format
  - Withdrawal: Remove the agent at any time (Add/Remove Programs or
    systemctl)

  To exercise these rights, contact: research@remotelockdown.com

DATA SECURITY

  - All sensitive data (encryption keys, BIOS passwords, location data)
    is encrypted with AES-256-GCM
  - All communication uses HTTPS/TLS
  - Per-device API keys prevent cross-device access

For the full Privacy Policy, see:
https://github.com/unccllin/remote-lockdown-system/blob/main/docs/PRIVACY_POLICY.md

For the GDPR Legitimate Interest Assessment, see:
https://github.com/unccllin/remote-lockdown-system/blob/main/docs/GDPR_LIA.md
`;
}

// ---------------------------------------------------------------------------
// Minimal ZIP builder (no external dependencies)
// ---------------------------------------------------------------------------

/**
 * Build a ZIP file in-memory from a list of files.
 * Uses deflate compression via Node's zlib module.
 *
 * @param {Array<{name: string, data: Buffer}>} files
 * @returns {Buffer} ZIP file content
 */
function buildZip(files) {
  const localHeaders = [];
  const centralHeaders = [];
  const dataParts = [];

  for (const file of files) {
    const nameBuf = Buffer.from(file.name, 'utf8');
    const isDirectory = file.name.endsWith('/');

    let compressedData;
    let compressionMethod;
    let crc = crc32(file.data);

    if (isDirectory || file.data.length === 0) {
      compressedData = Buffer.alloc(0);
      compressionMethod = 0; // Store (no compression)
    } else {
      compressedData = zlib.deflateRawSync(file.data);
      // Only use compression if it actually reduces size
      if (compressedData.length >= file.data.length) {
        compressedData = file.data;
        compressionMethod = 0; // Store
      } else {
        compressionMethod = 8; // Deflate
      }
    }

    const uncompressedSize = file.data.length;
    const compressedSize = compressedData.length;

    // Local file header (30 bytes + filename)
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);       // Local file header signature
    localHeader.writeUInt16LE(20, 4);                 // Version needed to extract (2.0)
    localHeader.writeUInt16LE(0x0800, 6);             // General purpose bit flag (UTF-8 filename)
    localHeader.writeUInt16LE(compressionMethod, 8);  // Compression method
    localHeader.writeUInt16LE(0, 10);                 // Last mod file time
    localHeader.writeUInt16LE(0, 12);                 // Last mod file date
    localHeader.writeUInt32LE(crc, 14);               // CRC-32
    localHeader.writeUInt32LE(compressedSize, 18);    // Compressed size
    localHeader.writeUInt32LE(uncompressedSize, 22);  // Uncompressed size
    localHeader.writeUInt16LE(nameBuf.length, 26);    // Filename length
    localHeader.writeUInt16LE(0, 28);                 // Extra field length

    const localHeaderOffset = dataParts.reduce((sum, buf) => sum + buf.length, 0);

    localHeaders.push(localHeader);
    dataParts.push(Buffer.concat([localHeader, nameBuf, compressedData]));

    // Central directory file header (46 bytes + filename)
    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);       // Central file header signature
    centralHeader.writeUInt16LE(20, 4);                 // Version made by
    centralHeader.writeUInt16LE(20, 6);                 // Version needed to extract
    centralHeader.writeUInt16LE(0x0800, 8);             // General purpose bit flag (UTF-8)
    centralHeader.writeUInt16LE(compressionMethod, 10); // Compression method
    centralHeader.writeUInt16LE(0, 12);                 // Last mod file time
    centralHeader.writeUInt16LE(0, 14);                 // Last mod file date
    centralHeader.writeUInt32LE(crc, 16);               // CRC-32
    centralHeader.writeUInt32LE(compressedSize, 20);    // Compressed size
    centralHeader.writeUInt32LE(uncompressedSize, 24);  // Uncompressed size
    centralHeader.writeUInt16LE(nameBuf.length, 28);    // Filename length
    centralHeader.writeUInt16LE(0, 30);                 // Extra field length
    centralHeader.writeUInt16LE(0, 32);                 // File comment length
    centralHeader.writeUInt16LE(0, 34);                 // Disk number start
    centralHeader.writeUInt16LE(0, 36);                 // Internal file attributes
    centralHeader.writeUInt32LE(isDirectory ? 0x10 : 0, 38); // External file attributes
    centralHeader.writeUInt32LE(localHeaderOffset, 42); // Relative offset of local header

    centralHeaders.push(Buffer.concat([centralHeader, nameBuf]));
  }

  const centralDirOffset = dataParts.reduce((sum, buf) => sum + buf.length, 0);
  const centralDirData = Buffer.concat(centralHeaders);
  const centralDirSize = centralDirData.length;

  // End of central directory record (22 bytes)
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);       // End of central dir signature
  eocd.writeUInt16LE(0, 4);                 // Number of this disk
  eocd.writeUInt16LE(0, 6);                 // Disk where central dir starts
  eocd.writeUInt16LE(files.length, 8);      // Entries in central dir on this disk
  eocd.writeUInt16LE(files.length, 10);     // Total entries in central dir
  eocd.writeUInt32LE(centralDirSize, 12);   // Size of central directory
  eocd.writeUInt32LE(centralDirOffset, 16); // Offset of central directory
  eocd.writeUInt16LE(0, 20);                // Comment length

  return Buffer.concat([...dataParts, centralDirData, eocd]);
}

/**
 * CRC-32 lookup table (IEEE polynomial 0xEDB88320).
 */
const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let crc = i;
    for (let j = 0; j < 8; j++) {
      crc = (crc & 1) ? (0xEDB88320 ^ (crc >>> 1)) : (crc >>> 1);
    }
    table[i] = crc >>> 0;
  }
  return table;
})();

/**
 * Compute CRC-32 of a buffer.
 */
function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc = (crcTable[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * GET /api/installer/:deviceId?platform=win|linux
 *
 * Generates a ZIP containing the agent binary, config, and install script
 * for the specified device. The admin downloads this and gives it to the
 * device user.
 *
 * Auth: requires admin JWT (requireAuth middleware).
 */
router.get('/:deviceId', requireAuth, async (req, res) => {
  const { deviceId } = req.params;
  const platform = req.query.platform === 'linux' ? 'linux' : 'win';

  // Look up the device
  const devResult = await pool.query('SELECT * FROM devices WHERE id = $1', [deviceId]);
  const device = devResult.rows[0];
  if (!device) {
    return res.status(404).json({ error: 'Device not found' });
  }

  // Resolve agent binaries (local → cache → GitHub Releases download)
  const plat = getPlatformConfig(platform);

  // Determine the base names (without extension) for GitHub Releases lookup
  const agentBaseName = 'lockdown-agent';
  const watchdogBaseName = 'lockdown-watchdog';

  // Resolve the agent binary
  const agentBinPath = await resolveAgentBinary(platform, plat.agentName, agentBaseName);
  if (!agentBinPath) {
    return res.status(503).json({
      error: `Agent binary not found for platform "${platform}". ` +
        `Tried: local bundle, cache, and GitHub Releases download. ` +
        `Ensure agent binaries are built and published to GitHub Releases.`,
    });
  }

  // Resolve the watchdog binary (non-fatal if missing)
  const watchdogBinPath = await resolveAgentBinary(platform, plat.watchdogName, watchdogBaseName);

  // Build the device-specific config
  // Note: We can't return the plaintext API key here (it's not stored).
  // The admin must use the key from the enrollment step, or rotate the key.
  // For the installer, we generate a new key and store its hash.
  const { generateApiKey } = require('../db/apiKey');
  const apiKey = generateApiKey();
  const apiKeyHash = hashApiKey(apiKey);

  await pool.query('UPDATE devices SET api_key_hash = $1 WHERE id = $2', [apiKeyHash, device.id]);
  await pool.query(
    'INSERT INTO audit_log (device_id, admin_id, action, detail) VALUES ($1, $2, $3, $4)',
    [device.id, req.admin.id, 'installer_generated', { platform }]
  );

  // Determine server URL — use the request origin (what the admin browser sees)
  const protocol = req.protocol;
  const host = req.get('host');
  const serverUrl = `${protocol}://${host}`;

  const config = {
    server_url: serverUrl,
    device_hostname: device.hostname,
    api_key: apiKey,
    poll_interval: 30,
    sign_requests: true,
    server_supports_ack_dedup: true,
    boot_lock_enabled: true,
    enrolled_at: new Date().toISOString(),
  };

  // Build the files for the ZIP
  const files = [];

  // Agent binary
  files.push({
    name: plat.agentName,
    data: fs.readFileSync(agentBinPath),
  });

  // Watchdog binary (if it exists)
  if (watchdogBinPath && fs.existsSync(watchdogBinPath)) {
    files.push({
      name: plat.watchdogName,
      data: fs.readFileSync(watchdogBinPath),
    });
  }

  // Config JSON
  files.push({
    name: 'config.json',
    data: Buffer.from(JSON.stringify(config, null, 2), 'utf8'),
  });

  // Install script
  if (platform === 'win') {
    files.push({
      name: 'install.ps1',
      data: Buffer.from(generateInstallPs1(config, device.hostname), 'utf8'),
    });
  } else {
    files.push({
      name: 'install.sh',
      data: Buffer.from(generateInstallSh(config, device.hostname), 'utf8'),
    });
  }

  // README
  files.push({
    name: 'README.txt',
    data: Buffer.from(generateReadme(device.hostname, platform), 'utf8'),
  });

  // Phase 7: EULA + Privacy Policy (short versions for the installer package)
  files.push({
    name: 'EULA.txt',
    data: Buffer.from(generateEula(device.hostname), 'utf8'),
  });
  files.push({
    name: 'PRIVACY_POLICY.txt',
    data: Buffer.from(generatePrivacySummary(), 'utf8'),
  });

  // Build ZIP
  const zip = buildZip(files);

  // Set response headers
  const filename = `lockdown-agent-${device.hostname.toLowerCase().replace(/[^a-z0-9]/g, '-')}-${platform}.zip`;
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Length', zip.length);

  res.send(zip);
});

/**
 * GET /api/installer/agent-version
 *
 * Returns the current version of the bundled agent binary.
 * Used by the auto-update check.
 */
router.get('/agent-version', requireAuth, async (req, res) => {
  const plat = getPlatformConfig(req.query.platform);
  const agentBinPath = await resolveAgentBinary(plat.platform, plat.agentName, 'lockdown-agent');

  if (!agentBinPath) {
    return res.json({ version: null, available: false });
  }

  const stat = fs.statSync(agentBinPath);
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(agentBinPath));
  const sha256 = hash.digest('hex');

  res.json({
    version: '1.0.0',
    sha256,
    size: stat.size,
    built_at: stat.mtime.toISOString(),
    platform: plat.platform,
    source: agentBinPath.includes('agent-cache') ? 'cache' : 'local',
  });
});

module.exports = router;
