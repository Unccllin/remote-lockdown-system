/**
 * Central path resolution for agent binaries.
 *
 * Single source of truth for finding the directory containing pre-built
 * agent binaries (lockdown-agent, lockdown-watchdog, lockdown-recovery).
 * Used by routes/installer.js and routes/agent.js.
 *
 * Lookup order:
 *   0. AGENT_BINARIES_DIR, when set — deployments that keep binaries outside the
 *      repo tree, and harnesses that must not depend on a build existing locally
 *      (`agent/dist/` is gitignored, so a fresh checkout has none and the update
 *      endpoint silently answers `no_binary_available`).
 *   1. Electron production: process.resourcesPath/agent/
 *   2. Dev mode: <repo-root>/agent/dist/
 *
 * The dev path is relative to this file:
 *   server/src/config/paths.js → ../../../agent/dist (3 ups to repo root)
 *
 * Previously this logic was duplicated in 3 call sites across 2 files,
 * one of which had an off-by-one path bug (4 ups instead of 3 from
 * server/src/routes/). Centralizing it here prevents that class of bug
 * from recurring.
 */

const path = require('path');
const fs = require('fs');

/**
 * Find the directory containing the pre-built agent binaries.
 * @returns {string|null} Absolute path to the agent binaries dir, or null if not found.
 */
function getAgentBinariesDir() {
  const candidates = [];

  // Explicit override. Checked first because an operator who sets it means it;
  // falling back to a stale in-repo build would serve the wrong binaries.
  const override = process.env.AGENT_BINARIES_DIR;
  if (override) {
    candidates.push(override);
  }

  // Electron production: binaries are in extraResources at resourcesPath/agent/
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'agent'));
  }

  // Dev mode: agent/dist relative to repo root.
  // This file is at server/src/config/paths.js → 2 ups to repo root.
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
 * Resolve a specific agent binary by name.
 * @param {string} binName - e.g. 'lockdown-agent', 'lockdown-agent.exe'
 * @returns {string|null} Absolute path to the binary, or null if not found.
 */
function resolveAgentBinary(binName) {
  const dir = getAgentBinariesDir();
  if (!dir) return null;
  const fullPath = path.join(dir, binName);
  return fs.existsSync(fullPath) ? fullPath : null;
}

module.exports = { getAgentBinariesDir, resolveAgentBinary };
