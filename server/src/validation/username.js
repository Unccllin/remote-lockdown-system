/**
 * The one definition of a valid admin username.
 *
 * Why this exists
 * ---------------
 * Three routes each had their own rule, and they disagreed:
 *
 *   routes/auth.js   (login)         /^[a-zA-Z0-9_@.-]+$/, no trim
 *   routes/setup.js  (create-admin)  /^[a-zA-Z0-9_-]+$/,    no trim
 *   routes/admins.js (create admin)  /^[a-zA-Z0-9_-]+$/,    no trim
 *
 * So a username containing `@` or `.` could be created by one path and rejected
 * by another, and any username with a leading or trailing space — trivial to
 * introduce by copy-paste or browser autocomplete — failed with "username
 * contains invalid characters", which reads like a wrong credential rather than
 * like whitespace. That is exactly how the first login on a freshly set-up
 * machine failed (S203).
 *
 * Contract:
 *   - the value is TRIMMED before use (a padded username is the same account);
 *   - allowed characters are letters, digits, `_`, `@`, `.`, `-`;
 *   - length is 3-100 for creation. Login accepts shorter values because a
 *     legacy account must still be able to sign in — validation at creation is
 *     what guarantees future usernames meet the bound.
 *
 * The password is deliberately NOT trimmed anywhere: whitespace in a password
 * can be intentional, and silently changing it would lock people out.
 */

const USERNAME_PATTERN = /^[a-zA-Z0-9_@.-]+$/;
const USERNAME_MIN = 3;
const USERNAME_MAX = 100;

/**
 * @param {unknown} raw
 * @param {{ enforceLength?: boolean }} [options]
 * @returns {{ ok: true, value: string } | { ok: false, error: string }}
 */
function normalizeUsername(raw, options = {}) {
  const { enforceLength = true } = options;

  if (typeof raw !== 'string') {
    return { ok: false, error: 'username must be a string.' };
  }

  const value = raw.trim();

  if (value.length === 0) {
    return { ok: false, error: 'username is required.' };
  }
  if (enforceLength && (value.length < USERNAME_MIN || value.length > USERNAME_MAX)) {
    return {
      ok: false,
      error: `username must be ${USERNAME_MIN}-${USERNAME_MAX} characters.`,
    };
  }
  if (value.length > USERNAME_MAX) {
    return { ok: false, error: `username must be at most ${USERNAME_MAX} characters.` };
  }
  if (!USERNAME_PATTERN.test(value)) {
    return {
      ok: false,
      error:
        'username may contain only letters, numbers, and the characters _ @ . - ' +
        '(no spaces or other punctuation).',
    };
  }

  return { ok: true, value };
}

module.exports = { normalizeUsername, USERNAME_PATTERN, USERNAME_MIN, USERNAME_MAX };
