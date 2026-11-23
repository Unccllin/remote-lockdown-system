const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const SERVER_DIR = path.join(__dirname, '..');
const CLI = path.join(__dirname, '..', '..', 'scripts', 'set-admin-password.js');
const NODE = process.execPath;

function runCli(args, env, stdin) {
  return new Promise((resolve) => {
    const child = spawn(NODE, [CLI, ...args], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    if (stdin !== undefined) {
      child.stdin.write(stdin);
      child.stdin.end();
    } else {
      child.stdin.end();
    }
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function migrate(dbPath) {
  return new Promise((resolve, reject) => {
    const code = `
      process.env.SQLITE_PATH = ${JSON.stringify(dbPath)};
      const p = require('${SERVER_DIR.replace(/\\/g, '/')}/src/db/sqlitePool');
      const { runMigrations } = require('${SERVER_DIR.replace(/\\/g, '/')}/src/db/migrationRunner');
      (async () => { await runMigrations(p, { dialect: 'sqlite' }); await p.end(); process.exit(0); })().catch(e=>{console.error(e);process.exit(1);});
    `;
    const child = spawn(NODE, ['-e', code], { env: { ...process.env, SQLITE_PATH: dbPath }, stdio: 'inherit' });
    child.on('close', (c) => (c === 0 ? resolve() : reject(new Error('migrate failed ' + c))));
  });
}

function seedAdmin(dbPath, username, pwHash) {
  return new Promise((resolve, reject) => {
    const code = `
      const sqlite = require('${SERVER_DIR.replace(/\\/g,'/')}/node_modules/sqlite');
      const sqlite3 = require('${SERVER_DIR.replace(/\\/g,'/')}/node_modules/sqlite3');
      const crypto = require('crypto');
      (async () => {
        const db = await sqlite.open({ filename: ${JSON.stringify(dbPath)}, driver: sqlite3.Database });
        await db.run('INSERT INTO admins (id, username, password_hash, role) VALUES (?,?,?,?)', [crypto.randomUUID(), ${JSON.stringify(username)}, ${JSON.stringify(pwHash)}, 'super-admin']);
        await db.close();
        process.exit(0);
      })().catch(e=>{console.error(e);process.exit(1);});
    `;
    const child = spawn(NODE, ['-e', code], { stdio: 'inherit' });
    child.on('close', (c) => (c === 0 ? resolve() : reject(new Error('seed failed ' + c))));
  });
}

describe('set-admin-password CLI', () => {
  let tmpDir, dbPath;
  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sap-'));
    dbPath = path.join(tmpDir, 'test.db');
    await migrate(dbPath);
    const bcrypt = require(path.join(SERVER_DIR, 'node_modules', 'bcryptjs'));
    await seedAdmin(dbPath, 'alice', bcrypt.hashSync('oldpassword', 10));
  }, 60000);

  afterAll(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
  });

  test('rejects password under 8 chars', async () => {
    const r = await runCli(['--username', 'alice', '--db', dbPath], { ADMIN_NEW_PASSWORD: 'short' }, undefined);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/at least 8 characters/);
  });

  test('rejects unknown username', async () => {
    const r = await runCli(['--username', 'nobody', '--db', dbPath], { ADMIN_NEW_PASSWORD: 'longenoughpw' }, undefined);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/no admin account named/);
  });

  test('updates hash so new password verifies and old does not', async () => {
    const r = await runCli(['--username', 'alice', '--db', dbPath], { ADMIN_NEW_PASSWORD: 'newpassword123' }, undefined);
    expect(r.code).toBe(0);
    // read hash
    const code = `
      const sqlite = require('${SERVER_DIR.replace(/\\/g,'/')}/node_modules/sqlite');
      const sqlite3 = require('${SERVER_DIR.replace(/\\/g,'/')}/node_modules/sqlite3');
      (async () => {
        const db = await sqlite.open({ filename: ${JSON.stringify(dbPath)}, driver: sqlite3.Database });
        const row = await db.get('SELECT password_hash FROM admins WHERE username = ?', ['alice']);
        console.log(row.password_hash);
        await db.close();
        process.exit(0);
      })().catch(e=>{console.error(e);process.exit(1);});
    `;
    const out = await new Promise((resolve, reject) => {
      const c = spawn(NODE, ['-e', code], { stdio: ['ignore', 'pipe', 'pipe'] });
      let o = ''; c.stdout.on('data', d => o += d); c.on('close', cc => cc === 0 ? resolve(o.trim()) : reject(new Error('read failed')));
    });
    const bcrypt = require(path.join(SERVER_DIR, 'node_modules', 'bcryptjs'));
    expect(bcrypt.compareSync('newpassword123', out)).toBe(true);
    expect(bcrypt.compareSync('oldpassword', out)).toBe(false);
  });

  test('--list never prints the hash', async () => {
    const r = await runCli(['--list', '--db', dbPath], {}, undefined);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/alice \(super-admin\) bcrypt cost/);
    expect(r.stdout).not.toMatch(/\$2[aby]\$/);
  });
});
