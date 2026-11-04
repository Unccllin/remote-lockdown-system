/**
 * Public binary/script downloads — `GET /api/download/<name>`.
 *
 * Why this exists
 * ---------------
 * The Worker has always served `/api/download/{installer,agent,lockscreen,
 * agent-installer}` (and a few generated scripts) from KV, and `deploy-agent.sh`
 * in this repo fetches exactly those URLs. The Express server served binaries only
 * through `/api/installer/:deviceId` (a per-device ZIP or NSIS build), so the same
 * URL that works on a Worker deployment answered 404 on a self-hosted one — which
 * is how it was reported (S210): a plain `GET /api/download/installer` returning
 * the generic API 404.
 *
 * These routes are unauthenticated on purpose, matching the Worker: they are the
 * bootstrap path for a machine that has no credential yet. They expose only
 * binaries that are already distributed to every target device, so the blast
 * radius of a public download is "you can fetch the agent", not "you can act".
 *
 * Every response carries `x-content-sha256` — the digest of exactly the bytes
 * served, computed per response — so a client can refuse a truncated or substituted
 * body before executing it (the same contract the Worker's download route uses).
 *
 * A missing artefact answers 404 with the filename and where it must come from,
 * rather than a generic "Not found": that message is the operator's only clue on a
 * host that was never given the Windows build outputs.
 */

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { getAgentBinariesDir } = require('../config/paths');

const router = express.Router();

/**
 * name -> candidate filenames, in order. `agent` is platform-aware because a single
 * build directory holds both (the Worker serves one KV key instead).
 */
const BINARIES = {
  agent: { candidates: { win: ['lockdown-agent.exe'], linux: ['lockdown-agent'] }, fallback: ['lockdown-agent', 'lockdown-agent.exe'] },
  'agent-installer': { candidates: {}, fallback: ['lockdown-installer.exe'] },
  installer: { candidates: {}, fallback: ['lockdown-setup.exe'] },
  lockscreen: { candidates: {}, fallback: ['lockdown-lockscreen.exe'] },
};

function resolveBinary(spec, platform) {
  const dir = getAgentBinariesDir();
  if (!dir) return { path: null, dir: null };
  const names = [...(spec.candidates[platform] || []), ...spec.fallback];
  for (const name of names) {
    const candidate = path.join(dir, name);
    if (fs.existsSync(candidate)) return { path: candidate, dir };
  }
  return { path: null, dir, expected: names };
}

function sendBinary(res, filePath) {
  const bytes = fs.readFileSync(filePath);
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  const filename = path.basename(filePath);

  res.set('Content-Type', 'application/octet-stream');
  res.set('Content-Disposition', `attachment; filename="${filename}"`);
  res.set('Content-Length', String(bytes.length));
  // Digest of exactly these bytes, so a client can refuse a bad body before running it.
  res.set('x-content-sha256', digest);
  res.set('Cache-Control', 'no-store');
  return res.send(bytes);
}

router.get('/:name', (req, res) => {
  const name = req.params.name;
  const spec = BINARIES[name];
  if (!spec) {
    return res.status(404).json({
      error:
        `No download named "${name}". Available: ${Object.keys(BINARIES).join(', ')}. ` +
        '(Generated .ps1 helpers are served by the serverless backend only.)',
    });
  }

  const platform = String(req.query.platform || '').toLowerCase();
  const { path: filePath, dir, expected } = resolveBinary(spec, platform);

  if (!filePath) {
    return res.status(404).json({
      error:
        `${expected[0] || name} is not staged on this server` +
        (dir ? ` (looked in ${dir})` : ' (no agent binaries directory found)') +
        '. Build it on Windows (agent/build.ps1) and place it there, or set AGENT_BINARIES_DIR.',
    });
  }

  return sendBinary(res, filePath);
});

module.exports = router;
