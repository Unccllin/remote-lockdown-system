require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const pool = require('./pool');
const { runMigrations } = require('./migrationRunner');

async function migrate() {
  const client = await pool.connect();
  try {
    console.log('Running migrations...');
    await runMigrations(client);
    console.log('Migrations complete.');
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
