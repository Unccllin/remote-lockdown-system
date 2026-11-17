/**
 * Human text for the machine-readable boot-lock reason the agent sends.
 *
 * The agent reports `boot_lock_detail.reason` when a layer cannot apply, and
 * `next_action` beside it when there is something the operator can do (S271). The map exists
 * so the panel reads as English; an unknown reason is shown verbatim, deliberately — a reason
 * added on the agent side must be visible without a dashboard change, and a silent "unknown"
 * would be the same dead end the field was added to fix.
 */
export const BOOT_LOCK_REASON_TEXT = {
  existing_bios_password_without_uefi_password:
    'The firmware already has a BIOS Setup password, and the agent has none configured, so the ' +
    'BIOS layers were skipped and the boot changes were rolled back.',
  requires_admin: 'The agent was not running with administrator rights, so it changed nothing.',
  setup_password_write_failed: 'The BIOS refused the Setup-password write.',
};

/**
 * A sentence for a boot-lock reason, or null when there is no reason to show.
 *
 * @param {string|null|undefined} reason machine-readable code from the agent
 * @returns {string|null}
 */
export function describeBootLockReason(reason) {
  if (!reason || typeof reason !== 'string') return null;
  return BOOT_LOCK_REASON_TEXT[reason] || `Unrecognised boot-lock reason: ${reason}`;
}
