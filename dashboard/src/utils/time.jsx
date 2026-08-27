import { formatDistanceToNow, format } from 'date-fns';

/**
 * Safe wrappers around date-fns functions that guard against
 * undefined/null/invalid date values. Returns a fallback string
 * instead of throwing "Invalid time value".
 */

function isValidDate(d) {
  return d instanceof Date && !isNaN(d.getTime());
}

export function safeFromNow(value, fallback = '—') {
  if (!value) return fallback;
  const d = new Date(value);
  if (!isValidDate(d)) return fallback;
  try {
    return formatDistanceToNow(d, { addSuffix: true });
  } catch {
    return fallback;
  }
}

export function safeFormat(value, pattern, fallback = '—') {
  if (!value) return fallback;
  const d = new Date(value);
  if (!isValidDate(d)) return fallback;
  try {
    return format(d, pattern);
  } catch {
    return fallback;
  }
}
