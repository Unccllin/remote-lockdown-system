/**
 * Phase 13: Tests for the notification module and alert scheduler.
 *
 * Covers:
 *   notify.js:
 *     - no channels configured -> logs, no error, returns false
 *     - webhook configured -> HTTP POST called (mocked fetch)
 *     - never throws on channel failure
 *   alertScheduler:
 *     - detects stale devices
 *     - creates audit_log entries
 *     - sends notifications for new alerts
 */

const { mockPool } = require('./mockPool');
jest.mock('../src/db/pool', () => mockPool);

// --- notify.js tests ------------------------------------------------------

describe('notify.js', () => {
  let sendNotification;

  beforeEach(() => {
    jest.resetModules();
    // Clear all notification env vars between tests.
    delete process.env.NOTIFICATION_WEBHOOK_URL;
    delete process.env.SLACK_WEBHOOK_URL;
    delete process.env.SMTP_HOST;
    delete process.env.SMTP_PORT;
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASS;
    delete process.env.EMAIL_FROM;
    delete process.env.EMAIL_TO;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('no channels configured -> logs, no error, returns false', async () => {
    sendNotification = require('../src/notifications/notify').sendNotification;
    const logger = require('../src/logger');
    const logSpy = jest.spyOn(logger, 'info').mockImplementation(() => {});

    const result = await sendNotification('device_stale', { deviceId: 'd1' });

    expect(result).toBe(false);
    expect(logSpy).toHaveBeenCalled();
  });

  test('webhook configured -> HTTP POST called via fetch', async () => {
    process.env.NOTIFICATION_WEBHOOK_URL = 'https://example.com/hook';

    // Mock global fetch.
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200, statusText: 'OK' });
    global.fetch = fetchMock;

    sendNotification = require('../src/notifications/notify').sendNotification;

    const result = await sendNotification('device_stale', { deviceId: 'd1' });

    expect(result).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('https://example.com/hook');
    expect(opts.method).toBe('POST');
    const parsed = JSON.parse(opts.body);
    expect(parsed.eventType).toBe('device_stale');
    expect(parsed.payload).toEqual({ deviceId: 'd1' });
    expect(parsed.timestamp).toBeDefined();

    delete global.fetch;
  });

  test('never throws on channel failure', async () => {
    process.env.NOTIFICATION_WEBHOOK_URL = 'https://example.com/hook';

    // fetch throws.
    const fetchMock = jest.fn().mockRejectedValue(new Error('network down'));
    global.fetch = fetchMock;
    const logger = require('../src/logger');
    const errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => {});

    sendNotification = require('../src/notifications/notify').sendNotification;

    // Should NOT throw.
    await expect(sendNotification('device_stale', { deviceId: 'd1' })).resolves.not.toThrow();
    expect(errorSpy).toHaveBeenCalled();

    delete global.fetch;
  });
});

// --- alertScheduler tests -------------------------------------------------

describe('alertScheduler', () => {
  let alertScheduler;
  let notifyModule;

  beforeEach(() => {
    jest.resetModules();
    mockPool.query.reset();
    mockPool.connect.mockClear();
    // No notification channels configured by default.
    delete process.env.NOTIFICATION_WEBHOOK_URL;
    delete process.env.SLACK_WEBHOOK_URL;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('detects stale devices and creates audit_log entries + notifications', async () => {
    // Mock a stale device returned by the stale query.
    mockPool.query.setResult('last_checkin < NOW()', {
      rows: [
        {
          id: 'device-stale-1',
          hostname: 'host-1',
          last_checkin: '2024-01-01T00:00:00Z',
        },
      ],
    });
    // SELECT 1 (health check) succeeds by default.
    // audit_log insert succeeds by default.

    // Mock sendNotification so we can assert it was called.
    jest.mock('../src/notifications/notify', () => ({
      sendNotification: jest.fn().mockResolvedValue(true),
    }));

    alertScheduler = require('../src/jobs/alertScheduler');
    notifyModule = require('../src/notifications/notify');

    await alertScheduler.checkStaleDevices();

    // audit_log entry inserted.
    const auditCall = mockPool.query.mock.calls.find(
      ([sql]) => sql.includes('INSERT INTO audit_log')
    );
    expect(auditCall).toBeDefined();
    expect(auditCall[1][1]).toBe('health_alert');

    // sendNotification called with device_stale event.
    expect(notifyModule.sendNotification).toHaveBeenCalled();
    const notifyCall = notifyModule.sendNotification.mock.calls[0];
    expect(notifyCall[0]).toBe('device_stale');
    expect(notifyCall[1].deviceId).toBe('device-stale-1');
    expect(notifyCall[1].hostname).toBe('host-1');
  });

  test('does not re-alert for an already-alerted stale device', async () => {
    mockPool.query.setResult('last_checkin < NOW()', {
      rows: [
        {
          id: 'device-stale-2',
          hostname: 'host-2',
          last_checkin: '2024-01-01T00:00:00Z',
        },
      ],
    });

    jest.mock('../src/notifications/notify', () => ({
      sendNotification: jest.fn().mockResolvedValue(true),
    }));

    alertScheduler = require('../src/jobs/alertScheduler');
    notifyModule = require('../src/notifications/notify');

    // First check: should alert.
    await alertScheduler.checkStaleDevices();
    expect(notifyModule.sendNotification).toHaveBeenCalledTimes(1);

    // Second check: same device still stale — should NOT re-alert.
    notifyModule.sendNotification.mockClear();
    await alertScheduler.checkStaleDevices();
    expect(notifyModule.sendNotification).not.toHaveBeenCalled();
  });

  test('sends health_degraded notification on DB transition to degraded', async () => {
    jest.mock('../src/notifications/notify', () => ({
      sendNotification: jest.fn().mockResolvedValue(true),
    }));

    alertScheduler = require('../src/jobs/alertScheduler');
    notifyModule = require('../src/notifications/notify');

    // Make SELECT 1 fail (DB down).
    mockPool.setError('SELECT 1', new Error('connection refused'));

    await alertScheduler.checkServerHealth();

    expect(notifyModule.sendNotification).toHaveBeenCalledWith(
      'health_degraded',
      expect.objectContaining({ reason: 'connection refused' })
    );
  });

  test('runAlertCheck skips stale-device check when DB is down', async () => {
    jest.mock('../src/notifications/notify', () => ({
      sendNotification: jest.fn().mockResolvedValue(true),
    }));

    alertScheduler = require('../src/jobs/alertScheduler');

    mockPool.setError('SELECT 1', new Error('connection refused'));
    // Even if stale query would return rows, it should never be called.
    mockPool.query.setResult('last_checkin < NOW()', {
      rows: [{ id: 'should-not-appear', hostname: 'x', last_checkin: '2024-01-01' }],
    });

    await alertScheduler.runAlertCheck();

    const staleCall = mockPool.query.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('last_checkin < NOW()')
    );
    expect(staleCall).toBeUndefined();
  });
});
