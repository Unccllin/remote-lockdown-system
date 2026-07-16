/**
 * Mock PostgreSQL pool for testing.
 *
 * The routes call `pool.query(sql, params)` which returns a Promise
 * resolving to `{ rows: [...] }`.
 *
 * withTransaction() calls `pool.connect()` to get a client, then calls
 * `client.query()` for BEGIN/COMMIT/individual statements. The mock client
 * delegates to the same _queryImpl so setResult() patterns work for both
 * pool.query() and client.query().
 *
 * Usage:
 *   jest.mock('../src/db/pool', () => require('./tests/mockPool').mockPool);
 *
 *   // Default: returns { rows: [] } for every query
 *   // Configure per SQL pattern:
 *   mockPool.query.setResult('SELECT * FROM devices WHERE id', { rows: [deviceObj] });
 *   // Or use a function for dynamic results:
 *   mockPool.query.setResult('INSERT INTO commands', (sql, params) => ({ rows: [{ id: 'cmd-1' }] }));
 */

const _patternMap = new Map();

// The core query handler — NOT a jest.fn so mockClear() can't break it.
// We wrap it in a jest.fn for call tracking, but always delegate to this.
async function _queryImpl(sql, params) {
  // BEGIN/COMMIT/ROLLBACK always succeed silently
  if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
    return { rows: [], rowCount: 0 };
  }
  // Match the LONGEST pattern first (most specific) so that
  // 'SELECT * FROM devices WHERE api_key_hash' takes precedence
  // over 'SELECT * FROM devices'.
  const sortedPatterns = [..._patternMap.entries()].sort(
    (a, b) => b[0].length - a[0].length
  );
  for (const [pattern, result] of sortedPatterns) {
    if (sql.includes(pattern)) {
      return typeof result === 'function' ? result(sql, params) : result;
    }
  }
  return { rows: [] };
}

// Create a jest.fn that wraps _queryImpl for call tracking.
// We use mockImplementation to ensure it always delegates, even after mockClear.
const queryFn = jest.fn().mockImplementation(_queryImpl);

queryFn.setResult = (sqlPattern, result) => {
  _patternMap.set(sqlPattern, result);
};

queryFn.clearResults = () => {
  _patternMap.clear();
};

// Reset both patterns and call history, and re-attach implementation
queryFn.reset = () => {
  _patternMap.clear();
  queryFn.mockClear();
  queryFn.mockImplementation(_queryImpl);
};

// Mock client for withTransaction — delegates query to the same queryFn
// so setResult() patterns work inside transactions too.
function createMockClient() {
  return {
    query: queryFn,
    release: jest.fn(),
  };
}

const mockPool = {
  query: queryFn,
  connect: jest.fn(async () => createMockClient()),
  end: jest.fn(async () => {}),
};

// Allow tests to simulate a query error (for transaction rollback tests)
mockPool.setError = (sqlPattern, error) => {
  _patternMap.set(sqlPattern, () => { throw error; });
};

module.exports = { mockPool };
