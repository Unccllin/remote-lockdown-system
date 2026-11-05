/**
 * Token-based device enrolment — POST /api/enroll/token + POST /api/enroll/claim.
 *
 * Why this exists
 * ---------------
 * The streamlined enrolment flow is: an admin mints a short-lived token in the
 * dashboard, then the installer runs on the target with `--token <token>` and
 * claims it. Both halves already existed in the Worker
 * (`handleEnrollToken` / `handleEnrollClaim`), and the dashboard's Enroll page
 * (`api.post('/enroll/token')`) plus `agent/installer.py --token` (which posts to
 * `/api/enroll/claim`) were written against them — but the Express server
 * implemented neither endpoint, so token enrolment 404'd on self-hosted
 * deployments (S204).
 *
 * This module implements the same contract here:
 *
 *   POST /api/enroll/token   (operator auth)
 *     → { token, expires_at, expires_in }        token shown ONCE, 15 minutes
 *
 *   POST /api/enroll/claim   (no admin auth — the token IS the credential)
 *     body: { token, hostname, owner_name?, hardware_uuid?, mac_address?, serial_number? }
 *     → 200 { device, api_key, reassociated: true }   existing hardware, new key
 *     → 201 { device, api_key }                       new device
 *     → 401 invalid / already used / expired token
 *
 * Only the SHA-256 of the token is stored. `used_at` is the single-use marker and
 * the claim updates it conditionally, so two concurrent claims cannot both win.
 */

const express = require('express');
const crypto = require('crypto');
const pool = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');
const { generateApiKey, hashApiKey } = require('../db/apiKey');
const installer = require('./installer');

const router = express.Router();

const TOKEN_TTL_SECONDS = 15 * 60;

/** The stored form of a token: SHA-256 hex, so a DB read cannot be replayed. */
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/** Device rows carry the key hash; API responses never do. */
function publicDevice(row) {
  const { api_key_hash: _api_key_hash, ...rest } = row;
  return rest;
}

/**
 * POST /api/enroll/token — mint a single-use enrolment token.
 * Auth: operator or above (the same gate as creating a device by hand).
 */
router.post('/token', requireAuth, requireRole('operator'), async (req, res, next) => {
  try {
    const token = generateApiKey(); // 32 random bytes, base64 — high entropy
    const now = new Date();
    const expiresAt = new Date(now.getTime() + TOKEN_TTL_SECONDS * 1000);

    await pool.query(
      `INSERT INTO enrollment_tokens (id, token_hash, created_by, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        crypto.randomUUID(),
        hashToken(token),
        req.admin?.id || null,
        now.toISOString(),
        expiresAt.toISOString(),
      ]
    );

    res.json({
      token, // plaintext, returned once — only the hash is stored
      expires_at: expiresAt.toISOString(),
      expires_in: TOKEN_TTL_SECONDS,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/enroll/setup-command — the command an operator pastes on the target.
 *
 * Composed here, not in the browser, for two reasons that have both already caused
 * failures: the URL must be the one *targets* can reach (`publicServerUrl`, not the
 * admin's `window.location.origin`), and an operator copy-pasting a tailnet hostname
 * from a chat window mistyped it into `desktop-q4pcdhk.ta?06a7e9` (S214).
 *
 * The returned script also verifies reachability before downloading, so a machine
 * without the tailnet up fails with a sentence instead of a resolver error.
 *
 * When INSTALLER_SILENT=true the wizard is assumed to be a build that supports
 * `--silent` (S214) and the command installs without the GUI; otherwise it launches
 * the wizard with the server URL already on the clipboard.
 */
router.get('/setup-command', requireAuth, requireRole('operator'), (req, res) => {
  const serverUrl = installer.helpers.publicServerUrl(req);

  // PUBLIC_SERVER_URL is operator-supplied, and `new URL()` throws on anything that
  // is not an absolute URL (a missing scheme is the common mistake). Say which value
  // is wrong instead of returning a bare 500.
  let parsed;
  try {
    parsed = new URL(serverUrl);
  } catch {
    return res.status(500).json({
      error:
        `PUBLIC_SERVER_URL is not a valid absolute URL: ${JSON.stringify(serverUrl)}. ` +
        'Use scheme://host[:port], e.g. https://lockdown.example.com',
    });
  }
  const host = parsed.hostname;
  const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');

  // The remedy has to match the address: a bare IP has no name to resolve, and
  // nothing here implies a VPN.
  const isIpLiteral = /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
  const remedy = isIpLiteral
    ? `Check this machine is on the same network as ${host}, and that the server is running.`
    : `Check the VPN is connected, then try: Resolve-DnsName ${host}`;
  const silent = (process.env.INSTALLER_SILENT || '').toLowerCase() === 'true';

  const lines = [
    `# Paste into PowerShell on the target machine (it elevates itself).`,
    `$u = '${serverUrl}'`,
    `if (-not (Test-NetConnection '${host}' -Port ${port}).TcpTestSucceeded) {`,
    `    throw "Cannot reach $u on port ${port}. ${remedy}"`,
    `}`,
    `$e = Join-Path $env:TEMP 'lockdown-setup.exe'`,
    `Invoke-WebRequest "$u/api/download/installer" -OutFile $e`,
  ];

  if (silent) {
    lines.push(
      `$t = Read-Host 'Enrollment token (from this page)'`,
      `$p = Start-Process $e -Verb RunAs -Wait -PassThru -ArgumentList @('--server-url', $u, '--token', $t, '--silent')`,
      `"exit code: $($p.ExitCode)"`
    );
  } else {
    lines.push(
      `Set-Clipboard $u`,
      `Start-Process $e -Verb RunAs`,
      `Write-Host 'Server URL is on the clipboard — paste it into the wizard, then paste the token.' -ForegroundColor Green`
    );
  }

  // The dashboard shows `one_liner`; the longer `command` stays available for
  // operators who want to read what will run before running it.
  // `iex (irm '…')`, not `powershell -Command "irm … | iex"`. The nested form breaks
  // when pasted into an existing PowerShell prompt: the quotes are consumed by the
  // outer shell, the child's output arrives as separate lines (4 of them empty), and
  // Invoke-Expression rejects the array with "Cannot bind argument to parameter
  // 'Command' because it is an empty string" (S216). Parentheses hand it one string.
  const oneLiner = `iex (irm '${serverUrl}/api/enroll/setup.ps1')`;

  res.json({
    server_url: serverUrl,
    mode: silent ? 'silent' : 'gui',
    one_liner: oneLiner,
    ps1_url: `${serverUrl}/api/enroll/setup.ps1`,
    cmd_url: `${serverUrl}/api/enroll/setup.cmd`,
    command: lines.join('\n'),
    notes: silent
      ? [
          'Installs without the GUI and reports an exit code: 0 = installed, 1 = failed.',
          ...(serverUrl.toLowerCase().startsWith('http://')
            ? ['Plain HTTP server: the agent requires TLS, so verification is disabled (lab only).']
            : []),
        ]
      : [
          'The wizard opens elevated; its Server URL field is filled from the clipboard.',
          'The enrollment token is single use and expires in 15 minutes.',
        ],
  });
});

/**
 * POST /api/enroll/claim — redeem a token and provision the device.
 *
 * Unauthenticated by design: the token is the credential, which is why the mount
 * carries a strict rate limit (brute-forcing a 44-character token is infeasible,
 * but the limiter keeps the endpoint from being a free oracle).
 */
router.post('/claim', async (req, res, next) => {
  const { token, hostname, owner_name, hardware_uuid, mac_address, serial_number } =
    req.body || {};

  // Trim: a token copied out of the dashboard and pasted into a shell arrives with
  // whitespace far more often than not, and a hash of " abc" never matches.
  const normalizedToken = typeof token === 'string' ? token.trim() : '';
  if (normalizedToken.length === 0) {
    return res.status(400).json({ error: 'Enrollment token required' });
  }
  if (typeof hostname !== 'string' || hostname.trim().length === 0) {
    return res.status(400).json({ error: 'hostname required' });
  }

  try {
    const found = await pool.query(
      'SELECT * FROM enrollment_tokens WHERE token_hash = $1',
      [hashToken(normalizedToken)]
    );
    const record = found.rows[0];

    if (!record) {
      return res.status(401).json({ error: 'Invalid enrollment token' });
    }
    if (record.used_at) {
      // Distinct from "invalid": the token was real and has been spent. Tokens are
      // single-use, so a retry after a partial run needs a fresh one — telling the
      // operator that is the difference between a guess and a next step.
      return res.status(401).json({
        error: 'Enrollment token already used — generate a new one',
      });
    }
    // Expiry is compared in JS, not SQL: both dialects then treat the timestamp
    // the same way, whatever their native datetime formatting is.
    if (new Date(record.expires_at).getTime() <= Date.now()) {
      return res.status(401).json({ error: 'Enrollment token has expired' });
    }

    // Single use. The conditional UPDATE is the lock: a concurrent claim updates
    // zero rows and is rejected, so a token cannot provision two machines.
    const consumed = await pool.query(
      'UPDATE enrollment_tokens SET used_at = $1 WHERE id = $2 AND used_at IS NULL',
      [new Date().toISOString(), record.id]
    );
    if (consumed.rowCount !== 1) {
      // Lost the race: another claim consumed it between our read and this update.
      return res.status(401).json({
        error: 'Enrollment token already used — generate a new one',
      });
    }

    const apiKey = generateApiKey();
    const apiKeyHash = hashApiKey(apiKey);
    const ownerName = owner_name || 'Operator';

    // Re-association by hardware identity (MDM-style): the same physical machine
    // returning means re-issue credentials on the existing record, not a duplicate.
    if (hardware_uuid) {
      const existing = await pool.query('SELECT * FROM devices WHERE hardware_uuid = $1', [
        hardware_uuid,
      ]);
      if (existing.rows[0]) {
        const updated = await pool.query(
          `UPDATE devices
              SET api_key_hash = $1,
                  hostname     = $2,
                  mac_address  = COALESCE($3, mac_address),
                  serial_number = COALESCE($4, serial_number),
                  status       = 'active'
            WHERE id = $5
        RETURNING *`,
          [apiKeyHash, hostname, mac_address || null, serial_number || null, existing.rows[0].id]
        );

        await pool.query(
          'INSERT INTO audit_log (device_id, admin_id, action, detail) VALUES ($1, $2, $3, $4)',
          [
            existing.rows[0].id,
            record.created_by || null,
            'device_enrolled',
            { hostname, owner_name: ownerName, via: 'enrollment_token', reassociated: true },
          ]
        );

        return res.status(200).json({
          device: publicDevice(updated.rows[0]),
          api_key: apiKey, // plaintext — capture now, never shown again
          reassociated: true,
        });
      }
    }

    const created = await pool.query(
      `INSERT INTO devices (hostname, owner_name, api_key_hash, hardware_uuid, mac_address, serial_number)
       VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING *`,
      [
        hostname,
        ownerName,
        apiKeyHash,
        hardware_uuid || null,
        mac_address || null,
        serial_number || null,
      ]
    );

    await pool.query(
      'INSERT INTO audit_log (device_id, admin_id, action, detail) VALUES ($1, $2, $3, $4)',
      [
        created.rows[0].id,
        record.created_by || null,
        'device_enrolled',
        { hostname, owner_name: ownerName, via: 'enrollment_token' },
      ]
    );

    res.status(201).json({
      device: publicDevice(created.rows[0]),
      api_key: apiKey, // plaintext — capture now, never shown again
    });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({
        error:
          'Hostname or hardware identity already registered. Use the existing device or choose a different hostname.',
      });
    }
    next(err);
  }
});

/**
 * The install script the one-liner runs: `irm <server>/api/enroll/setup.ps1 | iex`.
 *
 * MeshCentral's ergonomics, without its secret-in-the-URL habit: the token is
 * prompted for on the target, so it never appears in a URL, an access log, shell
 * history or browser history. (This server logs query strings, so a `?token=` would
 * be written to disk on every install.)
 *
 * The script delegates: it downloads the signed-in-installer and either runs it with
 * `--silent` (when the server knows the build supports it) or launches the GUI. It
 * does not re-implement enrolment, config writing or service registration — those
 * live in installer.py/installer_gui.py, and a second copy here would drift.
 *
 * Unauthenticated on purpose: it carries no secret, and the target machine has no
 * credential yet. Reachability is checked first so a machine without the tailnet/VPN
 * fails with a sentence instead of a resolver error.
 */
function composeSetupScript(serverUrl, silent) {
  const parsed = new URL(serverUrl);
  const host = parsed.hostname;
  const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');

  // The remedy has to match the address: a bare IP has no name to resolve, and
  // nothing here implies a VPN.
  const isIpLiteral = /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
  const remedy = isIpLiteral
    ? `Check this machine is on the same network as ${host}, and that the server is running.`
    : `Check the VPN is connected, then try: Resolve-DnsName ${host}`;
  const lines = [
    `# Lockdown agent installer for ${serverUrl}`,
    `# Generated by the dashboard. Paste into an elevated PowerShell, or run setup.cmd.`,
    `$ErrorActionPreference = 'Stop'`,
    `$u = '${serverUrl}'`,
    ``,
    `Write-Host "Checking $u ..." -ForegroundColor Cyan`,
    `if (-not (Test-NetConnection '${host}' -Port ${port}).TcpTestSucceeded) {`,
    `    throw "Cannot reach $u on port ${port}. ${remedy}"`,
    `}`,
    ``,
    `$e = Join-Path $env:TEMP 'lockdown-setup.exe'`,
    `Write-Host "Downloading the installer ..." -ForegroundColor Cyan`,
    `Invoke-WebRequest "$u/api/download/installer" -OutFile $e`,
    `Unblock-File $e`,
    ``,
  ];

  if (silent) {
    // A plain-HTTP server means the agent needs its explicit dev override, otherwise
    // it exits with "SERVER_URL must use https://" (S216). The operator should not
    // have to know that, so the generated command carries it — and says so.
    const insecureFlag = serverUrl.toLowerCase().startsWith('http://')
      ? ", '--allow-insecure-http'"
      : '';
    if (insecureFlag) {
      lines.push(
        `Write-Host 'NOTE: this server is plain HTTP — TLS verification will be disabled (lab only).' -ForegroundColor Yellow`
      );
    }
    lines.push(
      `$t = Read-Host 'Enrollment token (from the dashboard)'`,
      `Write-Host "Installing (no GUI) ..." -ForegroundColor Cyan`,
      `$p = Start-Process $e -Verb RunAs -Wait -PassThru -ArgumentList @('--server-url', $u, '--token', $t, '--silent'${insecureFlag})`,
      `if ($p.ExitCode -ne 0) { throw "Installer failed with exit code $($p.ExitCode)" }`,
      `Write-Host 'Installed. The device appears in the dashboard within a minute.' -ForegroundColor Green`
    );
  } else {
    lines.push(
      `Write-Host "Opening the setup wizard ..." -ForegroundColor Cyan`,
      `Write-Host 'Paste the server URL (already on your clipboard) and your token.'`,
      `Set-Clipboard $u`,
      `Start-Process $e -Verb RunAs`
    );
  }

  return lines.join('\r\n') + '\r\n';
}

/** GET /api/enroll/setup.ps1 — the script behind the one-liner (no secret, so public). */
router.get('/setup.ps1', (req, res) => {
  const silent = (process.env.INSTALLER_SILENT || '').toLowerCase() === 'true';
  let script;
  try {
    script = composeSetupScript(installer.helpers.publicServerUrl(req), silent);
  } catch {
    return res.status(500).type('text/plain').send(
      'ERROR: PUBLIC_SERVER_URL is not a valid absolute URL (use scheme://host[:port]).\n'
    );
  }
  res.type('text/plain; charset=utf-8');
  res.set('Cache-Control', 'no-store');
  return res.send(script);
});

/**
 * GET /api/enroll/setup.cmd — the same thing as a double-clickable file.
 *
 * `-ExecutionPolicy Bypass` is scoped to this one invocation, not set machine-wide:
 * a script must not change the host's policy to run itself (the same rule the
 * Windows installer follows).
 */
router.get('/setup.cmd', (req, res) => {
  const serverUrl = installer.helpers.publicServerUrl(req);
  const body = [
    '@echo off',
    'setlocal',
    'REM Lockdown agent setup — generated by the dashboard.',
    `powershell -NoProfile -ExecutionPolicy Bypass -Command "$ProgressPreference='SilentlyContinue'; iex (irm '${serverUrl}/api/enroll/setup.ps1')"`,
    'if errorlevel 1 pause',
    'endlocal',
    '',
  ].join('\r\n');
  res.type('application/octet-stream');
  res.set('Content-Disposition', 'attachment; filename="lockdown-setup.cmd"');
  res.set('Cache-Control', 'no-store');
  return res.send(body);
});

module.exports = router;
