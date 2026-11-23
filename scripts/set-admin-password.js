#!/usr/bin/env node
/**
 * Reset an admin password in the local SQLite database.
 *
 * Why this exists: passwords are stored as one-way bcrypt hashes
 * (`$2a$12$…`, 60 chars — see `admins.password_hash`), so no tool can recover
 * the original text of an existing account. The only honest answer to "what is
 * the password for <user>" is "a new one, which you choose". This script writes
 * that new hash without ever echoing or logging the value.
 *
 * The new password is read from stdin or ADMIN_NEW_PASSWORD — never from argv,
 * which would land in shell history and in `ps` output.
 *
 * Usage:
 *   read -rs -p 'New password: ' PW; echo
 *   printf '%s' "$PW" | node scripts/set-admin-password.js --username uncletom
 *   unset PW
 *
 *   ADMIN_NEW_PASSWORD='…' node scripts/set-admin-password.js --username uncletom
 *
 * Options:
 *   --username <name>   Account to update (required)
 *   --db <path>         SQLite file (default: server/.sqlite-data/lockdown-dev.db)
 *   --list              Print username/role/hash-cost for every account, then exit
 */

const path = require('path');

const SERVER_DIR = path.join(__dirname, '..', 'server');
const { resolveDbPath } = require(path.join(SERVER_DIR, 'src', 'db', 'dbPath'));
const bcrypt = require(path.join(SERVER_DIR, 'node_modules', 'bcryptjs'));
const sqlite = require(path.join(SERVER_DIR, 'node_modules', 'sqlite'));
const sqlite3 = require(path.join(SERVER_DIR, 'node_modules', 'sqlite3'));

const BCRYPT_COST = 12; // matches the cost factor already in use for app-created admins

function parseArgs(argv) {
  const args = { username: null, db: null, list: false };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--username') args.username = argv[++i];
    else if (arg === '--db') args.db = argv[++i];
    else if (arg === '--list') args.list = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
}

/**
 * Bounded wait for stdin. When stdin is a pipe the whole body is read; when it
 * is a TTY the characters are read one at a time with echo off, so the password
 * never appears on screen or in the scrollback.
 */
function readPassword() {
  return new Promise((resolve, reject) => {
    const input = process.stdin;

    if (!input.isTTY) {
      let data = '';
      input.setEncoding('utf8');
      input.on('data', (chunk) => { data += chunk; });
      input.on('end', () => resolve(data.replace(/\r?\n$/, '')));
      input.on('error', reject);
      return;
    }

    const output = process.stdout;
    output.write('New password: ');
    input.setRawMode(true);
    input.setEncoding('utf8');
    input.resume();

    let value = '';

    const finish = (result) => {
      input.removeListener('data', onData);
      input.setRawMode(false);
      input.pause();
      output.write('\n');
      resolve(result);
    };

    const onData = (char) => {
      // Ctrl-C / Ctrl-D
      if (char === '\u0003') {
        output.write('\n');
        process.exit(130);
      }
      if (char === '\u0004') {
        finish(value);
        return;
      }
      if (char === '\r' || char === '\n') {
        finish(value);
        return;
      }
      if (char === '\u007f' || char === '\b') {
        if (value.length > 0) {
          value = value.slice(0, -1);
          output.write('\b \b');
        }
        return;
      }
      value += char;
      output.write('*');
    };

    input.on('data', onData);
    input.on('error', reject);
  });
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`error: ${err.message}`);
    process.exit(2);
  }

  if (args.help) {
    console.log('Usage: node scripts/set-admin-password.js --username <name> [--db <path>] [--list]');
    return;
  }

  const dbPath = args.db ? path.resolve(args.db) : resolveDbPath();
  if (dbPath === ':memory:') {
    console.error('error: refusing to operate on :memory: — nothing would persist');
    process.exit(2);
  }

  const db = await sqlite.open({ filename: dbPath, driver: sqlite3.Database });

  try {
    if (args.list) {
      const rows = await db.all('SELECT username, role, password_hash FROM admins ORDER BY created_at');
      console.log(`Database: ${dbPath}`);
      if (rows.length === 0) console.log('  (no admin accounts)');
      for (const row of rows) {
        const cost = (row.password_hash || '').split('$')[2] || '?';
        console.log(`  ${row.username} (${row.role}) bcrypt cost ${cost}`);
      }
      return;
    }

    if (!args.username) {
      console.error('error: --username is required (or use --list)');
      process.exit(2);
    }

    const existing = await db.get(
      'SELECT id, username, role FROM admins WHERE username = ?',
      [args.username]
    );
    if (!existing) {
      console.error(`error: no admin account named '${args.username}' in ${dbPath}`);
      process.exit(1);
    }

    const fromEnv = process.env.ADMIN_NEW_PASSWORD;
    const password = fromEnv !== undefined ? fromEnv : await readPassword();

    if (!password || password.length < 8) {
      console.error('error: password must be at least 8 characters');
      process.exit(1);
    }

    const hash = bcrypt.hashSync(password, BCRYPT_COST);
    const result = await db.run('UPDATE admins SET password_hash = ? WHERE id = ?', [hash, existing.id]);

    if (result.changes !== 1) {
      console.error(`error: expected 1 row updated, got ${result.changes}`);
      process.exit(1);
    }

    console.log(`Password updated for '${existing.username}' (${existing.role}) in ${dbPath}`);
    console.log('The new password is known only to you — it is stored as a bcrypt hash.');
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  console.error(`error: ${err.message}`);
  process.exit(1);
});
