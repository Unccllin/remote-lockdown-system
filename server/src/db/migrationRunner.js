/**
 * Migration runner — executes ordered .sql files from the migrations/ directory.
 *
 * Tracks applied migrations in a `schema_migrations` table so re-runs are safe.
 * Both migrate.js (production) and dev-start.js (PGlite) consume the same files,
 * eliminating the previous schema duplication.
 */

const fs = require('fs');
const path = require('path');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
const MIGRATIONS_SQLITE_DIR = path.join(__dirname, 'migrations-sqlite');

/**
 * Split a SQL file into individual statements.
 * Handles:
 *   - Semicolons inside single-quoted strings (e.g. 'don't')
 *   - Dollar-quoted blocks ($$ ... $$) used in plpgsql function bodies
 *   - Line comments (--) and block comments (/* *\/)
 * PGlite doesn't support multi-statement prepared queries, so we split
 * and execute one statement at a time. Real Postgres handles both fine.
 */
function splitSqlStatements(sql) {
  const statements = [];
  let current = '';
  let inString = false;
  let inDollarQuote = false;
  let dollarTag = '';
  let inLineComment = false;
  let inBlockComment = false;
  // SQLite trigger bodies use BEGIN ... END; — don't split on semicolons inside.
  let inBeginEnd = 0; // depth counter

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    const next = sql[i + 1];

    // Handle line comments (-- to end of line)
    if (!inString && !inDollarQuote && !inBlockComment && ch === '-' && next === '-') {
      inLineComment = true;
      continue;
    }
    if (inLineComment) {
      if (ch === '\n') {
        inLineComment = false;
        current += ch; // keep the newline for formatting
      }
      continue; // don't add comment chars to current
    }

    // Handle block comments (/* ... */)
    if (!inString && !inDollarQuote && !inLineComment && ch === '/' && next === '*') {
      inBlockComment = true;
      current += '/*';
      i++; // skip the *
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        current += '*/';
        i++; // skip the /
        inBlockComment = false;
        continue;
      }
      current += ch;
      continue;
    }

    // Handle dollar-quoted blocks ($$tag$$ or $tag$...$tag$)
    if (!inString && ch === '$') {
      // Try to read a dollar tag
      let j = i + 1;
      let tag = '';
      while (j < sql.length && sql[j] !== '$' && /[a-zA-Z0-9_]/.test(sql[j])) {
        tag += sql[j];
        j++;
      }
      if (j < sql.length && sql[j] === '$') {
        // Found a $tag$ delimiter
        const fullTag = '$' + tag + '$';
        if (!inDollarQuote) {
          inDollarQuote = true;
          dollarTag = fullTag;
          current += fullTag;
          i = j; // skip past the closing $
          continue;
        } else if (fullTag === dollarTag) {
          inDollarQuote = false;
          dollarTag = '';
          current += fullTag;
          i = j; // skip past the closing $
          continue;
        }
      }
    }

    // Handle single-quoted strings
    if (ch === "'" && !inDollarQuote && sql[i - 1] !== '\\') {
      inString = !inString;
    }

    // Track SQLite BEGIN...END blocks (trigger bodies)
    // Only track when not inside a string or dollar-quote
    if (!inString && !inDollarQuote && !inLineComment && !inBlockComment) {
      // Check for BEGIN keyword: 5 chars, case-insensitive, word-bounded
      const wordBefore = i === 0 || /\s/.test(sql[i - 1]);
      const beginMatch = i + 5 <= sql.length && sql.substr(i, 5).toUpperCase() === 'BEGIN';
      const beginAfter = i + 5 >= sql.length || /[\s(]/.test(sql[i + 5]);
      if (wordBefore && beginMatch && beginAfter) {
        inBeginEnd++;
        current += 'BEGIN';
        i += 4; // skip past "BEGIN" (loop's i++ handles the last char)
        continue;
      }
      // Check for END keyword: 3 chars, case-insensitive, word-bounded
      const endMatch = i + 3 <= sql.length && sql.substr(i, 3).toUpperCase() === 'END';
      const endAfter = i + 3 >= sql.length || /[\s;]/.test(sql[i + 3]);
      if (wordBefore && endMatch && endAfter) {
        if (inBeginEnd > 0) inBeginEnd--;
        current += 'END';
        i += 2; // skip past "END" (loop's i++ handles the last char)
        continue;
      }
    }

    current += ch;

    // Only split on semicolon when not inside a string, dollar-quote,
    // or SQLite BEGIN...END trigger body
    if (ch === ';' && !inString && !inDollarQuote && inBeginEnd === 0) {
      const trimmed = current.trim();
      if (trimmed && !trimmed.startsWith('--')) {
        statements.push(trimmed);
      }
      current = '';
    }
  }

  // Catch any trailing statement without semicolon
  const trailing = current.trim();
  if (trailing && !trailing.startsWith('--')) {
    statements.push(trailing);
  }

  return statements;
}

/**
 * Run all pending migrations against the given pool/client.
 * @param {object} poolOrClient — object with .query(sql, params) (pool or client)
 * @param {object} opts — { closePool: bool, dialect: 'pg' | 'sqlite' }
 *   - closePool: if true, call pool.end() after (for CLI migrate.js)
 *   - dialect: selects which migration directory to use
 *     'pg' (default) → migrations/ (PostgreSQL syntax)
 *     'sqlite'       → migrations-sqlite/ (SQLite syntax)
 */
async function runMigrations(poolOrClient, { closePool = false, dialect = 'pg' } = {}) {
  const migrationsDir = dialect === 'sqlite' ? MIGRATIONS_SQLITE_DIR : MIGRATIONS_DIR;

  // Ensure the migrations tracking table exists.
  // Use dialect-appropriate schema (TIMESTAMPTZ for PG, TEXT for SQLite).
  if (dialect === 'sqlite') {
    await poolOrClient.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version VARCHAR(50) PRIMARY KEY,
        applied_at TEXT DEFAULT (datetime('now'))
      )
    `);
  } else {
    await poolOrClient.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version VARCHAR(50) PRIMARY KEY,
        applied_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
  }

  // Get already-applied migrations
  const applied = await poolOrClient.query('SELECT version FROM schema_migrations');
  const appliedSet = new Set(applied.rows.map((r) => r.version));

  // List migration files in order
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  let count = 0;
  for (const file of files) {
    const version = file.replace(/\.sql$/, '');
    if (appliedSet.has(version)) continue;

    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    console.log(`  Applying migration: ${version}`);

    // Split into individual statements (PGlite/SQLite don't support multi-statement queries)
    const statements = splitSqlStatements(sql);
    for (const stmt of statements) {
      await poolOrClient.query(stmt);
    }
    await poolOrClient.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
    count++;
  }

  if (count === 0) {
    console.log('  No new migrations to apply.');
  } else {
    console.log(`  Applied ${count} migration(s).`);
  }

  if (closePool && typeof poolOrClient.end === 'function') {
    await poolOrClient.end();
  }
}

module.exports = { runMigrations, MIGRATIONS_DIR, MIGRATIONS_SQLITE_DIR };
