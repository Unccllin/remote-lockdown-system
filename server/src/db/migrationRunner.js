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
      const dollarStart = i;
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

    current += ch;

    if (ch === ';' && !inString && !inDollarQuote) {
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
 * @param {boolean} closePool — if true, call pool.end() after (for CLI migrate.js)
 */
async function runMigrations(poolOrClient, { closePool = false } = {}) {
  // Ensure the migrations tracking table exists
  await poolOrClient.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version VARCHAR(50) PRIMARY KEY,
      applied_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Get already-applied migrations
  const applied = await poolOrClient.query('SELECT version FROM schema_migrations');
  const appliedSet = new Set(applied.rows.map((r) => r.version));

  // List migration files in order
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  let count = 0;
  for (const file of files) {
    const version = file.replace(/\.sql$/, '');
    if (appliedSet.has(version)) continue;

    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    console.log(`  Applying migration: ${version}`);

    // Split into individual statements (PGlite doesn't support multi-statement queries)
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

module.exports = { runMigrations, MIGRATIONS_DIR };
