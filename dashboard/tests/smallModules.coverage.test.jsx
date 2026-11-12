import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

/**
 * Covers the small pure-function modules that the dashboard's coverage floor depends on:
 *   - api/alerts.js  (severity mapping + dismissal persistence)
 *   - hooks/useServerlessMode.js (the Worker/Express detection every serverless branch uses)
 *
 * Both were fully uncovered, which is what held global function coverage under the 62% floor
 * while 231 tests passed.
 */
// The hook reads an axios-shaped response: res.data.serverless.
vi.mock('../src/api/health', () => ({
  getHealth: vi.fn(async () => ({ data: { serverless: true } })),
}));

const { getSeverity, getDismissedAlertIds, dismissAlert, _clearDismissed } = await import(
  '../src/api/alerts'
);

describe('api/alerts', () => {
  beforeEach(() => {
    localStorage.clear();
    _clearDismissed();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('maps alert types to a level + label', () => {
    expect(getSeverity('missed_checkin').level).toBe('amber');
    expect(getSeverity('location_jump').level).toBe('red');
    expect(getSeverity('failed_unlock').level).toBe('red');
    // Unknown types must fall back rather than crash the alerts page.
    expect(getSeverity('something_new')).toEqual({ level: 'slate', label: 'Alert' });
    expect(getSeverity('missed_checkin').label).toBe('Missed Check-in');
  });

  it('starts with nothing dismissed', () => {
    expect(getDismissedAlertIds()).toEqual([]);
  });

  it('remembers a dismissal across reads', () => {
    dismissAlert('alert-1');
    dismissAlert('alert-2');
    const ids = getDismissedAlertIds();
    expect(ids).toContain('alert-1');
    expect(ids).toContain('alert-2');
  });

  it('survives malformed persisted JSON', () => {
    localStorage.setItem('dismissed_alerts', '{not json');
    expect(getDismissedAlertIds()).toEqual([]);
  });

  it('clears dismissals', () => {
    dismissAlert('alert-1');
    _clearDismissed();
    expect(getDismissedAlertIds()).toEqual([]);
  });
});

describe('hooks/useServerlessMode', () => {
  it('reports serverless mode from the health endpoint', async () => {
    // The hook caches its result at module scope, so reset the registry to get a fresh module.
    vi.resetModules();
    const { useServerlessMode } = await import('../src/hooks/useServerlessMode');
    const { result } = renderHook(() => useServerlessMode());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.serverless).toBe(true);
  });
});
