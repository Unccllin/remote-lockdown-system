/**
 * Alert tick for the serverless deployment (S349).
 *
 * The Node server runs this as an in-process loop (`server/src/jobs/alertScheduler.js`) and
 * remembers which devices it has already alerted about in a `Set`, cleared when the device
 * checks in again. A Worker has neither a loop nor process memory, so the equivalent is a cron
 * trigger plus a per-device marker in KV that expires on its own.
 *
 * The dedupe window is a deliberate trade. Clearing the marker on check-in would be exact, but
 * it would put a KV delete on the hottest write path in the system — every poll, every device —
 * and writes are the expensive primitive here (docs/SERVERLESS-COST.md). A repeat window costs
 * nothing on the poll path, and its only cost is that a device which recovers and goes stale
 * again inside the window alerts once instead of twice. Bounded repeat beats unbounded cost.
 *
 * Scope is deliberately the same as the Node scheduler's device check: `device_stale`, with the
 * same audit action (`health_alert`), the same detail shape and the same notification payload.
 * The Node server's other alert is database health, which has no meaning in a Worker.
 */
import { addAuditEntry, listDevices } from './kv-store';
import type { Device } from './kv-store';
import type { Env } from './pbl/env';

/** Matches the Node server's default: 2x the 300 s baseline poll interval. */
export const DEFAULT_STALE_THRESHOLD_SEC = 600;
export const DEFAULT_ALERT_REPEAT_HOURS = 24;

const ALERT_KEY_PREFIX = 'alert:';

export function staleThresholdSeconds(env: Env): number {
  const raw = Number.parseInt(String(env.STALE_DEVICE_THRESHOLD_SEC ?? ''), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_STALE_THRESHOLD_SEC;
}

export function alertRepeatHours(env: Env): number {
  const raw = Number.parseInt(String(env.ALERT_REPEAT_HOURS ?? ''), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_ALERT_REPEAT_HOURS;
}

export interface DeviceAlert {
  eventType: 'device_stale';
  deviceId: string;
  hostname: string;
  lastCheckin: string;
  reason: 'stale_checkin';
}

/**
 * Devices whose last check-in is older than the threshold.
 *
 * A device that has never checked in is NOT stale, on purpose: it has just been enrolled, or
 * it never installed, and alerting on that would fire for every device between enrolment and
 * first contact — which is how an alert becomes something people mute.
 */
export function computeStaleAlerts(
  devices: Device[],
  now: number,
  thresholdSeconds: number = DEFAULT_STALE_THRESHOLD_SEC,
): DeviceAlert[] {
  const cutoff = now - thresholdSeconds * 1000;
  const alerts: DeviceAlert[] = [];
  for (const device of devices) {
    if (!device.last_checkin) continue;
    const last = Date.parse(String(device.last_checkin));
    if (!Number.isFinite(last) || last >= cutoff) continue;
    alerts.push({
      eventType: 'device_stale',
      deviceId: device.id,
      hostname: device.hostname,
      lastCheckin: String(device.last_checkin),
      reason: 'stale_checkin',
    });
  }
  return alerts;
}

export interface NotificationResult {
  webhook: boolean;
  slack: boolean;
  error?: string;
}

/**
 * Deliver one notification to the configured channels.
 *
 * The wire shapes match the Node server's `notifications/notify.js`: the generic webhook gets
 * `{ eventType, timestamp, payload }`, Slack gets a formatted message. Never throws — a failed
 * alert must not fail the cron, because then retention (which shares this tick) would stop too.
 */
export async function sendNotification(
  env: Env,
  eventType: string,
  payload: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
): Promise<NotificationResult> {
  const result: NotificationResult = { webhook: false, slack: false };
  const timestamp = new Date().toISOString();

  const webhookUrl = env.NOTIFICATION_WEBHOOK_URL;
  if (webhookUrl) {
    try {
      const res = await fetchImpl(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventType, timestamp, payload }),
      });
      result.webhook = res.ok;
      if (!res.ok) result.error = `webhook responded ${res.status}`;
    } catch (error) {
      result.error = `webhook failed: ${String(error)}`;
    }
  }

  const slackUrl = env.SLACK_WEBHOOK_URL;
  if (slackUrl) {
    try {
      const res = await fetchImpl(slackUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: `*[${eventType}]* ${JSON.stringify(payload)}` }),
      });
      result.slack = res.ok;
      if (!res.ok && !result.error) result.error = `slack responded ${res.status}`;
    } catch (error) {
      if (!result.error) result.error = `slack failed: ${String(error)}`;
    }
  }

  return result;
}

export interface AlertTickResult {
  stale: number;
  alerted: number;
  suppressed: number;
  notified: number;
  failed: number;
}

/**
 * One pass: find stale devices, alert the ones not alerted recently, record and deliver.
 *
 * Returns counts rather than throwing, so the cron handler can report what happened and still
 * run the retention pass afterwards.
 */
export async function runAlertTick(
  env: Env,
  now: number = Date.now(),
  fetchImpl: typeof fetch = fetch,
): Promise<AlertTickResult> {
  const devices = await listDevices(env);
  const threshold = staleThresholdSeconds(env);
  const repeatSeconds = Math.max(60, alertRepeatHours(env) * 3600);
  const alerts = computeStaleAlerts(devices, now, threshold);

  const result: AlertTickResult = {
    stale: alerts.length,
    alerted: 0,
    suppressed: 0,
    notified: 0,
    failed: 0,
  };

  for (const alert of alerts) {
    const markerKey = `${ALERT_KEY_PREFIX}${alert.eventType}:${alert.deviceId}`;
    const seen = await env.LOCKDOWN_KV.get(markerKey);
    if (seen !== null) {
      result.suppressed += 1;
      continue;
    }

    // Marker first: if the notification below fails, the operator still has the audit entry,
    // and a retry storm cannot fan out from a webhook that is down.
    await env.LOCKDOWN_KV.put(markerKey, new Date(now).toISOString(), {
      expirationTtl: repeatSeconds,
    });

    await addAuditEntry(
      env,
      alert.deviceId,
      'health_alert',
      JSON.stringify({
        deviceId: alert.deviceId,
        hostname: alert.hostname,
        lastCheckin: alert.lastCheckin,
        reason: alert.reason,
      }),
    );

    const delivered = await sendNotification(env, alert.eventType, {
      deviceId: alert.deviceId,
      hostname: alert.hostname,
      lastCheckin: alert.lastCheckin,
    }, fetchImpl);

    result.alerted += 1;
    if (delivered.webhook || delivered.slack) result.notified += 1;
    // No channel configured is not a failure: alerts are logged and audited either way, which
    // is what the Node server does when no notification env is set.
    if (delivered.error) result.failed += 1;
  }

  return result;
}

/** True when at least one delivery channel is configured. */
export function alertsConfigured(env: Env): boolean {
  return Boolean(env.NOTIFICATION_WEBHOOK_URL || env.SLACK_WEBHOOK_URL);
}
