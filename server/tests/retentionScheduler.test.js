/**
 * Tests for the retention scheduler (FA5).
 *
 * The critical bug this test catches: on SQLite, pg_try_advisory_lock($1)
 * is translated to SELECT 1, so the result column is named '1' (not
 * 'pg_try_advisory_lock'). The old code accessed
 * lockResult.rows[0].pg_try_advisory_lock, which returned undefined (falsy),
 * causing the purge to be silently skipped on every SQLite/PGlite run.
 *
 * This test verifies:
 *   1. The purge DELETE is actually executed (not skipped) when the lock
 *      result doesn't have a pg_try_advisory_lock column (SQLite behavior).
 *   2. The purge DELETE uses the correct retention period.
 *   3. Old records are actually deleted (rowCount is returned correctly).
 *   4. An audit log entry is written when rows are deleted.
 */

// Mock the pool BEFORE requiring the scheduler
const { mockPool } = require('./helpers');
jest.mock('../src/db/pool', () => mockPool);

const { runRetentionPurge } = require('../src/jobs/retentionScheduler');

describe('retentionScheduler', () => {
  beforeEach(() => {
    mockPool.query.reset();
    mockPool.connect.mockClear();
  });

  describe('runRetentionPurge — SQLite-style lock result (the bug)', () => {
    it('should NOT skip the purge when pg_try_advisory_lock column is absent', async () => {
      // Simulate SQLite: SELECT 1 returns { '1': 1 } — no pg_try_advisory_lock column
      mockPool.query.setResult('pg_try_advisory_lock', { rows: [{ '1': 1 }] });
      // The DELETE returns 3 deleted rows
      mockPool.query.setResult('DELETE FROM location_reports', {
        rows: [{ id: 'row-1' }, { id: 'row-2' }, { id: 'row-3' }],
        rowCount: 3,
      });
      // The audit log insert succeeds
      mockPool.query.setResult('INSERT INTO audit_log', { rows: [], rowCount: 1 });

      const result = await runRetentionPurge();

      expect(result.skipped).toBe(false);
      expect(result.rowsDeleted).toBe(3);

      // Verify the DELETE was actually called (not skipped)
      const deleteCall = mockPool.query.mock.calls.find(
        ([sql]) => sql.includes('DELETE FROM location_reports')
      );
      expect(deleteCall).toBeDefined();
      // Verify it uses the configured retention period (90 days from setup.js)
      expect(deleteCall[0]).toContain("INTERVAL '90 days'");
    });

    it('should skip the purge when pg_try_advisory_lock returns false (Postgres multi-instance)', async () => {
      // Simulate Postgres: another instance holds the lock
      mockPool.query.setResult('pg_try_advisory_lock', {
        rows: [{ pg_try_advisory_lock: false }],
      });

      const result = await runRetentionPurge();

      expect(result.skipped).toBe(true);
      expect(result.rowsDeleted).toBe(0);

      // Verify the DELETE was NOT called
      const deleteCall = mockPool.query.mock.calls.find(
        ([sql]) => sql.includes('DELETE FROM location_reports')
      );
      expect(deleteCall).toBeUndefined();
    });
  });

  describe('runRetentionPurge — Postgres-style lock result', () => {
    it('should run the purge when pg_try_advisory_lock returns true', async () => {
      mockPool.query.setResult('pg_try_advisory_lock', {
        rows: [{ pg_try_advisory_lock: true }],
      });
      mockPool.query.setResult('DELETE FROM location_reports', {
        rows: [{ id: 'old-1' }],
        rowCount: 1,
      });
      mockPool.query.setResult('INSERT INTO audit_log', { rows: [], rowCount: 1 });

      const result = await runRetentionPurge();

      expect(result.skipped).toBe(false);
      expect(result.rowsDeleted).toBe(1);
    });
  });

  describe('runRetentionPurge — audit logging', () => {
    it('should write an audit log entry when rows are deleted', async () => {
      mockPool.query.setResult('pg_try_advisory_lock', { rows: [{ '1': 1 }] });
      mockPool.query.setResult('DELETE FROM location_reports', {
        rows: [{ id: 'r1' }, { id: 'r2' }],
        rowCount: 2,
      });
      mockPool.query.setResult('INSERT INTO audit_log', { rows: [], rowCount: 1 });

      await runRetentionPurge();

      const auditCall = mockPool.query.mock.calls.find(
        ([sql]) => sql.includes('INSERT INTO audit_log')
      );
      expect(auditCall).toBeDefined();
      expect(auditCall[1][0]).toBe('retention_purge');
      // The detail parameter should contain rowsDeleted and retentionDays
      const detail = auditCall[1][1];
      if (typeof detail === 'string') {
        // SQLite path: stringified JSON
        const parsed = JSON.parse(detail);
        expect(parsed.rowsDeleted).toBe(2);
        expect(parsed.retentionDays).toBe(90);
      } else {
        // Postgres path: object passed directly
        expect(detail.rowsDeleted).toBe(2);
        expect(detail.retentionDays).toBe(90);
      }
    });

    it('should NOT write an audit log entry when no rows are deleted', async () => {
      mockPool.query.setResult('pg_try_advisory_lock', { rows: [{ '1': 1 }] });
      mockPool.query.setResult('DELETE FROM location_reports', {
        rows: [],
        rowCount: 0,
      });

      await runRetentionPurge();

      const auditCall = mockPool.query.mock.calls.find(
        ([sql]) => sql.includes('INSERT INTO audit_log')
      );
      expect(auditCall).toBeUndefined();
    });
  });

  describe('runRetentionPurge — retention period from env', () => {
    it('should use LOCATION_RETENTION_DAYS from env', async () => {
      const original = process.env.LOCATION_RETENTION_DAYS;
      process.env.LOCATION_RETENTION_DAYS = '30';

      mockPool.query.setResult('pg_try_advisory_lock', { rows: [{ '1': 1 }] });
      mockPool.query.setResult('DELETE FROM location_reports', {
        rows: [],
        rowCount: 0,
      });

      await runRetentionPurge();

      const deleteCall = mockPool.query.mock.calls.find(
        ([sql]) => sql.includes('DELETE FROM location_reports')
      );
      expect(deleteCall[0]).toContain("INTERVAL '30 days'");

      process.env.LOCATION_RETENTION_DAYS = original;
    });
  });
});
