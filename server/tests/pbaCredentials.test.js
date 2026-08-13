const { groupPbaCredentials } = require('../src/db/pbaCredentials');

describe('groupPbaCredentials', () => {
  test('returns all nulls for empty rows', () => {
    const result = groupPbaCredentials([]);
    expect(result).toEqual({
      setup_password: null,
      power_on_password: null,
      bitlocker_pin: null,
      bitlocker_recovery_password: null,
    });
  });

  test('maps one of each type correctly', () => {
    const rows = [
      { password: 'SetupPw', password_type: 'setup' },
      { password: 'PopPw', password_type: 'power_on' },
      { password: '123456', password_type: 'bitlocker_pin' },
      { password: '111111-222222-333333-444444-555555-666666-777777-888888', password_type: 'bitlocker_recovery' },
    ];
    const result = groupPbaCredentials(rows);
    expect(result.setup_password).toBe('SetupPw');
    expect(result.power_on_password).toBe('PopPw');
    expect(result.bitlocker_pin).toBe('123456');
    expect(result.bitlocker_recovery_password).toBe('111111-222222-333333-444444-555555-666666-777777-888888');
  });

  test('picks most recent of each type (first in DESC-sorted rows)', () => {
    const rows = [
      { password: 'NewSetup', password_type: 'setup' },
      { password: 'OldSetup', password_type: 'setup' },
      { password: 'NewPin', password_type: 'bitlocker_pin' },
      { password: 'OldPin', password_type: 'bitlocker_pin' },
    ];
    const result = groupPbaCredentials(rows);
    expect(result.setup_password).toBe('NewSetup');
    expect(result.bitlocker_pin).toBe('NewPin');
  });

  test('defaults password_type to setup for pre-migration rows', () => {
    const rows = [
      { password: 'LegacyPw' }, // no password_type field
    ];
    const result = groupPbaCredentials(rows);
    expect(result.setup_password).toBe('LegacyPw');
    expect(result.power_on_password).toBeNull();
  });

  test('ignores unknown password types', () => {
    const rows = [
      { password: 'SetupPw', password_type: 'setup' },
      { password: 'UnknownPw', password_type: 'some_future_type' },
    ];
    const result = groupPbaCredentials(rows);
    expect(result.setup_password).toBe('SetupPw');
    // Unknown type is silently ignored
    expect(result.power_on_password).toBeNull();
    expect(result.bitlocker_pin).toBeNull();
    expect(result.bitlocker_recovery_password).toBeNull();
  });
});
