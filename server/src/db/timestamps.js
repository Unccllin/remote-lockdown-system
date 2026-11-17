/**
 * Timestamp normalisation shared by every route that compares a stored time.
 *
 * Both dialects are read by the same JavaScript, and the two store shapes disagree:
 *
 *   PostgreSQL  `2026-11-05T10:00:00.000Z`          — carries a zone
 *   SQLite      `2026-11-05 10:00:00`                — `datetime('now')`, NO zone marker
 *
 * V8 parses that second form as **local** time, so comparing the two without
 * normalising makes any staleness window depend on the host's UTC offset (2 hours in
 * CET, 0 on a UTC runner). A gate that passes here and fails in CI — or the reverse —
 * is the defect class D-258 recorded, and it is invisible to a fixture whose two
 * timestamps shift together.
 *
 * Zoneless values are therefore read as UTC, which is what both dialects actually
 * write: SQLite's `datetime('now')` is UTC by definition, and every route that
 * supplies a value itself writes ISO-8601.
 *
 * This lives in its own module (rather than in `routes/devices.js`) because the
 * agent's location route needs the same reading to validate an agent-supplied
 * `observed_at`, and `routes/agent.js` importing `routes/devices.js` would make the
 * two route modules require each other.
 */

/**
 * A timestamp as written by either dialect, in milliseconds since the epoch, or null
 * when the value is absent or unparseable.
 *
 * @param {string|Date|null|undefined} value
 * @returns {number|null}
 */
function parseDbTimestamp(value) {
  if (!value) return null;
  if (value instanceof Date) return value.getTime();
  const raw = String(value).trim();
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(raw)
    ? `${raw.replace(' ', 'T')}Z`
    : raw;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * A safe SQL column-name check. The two call sites pass literals, and this keeps it that way:
 * an identifier is the only thing this function will ever interpolate into SQL.
 */
const COLUMN_NAME = /^[a-z_][a-z0-9_]*$/i;

/**
 * An `ORDER BY` expression for "when did this happen", correct on both dialects.
 *
 * The two columns do not hold the same *shape* of text in SQLite:
 *
 *   reported_at   `datetime('now')`  → `2026-11-17 11:45:52`      (space)
 *   observed_at   agent ISO-8601     → `2026-11-17T06:45:52.030Z` (T, Z)
 *
 * Both are TEXT, so SQLite compares them character by character — and `'T'` (0x54) sorts after
 * `' '` (0x20), so a fix taken at 06:45 ordered ABOVE one taken at 11:45. Measured on a real
 * SQLite database (S272 artifact, step 15): raw `COALESCE` gave `Middle > Earlier > Newer`
 * while `datetime(COALESCE(...))` gave `Newer > Middle > Earlier`. `datetime()` parses both
 * shapes and returns one, which is what makes the comparison chronological.
 *
 * PostgreSQL needs none of that: both columns are TIMESTAMPTZ, so comparison is by time, and
 * `datetime()` does not exist there. The dialect comes from the pool itself (`pool.driver`, the
 * field `sqlitePool` already exposes for exactly this kind of decision) rather than from an env
 * var: a caller that requires `sqlitePool` directly — the migration and E2E harnesses do — would
 * be misread by an env check.
 *
 * @param {string} primary column holding the observation time (may be NULL)
 * @param {string} fallback column holding the receipt time (never NULL)
 * @param {string|undefined} driver `pool.driver`; 'sqlite' selects the normalising branch
 * @returns {string} an `ORDER BY` fragment, e.g. `datetime(COALESCE(a, b)) DESC`
 */
function coalescedTimeOrderSql(primary, fallback, driver) {
  if (!COLUMN_NAME.test(primary) || !COLUMN_NAME.test(fallback)) {
    throw new TypeError(`coalescedTimeOrderSql: not a column name: ${primary}, ${fallback}`);
  }
  const pair = `COALESCE(${primary}, ${fallback})`;
  return driver === 'sqlite' ? `datetime(${pair}) DESC` : `${pair} DESC`;
}

module.exports = { parseDbTimestamp, coalescedTimeOrderSql };
