/**
 * Phase 7: Full lockdown flow E2E test.
 *
 * Drives the complete lockdown lifecycle against the real Express route
 * handlers backed by an isolated SQLite temp DB:
 *   create admin → login → enroll device → agent checkin → flag stolen →
 *   agent receives lockdown command → agent ACKs lockdown → encryption key
 *   stored on server → audit log entries present → device status transitions.
 *
 * This is an API-level E2E test (no browser, no agent binary). It verifies
 * the server-side state machine and audit trail end-to-end.
 */

// Mock the pool to use SQLite BEFORE requiring setup (which loads the routes).
jest.mock('../../server/src/db/pool', () => require('../../server/src/db/sqlitePool'));

const { bootstrap, shutdown } = require('./setup');

let ctx;

beforeAll(async () => {
  ctx = await bootstrap();
}, 30000);

afterAll(async () => {
  await shutdown(ctx);
}, 15000);

describe('E2E: full lockdown flow', () => {
  test('enroll → checkin → flag-stolen → lockdown command → ACK → key stored → audit log', async () => {
    // --- Step 1: Enroll a device (returns per-device API key once) ---
    const enrollRes = await ctx.createDevice('Alice', 'E2E-LOCKDOWN-001');
    expect(enrollRes.status).toBe(201);
    expect(enrollRes.body.id).toBeDefined();
    expect(enrollRes.body.api_key).toBeDefined();
    expect(enrollRes.body.status).toBe('active');
    const deviceId = enrollRes.body.id;
    const apiKey = enrollRes.body.api_key;
    const hostname = enrollRes.body.hostname;

    // --- Step 2: Agent checks in → last_checkin updated, no command yet ---
    const checkin1 = await ctx.agentCheckin(hostname, apiKey);
    expect(checkin1.status).toBe(200);
    expect(checkin1.body.device_id).toBe(deviceId);
    expect(checkin1.body.status).toBe('active');
    // No pending commands for a fresh active device.
    expect(checkin1.body.command).toBeNull();

    // Verify last_checkin was persisted by fetching the device.
    const devAfterCheckin = await ctx.getDevice(deviceId);
    expect(devAfterCheckin.status).toBe(200);
    expect(devAfterCheckin.body.last_checkin).toBeTruthy();

    // --- Step 3: Flag device as stolen → status=stolen, lockdown command queued ---
    const flagRes = await ctx.flagStolen(deviceId, ctx.token, hostname);
    expect(flagRes.status).toBe(200);
    expect(flagRes.body.device.status).toBe('stolen');
    expect(flagRes.body.command).toBeDefined();
    expect(flagRes.body.command.command_type).toBe('lockdown');
    expect(flagRes.body.command.status).toBe('pending');
    const lockdownCmdId = flagRes.body.command.id;

    // Verify device status transitioned active → stolen.
    const devStolen = await ctx.getDevice(deviceId);
    expect(devStolen.status).toBe(200);
    expect(devStolen.body.status).toBe('stolen');

    // --- Step 4: Agent polls → receives the lockdown command ---
    const checkin2 = await ctx.agentCheckin(hostname, apiKey);
    expect(checkin2.status).toBe(200);
    expect(checkin2.body.command).not.toBeNull();
    expect(checkin2.body.command.id).toBe(lockdownCmdId);
    expect(checkin2.body.command.type).toBe('lockdown');

    // --- Step 5: Agent ACKs lockdown → command completed, key stored ---
    const fernetKey = 'e2e-fernet-key-base64-AAAA====';
    const ackRes = await ctx.ackCommand(lockdownCmdId, hostname, apiKey, {
      keyMaterial: fernetKey,
    });
    expect(ackRes.status).toBe(200);
    expect(ackRes.body.ok).toBe(true);

    // --- Step 6: Verify encryption key stored on the server ---
    // The ACK inserts into encryption_keys. Confirm via a direct DB query
    // (the API doesn't expose raw keys, so we probe the pool).
    const keyRow = await ctx.pool.query(
      'SELECT * FROM encryption_keys WHERE device_id = ? ORDER BY created_at DESC LIMIT 1',
      [deviceId]
    );
    expect(keyRow.rows.length).toBeGreaterThanOrEqual(1);
    // CC16 dual-mode: plaintext column is populated by the ACK handler.
    expect(keyRow.rows[0].key_material).toBe(fernetKey);
    expect(keyRow.rows[0].released_at).toBeFalsy();

    // --- Step 7: Verify the lockdown command is now completed ---
    const cmdRow = await ctx.pool.query(
      'SELECT * FROM commands WHERE id = ?',
      [lockdownCmdId]
    );
    expect(cmdRow.rows[0].status).toBe('executed');
    expect(cmdRow.rows[0].executed_at).toBeTruthy();

    // After a lockdown ACK, the device transitions stolen → locked.
    const devLocked = await ctx.getDevice(deviceId);
    expect(devLocked.body.status).toBe('locked');

    // --- Step 8: Verify audit log has entries for each major step ---
    const auditRes = await ctx.getAuditLog(ctx.token, deviceId);
    expect(auditRes.status).toBe(200);
    const actions = auditRes.body.map((a) => a.action);
    expect(actions).toContain('device_enrolled');
    expect(actions).toContain('flag_stolen');
    expect(actions).toContain('agent_lockdown_confirmed');
  }, 30000);

  test('device status transitions active → stolen → locked across the lockdown flow', async () => {
    const enrollRes = await ctx.createDevice('Bob', 'E2E-STATUS-001');
    const deviceId = enrollRes.body.id;
    const apiKey = enrollRes.body.api_key;
    const hostname = enrollRes.body.hostname;

    // active
    let dev = await ctx.getDevice(deviceId);
    expect(dev.body.status).toBe('active');

    // flag stolen → stolen
    const flagRes = await ctx.flagStolen(deviceId, ctx.token, hostname);
    expect(flagRes.status).toBe(200);
    dev = await ctx.getDevice(deviceId);
    expect(dev.body.status).toBe('stolen');

    // agent receives + ACKs lockdown → locked
    const checkin = await ctx.agentCheckin(hostname, apiKey);
    const cmdId = checkin.body.command.id;
    const ackRes = await ctx.ackCommand(cmdId, hostname, apiKey, {
      keyMaterial: 'e2e-status-key-base64==',
    });
    expect(ackRes.status).toBe(200);
    dev = await ctx.getDevice(deviceId);
    expect(dev.body.status).toBe('locked');
  }, 30000);

  test('flagging an already-stolen device is rejected (idempotency guard)', async () => {
    const enrollRes = await ctx.createDevice('Carol', 'E2E-IDEMPOTENT-001');
    const deviceId = enrollRes.body.id;
    const hostname = enrollRes.body.hostname;

    const flag1 = await ctx.flagStolen(deviceId, ctx.token, hostname);
    expect(flag1.status).toBe(200);

    const flag2 = await ctx.flagStolen(deviceId, ctx.token, hostname);
    expect(flag2.status).toBe(409);
  }, 30000);
});
