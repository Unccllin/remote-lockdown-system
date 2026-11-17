import { describe, it, expect } from 'vitest';
import {
  BOOT_LOCK_REASON_TEXT,
  describeBootLockReason,
} from '../src/utils/bootLockReason';

/**
 * The agent sends a machine-readable reason when a boot-lock layer cannot apply (S271);
 * these tests pin the two behaviours that matter to an operator: a known reason reads as
 * English, and an unknown one is shown verbatim.
 *
 * The second half is the important one. Swallowing an unrecognised code would recreate the
 * dead end the field exists to fix — the panel would say "boot lock partial" and nothing else.
 */
describe('describeBootLockReason', () => {
  it('explains the measured MOLE case', () => {
    const text = describeBootLockReason('existing_bios_password_without_uefi_password');
    expect(text).toBe(
      BOOT_LOCK_REASON_TEXT.existing_bios_password_without_uefi_password,
    );
    expect(text).toMatch(/already has a BIOS Setup password/i);
    expect(text).toMatch(/rolled back/i);
  });

  it('explains a missing-admin refusal', () => {
    expect(describeBootLockReason('requires_admin')).toMatch(/administrator rights/i);
  });

  it('shows an unrecognised reason instead of hiding it', () => {
    const text = describeBootLockReason('some_future_reason');
    expect(text).toContain('some_future_reason');
  });

  it('returns null when there is no reason to show', () => {
    expect(describeBootLockReason(null)).toBeNull();
    expect(describeBootLockReason(undefined)).toBeNull();
    expect(describeBootLockReason('')).toBeNull();
    expect(describeBootLockReason(42)).toBeNull();
  });
});
