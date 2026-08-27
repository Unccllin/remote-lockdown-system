import api from './client';

/**
 * Client-side alert derivation — no backend changes needed.
 * Derives alerts from existing /devices and /audit endpoints.
 *
 * Alert types:
 * - missed_checkin: device hasn't checked in >24h
 * - location_jump: device moved >100km between last two location reports
 * - failed_unlock: audit entries with unlock-failed actions
 */

const DISMISS_KEY = 'fleetguard-dismissed-alerts';

/** Haversine distance in km between two lat/lon points. */
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const SEVERITY = {
  missed_checkin: { level: 'amber', label: 'Missed Check-in' },
  location_jump: { level: 'red', label: 'Unexpected Location Jump' },
  failed_unlock: { level: 'red', label: 'Failed Unlock Attempt' },
};

export function getSeverity(alertType) {
  return SEVERITY[alertType] || { level: 'slate', label: 'Alert' };
}

/** Get dismissed alert IDs from localStorage. */
export function getDismissedAlertIds() {
  try {
    return JSON.parse(localStorage.getItem(DISMISS_KEY) || '[]');
  } catch {
    return [];
  }
}

/** Dismiss an alert by ID (persisted in localStorage). */
export function dismissAlert(id) {
  const dismissed = getDismissedAlertIds();
  if (!dismissed.includes(id)) {
    dismissed.push(id);
    localStorage.setItem(DISMISS_KEY, JSON.stringify(dismissed));
  }
}

/** Clear all dismissed alerts (for testing). */
export function _clearDismissed() {
  localStorage.removeItem(DISMISS_KEY);
}

/**
 * Fetch and derive alerts from existing API endpoints.
 * @returns {Promise<Array>} array of alert objects with:
 *   { id, type, severity, device_id, hostname, message, timestamp }
 */
export async function getAlerts() {
  const alerts = [];

  try {
    const [devRes, auditRes] = await Promise.all([
      api.get('/devices'),
      api.get('/audit?limit=100'),
    ]);
    const devices = Array.isArray(devRes.data) ? devRes.data : [];
    const audit = Array.isArray(auditRes.data) ? auditRes.data : [];

    const now = Date.now();
    const HOURS_24 = 24 * 60 * 60 * 1000;

    // 1. Missed check-in — device hasn't checked in >24h
    for (const d of devices) {
      if (d.status === 'active' && d.last_checkin) {
        const elapsed = now - new Date(d.last_checkin).getTime();
        if (elapsed > HOURS_24) {
          alerts.push({
            id: `missed_checkin_${d.id}`,
            type: 'missed_checkin',
            device_id: d.id,
            hostname: d.hostname,
            message: `Last check-in ${Math.round(elapsed / HOURS_24 * 24)}h ago`,
            timestamp: d.last_checkin,
          });
        }
      } else if (d.status === 'active' && !d.last_checkin) {
        alerts.push({
          id: `missed_checkin_${d.id}`,
          type: 'missed_checkin',
          device_id: d.id,
          hostname: d.hostname,
          message: 'Never checked in',
          timestamp: d.enrolled_at || new Date().toISOString(),
        });
      }
    }

    // 2. Failed unlock attempts — audit entries with unlock-failed actions
    for (const entry of audit) {
      if (
        entry.action?.includes('unlock') &&
        entry.action?.includes('fail')
      ) {
        alerts.push({
          id: `failed_unlock_${entry.id}`,
          type: 'failed_unlock',
          device_id: entry.device_id,
          hostname: entry.hostname,
          message: `Failed unlock attempt on ${entry.hostname || 'device'}`,
          timestamp: entry.timestamp,
        });
      }
    }

    // 3. Location jumps — fetch location history for each device
    await Promise.all(
      devices.map(async (d) => {
        try {
          const { data: locs } = await api.get(
            `/devices/${d.id}/locations?limit=10`,
          );
          if (Array.isArray(locs) && locs.length >= 2) {
            // Compare the two most recent locations
            const [latest, prev] = locs;
            if (
              latest.latitude != null &&
              latest.longitude != null &&
              prev.latitude != null &&
              prev.longitude != null
            ) {
              const dist = haversineKm(
                prev.latitude,
                prev.longitude,
                latest.latitude,
                latest.longitude,
              );
              if (dist > 100) {
                alerts.push({
                  id: `location_jump_${d.id}_${latest.reported_at}`,
                  type: 'location_jump',
                  device_id: d.id,
                  hostname: d.hostname,
                  message: `Moved ${Math.round(dist)}km between check-ins`,
                  timestamp: latest.reported_at,
                });
              }
            }
          }
        } catch {
          // ignore devices with no location data
        }
      }),
    );
  } catch {
    // API failure — return empty alerts
  }

  // Sort by timestamp descending
  alerts.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  return alerts;
}

/**
 * Get undismissed alert count (for the notification bell).
 * @returns {Promise<number>}
 */
export async function getUnreadAlertCount() {
  const alerts = await getAlerts();
  const dismissed = getDismissedAlertIds();
  return alerts.filter((a) => !dismissed.includes(a.id)).length;
}
