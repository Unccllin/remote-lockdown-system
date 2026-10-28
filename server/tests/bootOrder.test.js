/**
 * Regression test for the boot order in src/index.js.
 *
 * The retention and alert schedulers used to be started at module load, before
 * `runMigrations()` had created the schema. On any fresh database their first
 * run failed with `SQLITE_ERROR: no such table: devices` /
 * `no such table: location_reports` — two errors on every first boot. Production
 * hid it (migrations run at deploy time); Electron, docker-compose.test.yml and
 * any in-process-migrating boot hit it every time.
 *
 * This spawns the real entry point against a throwaway SQLite database and
 * asserts the observable outcome rather than the source order, so it stays true
 * if the startup sequence is refactored.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ENTRY = path.join(__dirname, '..', 'src', 'index.js');

function bootEnv(dbPath, outPath) {
  return {
    ...process.env,
    NODE_ENV: 'production',
    USE_SQLITE: 'true',
    SQLITE_PATH: dbPath,
    PORT: '0',
    JWT_SECRET: 'test_jwt_secret_do_not_use_in_production_64hex_0000000000000000',
    AGENT_SHARED_KEY: 'test_agent_shared_key_do_not_use_in_prod_48',
    AGENT_KEY_PEPPER: 'test_agent_key_pepper_do_not_use_in_prod_64hex_00',
    FIELD_ENCRYPTION_KEY: 'test_field_encryption_key_do_not_use_prod_64_00',
    LOCATION_FIELD_KEY: 'test_location_field_key_do_not_use_prod_64_00',
    LOG_FILE: outPath,
    LOG_LEVEL: 'info',
  };
}

describe('boot order — schedulers start after migrations', () => {
  jest.setTimeout(60000);

  test('a fresh database boots with no "no such table" errors', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rls-boot-'));
    const dbPath = path.join(dir, 'fresh.db');
    const outPath = path.join(dir, 'boot.log');

    const child = spawn(process.execPath, [ENTRY], {
      env: bootEnv(dbPath, outPath),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    child.stdout.on('data', (d) => {
      output += d.toString();
    });
    child.stderr.on('data', (d) => {
      output += d.toString();
    });

    try {
      // Wait for the server to come up (or the child to die).
      const deadline = Date.now() + 45000;
      while (Date.now() < deadline && !output.includes('"msg":"Server running"')) {
        if (child.exitCode !== null) break;
        await new Promise((r) => setTimeout(r, 100));
      }

      // The log file may hold lines written through pino's file transport; the
      // captured stdio is enough for the ordering assertions below.
      const combined = output + (fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf8') : '');

      expect(combined).not.toMatch(/no such table/i);
      expect(combined).toContain('Migrations complete.');

      const migrationsAt = combined.indexOf('Migrations complete.');
      const serverAt = combined.indexOf('"msg":"Server running"');
      expect(migrationsAt).toBeGreaterThanOrEqual(0);
      expect(serverAt).toBeGreaterThan(migrationsAt);

      // A fresh DB means migrations actually ran here, not "already up to date".
      expect(fs.existsSync(dbPath)).toBe(true);
    } finally {
      child.kill('SIGKILL');
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
