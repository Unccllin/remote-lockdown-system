/**
 * Mock PostgreSQL pool for testing.
 *
 * The routes call `pool.query(sql, params)` which returns a Promise
 * resolving to `{ rows: [...] }`.
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
  for (const [pattern, result] of _patternMap.entries()) {
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

const mockPool = {
  query: queryFn,
  connect: jest.fn(async () => ({
    query: queryFn,
    release: jest.fn(),
  })),
  end: jest.fn(async () => {}),
};

module.exports = { mockPool };
