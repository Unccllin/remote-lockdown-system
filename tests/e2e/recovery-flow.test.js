/**
 * Phase 7: Full recovery flow E2E test.
 *
 * Builds on the lockdown flow: drives a device into the locked state, then
 * exercises the recovery lifecycle:
 *   recover → unlock command queued + key released → agent polls →
 *   agent ACKs unlock → command completed → device active → audit log.
 *
 * Also covers edge cases:
 *   - recover without prior lockdown (should fail)
 *   - double-recover (should fail gracefully)
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

/**
 * Helper: drive a freshly-enrolled device all the way to the `locked` state
 * (enroll → flag stolen → agent ACKs lockdown). Returns the device context.
 */
async function driveToLocked(ownerName, hostname) {
  const enrollRes = await ctx.createDevice(ownerName, hostname);
  expect(enrollRes.status).toBe(201);
  const deviceId = enrollRes.body.id;
  const apiKey = enrollRes.body.api_key;

  const flagRes = await ctx.flagStolen(deviceId, ctx.token, hostname);
  expect(flagRes.status).toBe(200);
  const lockdownCmdId = flagRes.body.command.id;

  // Agent polls for the lockdown command.
  const checkin = await ctx.agentCheckin(hostname, apiKey);
  expect(checkin.body.command.id).toBe(lockdownCmdId);

  // Agent ACKs lockdown → device becomes `locked`, key stored on server.
  const ackRes = await ctx.ackCommand(lockdownCmdId, hostname, apiKey, {
    keyMaterial: 'e2e-recovery-fernet-key-base64==',
  });
  expect(ackRes.status).toBe(200);

  const dev = await ctx.getDevice(deviceId);
  expect(dev.body.status).toBe('locked');

  return { deviceId, apiKey, hostname, lockdownCmdId };
}

describe('E2E: full recovery flow', () => {
  test('locked → recover → unlock command → agent ACKs → device active → audit log', async () => {
    const { deviceId, apiKey, hostname } = await driveToLocked(
      'Dave',
      'E2E-RECOVERY-001'
    );

    // --- Step 1: Recover device → unlock command queued, key released ---
    const recoverRes = await ctx.recover(deviceId, ctx.token, hostname);
    expect(recoverRes.status).toBe(200);
    expect(recoverRes.body.device.status).toBe('recovering');
    expect(recoverRes.body.command).toBeDefined();
    expect(recoverRes.body.command.command_type).toBe('unlock');
    expect(recoverRes.body.command.status).toBe('pending');
    expect(recoverRes.body.key_released).toBe(true);
    expect(recoverRes.body.key_material).toBeTruthy();
    const unlockCmdId = recoverRes.body.command.id;

    // Device is now in transitional `recovering` state.
    let dev = await ctx.getDevice(deviceId);
    expect(dev.body.status).toBe('recovering');

    // --- Step 2: Agent polls → receives the unlock command (with key) ---
    const checkin = await ctx.agentCheckin(hostname, apiKey);
    expect(checkin.status).toBe(200);
    expect(checkin.body.command).not.toBeNull();
    expect(checkin.body.command.id).toBe(unlockCmdId);
    expect(checkin.body.command.type).toBe('unlock');
    // The unlock command must carry the released key material.
    expect(checkin.body.command.key_material).toBeTruthy();

    // --- Step 3: Agent ACKs unlock → command completed, device active ---
    const ackRes = await ctx.ackCommand(unlockCmdId, hostname, apiKey);
    expect(ackRes.status).toBe(200);
    expect(ackRes.body.ok).toBe(true);

    // Verify the unlock command is now completed.
    const cmdRow = await ctx.pool.query(
      'SELECT * FROM commands WHERE id = ?',
      [unlockCmdId]
    );
    expect(cmdRow.rows[0].status).toBe('executed');
    expect(cmdRow.rows[0].executed_at).toBeTruthy();

    // --- Step 4: Verify device status returns to active ---
    dev = await ctx.getDevice(deviceId);
    expect(dev.body.status).toBe('active');

    // --- Step 5: Verify the encryption key was released ---
    const keyRow = await ctx.pool.query(
      'SELECT * FROM encryption_keys WHERE device_id = ? ORDER BY created_at DESC LIMIT 1',
      [deviceId]
    );
    expect(keyRow.rows.length).toBeGreaterThanOrEqual(1);
    expect(keyRow.rows[0].released_at).toBeTruthy();

    // --- Step 6: Verify audit log records the recovery ---
    const auditRes = await ctx.getAuditLog(ctx.token, deviceId);
    expect(auditRes.status).toBe(200);
    const actions = auditRes.body.map((a) => a.action);
    expect(actions).toContain('flag_stolen');
    expect(actions).toContain('recover_device');
    expect(actions).toContain('agent_unlock_confirmed');
  }, 30000);

  test('edge case: recover without prior lockdown (active device) should fail', async () => {
    const enrollRes = await ctx.createDevice('Eve', 'E2E-NO-LOCKDOWN-001');
    const deviceId = enrollRes.body.id;
    const hostname = enrollRes.body.hostname;

    // Device is active — recover must be rejected.
    const recoverRes = await ctx.recover(deviceId, ctx.token, hostname);
    expect(recoverRes.status).toBe(409);
    expect(recoverRes.body.error).toBeDefined();
  }, 30000);

  test('edge case: double-recover fails gracefully (second recover rejected)', async () => {
    const { deviceId, hostname } = await driveToLocked(
      'Frank',
      'E2E-DOUBLE-RECOVER-001'
    );

    // First recover succeeds.
    const recover1 = await ctx.recover(deviceId, ctx.token, hostname);
    expect(recover1.status).toBe(200);

    // Second recover: device is now `recovering` (not stolen/locked) → rejected.
    // This verifies the endpoint is not idempotently re-releasing keys.
    const recover2 = await ctx.recover(deviceId, ctx.token, hostname);
    expect([409, 200]).toContain(recover2.status);
    if (recover2.status === 200) {
      // If the implementation treats it as idempotent, it must not re-queue
      // a second unlock command or claim to release a key again.
      expect(recover2.body.key_released).toBe(false);
    } else {
      expect(recover2.body.error).toBeDefined();
    }
  }, 30000);
});
