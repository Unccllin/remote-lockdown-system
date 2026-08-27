require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const pool = require('./pool');
const { runMigrations } = require('./migrationRunner');
const logger = require('../logger');

async function migrate() {
  const dialect = process.env.USE_SQLITE === 'true' ? 'sqlite' : 'pg';
  const client = await pool.connect();
  try {
    logger.info({ dialect }, 'Running migrations...');
    await runMigrations(client, { dialect });
    logger.info('Migrations complete.');
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch((err) => {
  logger.error({ err }, 'Migration failed');
  process.exit(1);
});
