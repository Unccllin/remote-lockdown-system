/**
 * Tests for src/config/paths.js — the single source of truth for where agent
 * binaries live.
 *
 * The traversal case is the one that matters: resolveAgentBinary joined its
 * `binName` argument into the binaries directory unchecked until S251, so any
 * future caller that ever passed request-derived text would have been a file-read
 * primitive. The guard is pinned here so a refactor cannot quietly drop it.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { getAgentBinariesDir, resolveAgentBinary } = require('../src/config/paths');

let tmp;
let savedOverride;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'paths-test-'));
  savedOverride = process.env.AGENT_BINARIES_DIR;
  process.env.AGENT_BINARIES_DIR = tmp;
});

afterEach(() => {
  if (savedOverride === undefined) delete process.env.AGENT_BINARIES_DIR;
  else process.env.AGENT_BINARIES_DIR = savedOverride;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('getAgentBinariesDir', () => {
  test('prefers the AGENT_BINARIES_DIR override over any built directory', () => {
    // This host may well have agent/dist/ built; the override must still win,
    // because an operator who sets it means it (a stale in-repo build would
    // otherwise be served instead of their binaries).
    fs.writeFileSync(path.join(tmp, 'lockdown-agent'), Buffer.from('ELF'));
    expect(getAgentBinariesDir()).toBe(tmp);
  });

  test('falls back to the in-repo build when the override is not usable', () => {
    const dir = getAgentBinariesDir();
    // Either this checkout has a built agent/dist (binaries present) or nothing is
    // available at all — both are legitimate; what must not happen is serving the
    // empty override.
    expect(dir === null || dir !== tmp).toBe(true);
  });
});

describe('resolveAgentBinary', () => {
  test('resolves a staged binary by name', () => {
    const binary = path.join(tmp, 'lockdown-agent');
    fs.writeFileSync(binary, Buffer.from('ELF'));
    expect(resolveAgentBinary('lockdown-agent')).toBe(binary);
  });

  test('returns null for a name that is staged nowhere', () => {
    expect(resolveAgentBinary('definitely-not-an-agent-binary-xyz')).toBeNull();
  });

  test('a traversal payload cannot escape the binaries directory', () => {
    // A sibling file outside the binaries dir is the prize.
    const outside = path.join(path.dirname(tmp), 'secret-agents');
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'passwd'), Buffer.from('root:x:0:0'));
    try {
      expect(resolveAgentBinary('../secret-agents/passwd')).toBeNull();
      // And the same payload with a name that does exist inside the dir resolves
      // the in-dir file, not the outside one.
      fs.writeFileSync(path.join(tmp, 'lockdown-agent'), Buffer.from('ELF'));
      expect(resolveAgentBinary('../secret-agents/passwd')).toBeNull();
      expect(resolveAgentBinary('../../etc/passwd')).toBeNull();
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});
