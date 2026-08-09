/**
 * Phase 13: Notification module.
 *
 * sendNotification(eventType, payload) — async, fire-and-forget.
 *
 * Checks configured channels via env vars and dispatches to all that are
 * configured:
 *   - NOTIFICATION_WEBHOOK_URL  — generic HTTP POST with JSON
 *                                 { eventType, timestamp, payload }
 *   - SLACK_WEBHOOK_URL         — Slack incoming webhook (formatted message)
 *   - NOTIFICATION_EMAIL_*      — SMTP email via nodemailer
 *       (SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, EMAIL_FROM, EMAIL_TO)
 *
 * If no channels are configured, logs to console (no error).
 * NEVER throws — all errors are caught and logged.
 * Returns true if at least one notification was sent, false otherwise.
 *
 * Notifications are async and fire-and-forget: callers should not await this
 * for request-critical paths (the alert scheduler does await it, which is fine
 * since it runs in the background).
 */

let nodemailer = null;
try {
  // nodemailer is an optional dependency — degrade gracefully if absent.
  nodemailer = require('nodemailer');
} catch (_err) {
  nodemailer = null;
}

const logger = require('../logger');

/**
 * Send a notification to the generic webhook (NOTIFICATION_WEBHOOK_URL).
 * @returns {Promise<boolean>} true if sent
 */
async function sendWebhook(eventType, payload) {
  const url = process.env.NOTIFICATION_WEBHOOK_URL;
  if (!url) return false;

  const body = JSON.stringify({
    eventType,
    timestamp: new Date().toISOString(),
    payload,
  });

  try {
    // Use global fetch (Node 18+) — fall back to require('http') if needed.
    if (typeof fetch === 'function') {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      if (!res.ok) {
        logger.error('[notify] webhook returned %s %s', res.status, res.statusText);
      }
    } else {
      // Fallback for environments without global fetch.
      const { default: axios } = await import('axios').catch(() => ({}));
      if (axios) {
        await axios.post(url, body, {
          headers: { 'Content-Type': 'application/json' },
        });
      } else {
        logger.error('[notify] no HTTP client available for webhook');
        return false;
      }
    }
    return true;
  } catch (err) {
    logger.error({ err }, '[notify] webhook send failed');
    return false;
  }
}

/**
 * Send a notification to a Slack incoming webhook (SLACK_WEBHOOK_URL).
 * @returns {Promise<boolean>} true if sent
 */
async function sendSlack(eventType, payload) {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) return false;

  const text = `*[${eventType}]* ${JSON.stringify(payload)}`;
  const body = JSON.stringify({ text });

  try {
    if (typeof fetch === 'function') {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      if (!res.ok) {
        logger.error('[notify] slack webhook returned %s %s', res.status, res.statusText);
      }
    } else {
      logger.error('[notify] no HTTP client available for slack webhook');
      return false;
    }
    return true;
  } catch (err) {
    logger.error({ err }, '[notify] slack send failed');
    return false;
  }
}

/**
 * Send an email notification via SMTP (NOTIFICATION_EMAIL_*).
 * Requires SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, EMAIL_FROM, EMAIL_TO.
 * @returns {Promise<boolean>} true if sent
 */
async function sendEmail(eventType, payload) {
  const {
    SMTP_HOST,
    SMTP_PORT,
    SMTP_USER,
    SMTP_PASS,
    EMAIL_FROM,
    EMAIL_TO,
  } = process.env;

  // Only send email if all required vars are present.
  if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASS || !EMAIL_FROM || !EMAIL_TO) {
    return false;
  }

  if (!nodemailer) {
    logger.error('[notify] nodemailer not installed — skipping email notification');
    return false;
  }

  try {
    const transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: parseInt(SMTP_PORT, 10),
      secure: parseInt(SMTP_PORT, 10) === 465,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    });

    const subject = `[Lockdown] ${eventType}`;
    const text = `Event: ${eventType}\nTimestamp: ${new Date().toISOString()}\n\nPayload:\n${JSON.stringify(payload, null, 2)}`;

    await transporter.sendMail({
      from: EMAIL_FROM,
      to: EMAIL_TO,
      subject,
      text,
    });
    return true;
  } catch (err) {
    logger.error({ err }, '[notify] email send failed');
    return false;
  }
}

/**
 * Send a notification for an event to all configured channels.
 *
 * Async, fire-and-forget semantics: never throws. Returns true if at least
 * one channel successfully sent, false otherwise.
 *
 * @param {string} eventType — e.g. 'device_stale', 'health_degraded'
 * @param {object} payload — event-specific data
 * @returns {Promise<boolean>}
 */
async function sendNotification(eventType, payload) {
  // If no channels are configured at all, log and return false (no error).
  const hasWebhook = !!process.env.NOTIFICATION_WEBHOOK_URL;
  const hasSlack = !!process.env.SLACK_WEBHOOK_URL;
  const hasEmail = !!(
    process.env.SMTP_HOST &&
    process.env.SMTP_PORT &&
    process.env.SMTP_USER &&
    process.env.SMTP_PASS &&
    process.env.EMAIL_FROM &&
    process.env.EMAIL_TO
  );

  if (!hasWebhook && !hasSlack && !hasEmail) {
    logger.info({ payload }, '[notify] no channels configured — event: %s', eventType);
    return false;
  }

  // Dispatch to all configured channels in parallel. Each catches its own
  // errors, so a failure in one doesn't affect the others.
  const results = await Promise.all([
    sendWebhook(eventType, payload),
    sendSlack(eventType, payload),
    sendEmail(eventType, payload),
  ]);

  const sent = results.some((r) => r === true);
  return sent;
}

module.exports = { sendNotification };
