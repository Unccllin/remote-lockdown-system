/**
 * k6 Lockdown Spike Load Test
 *
 * Simulates a lockdown burst: a large fleet of agents all poll at once, each
 * receives a pending lockdown command, and each immediately ACKs it. This
 * measures the server's response time when a spike of simultaneous work hits
 * the checkin + command-ack endpoints.
 *
 * Flow per VU (per iteration):
 *   1. POST /api/agent/checkin  — may return a pending lockdown command.
 *   2. If a command is returned, POST /api/agent/command-ack with result_status
 *      'executed' (simulating the agent applying the lockdown).
 *   3. Short sleep (burst test — 1s) before the next iteration.
 *
 * Configuration (env vars):
 *   K6_VUS            — number of virtual users (default 1000)
 *   K6_DURATION       — total test duration (default 1m)
 *   K6_BASE_URL       — target server base URL (default http://localhost:3001)
 *   K6_AGENT_KEY      — agent API key sent in x-agent-key header
 *
 * Prerequisites:
 *   - The server must have N devices registered matching the VU hostnames.
 *   - Each device must have a pending 'lockdown' command queued so the checkin
 *     returns a command for the agent to ACK. Use the admin API or a seed
 *     script to enqueue lockdown commands before running this test.
 *
 * Thresholds:
 *   p95 < 1000ms, p99 < 2000ms, error rate < 2%
 *
 * Usage:
 *   k6 run tests/load/k6-lockdown-spike.js
 *   K6_VUS=2000 K6_DURATION=30s k6 run tests/load/k6-lockdown-spike.js
 */

import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE_URL = __ENV.K6_BASE_URL || 'http://localhost:3001';
const VUS = parseInt(__ENV.K6_VUS || '1000', 10);
const DURATION = __ENV.K6_DURATION || '1m';
const AGENT_KEY = __ENV.K6_AGENT_KEY || 'test-agent-key';

export const options = {
  vus: VUS,
  duration: DURATION,
  thresholds: {
    // Spike test — allow more headroom than baseline.
    http_req_duration: ['p(95)<1000', 'p(99)<2000'],
    http_req_failed: ['rate<0.02'],
  },
};

function checkinPayload(vuId) {
  const idx = String(vuId).padStart(5, '0');
  return {
    hostname: `load-test-device-${idx}`,
    mac_address: `02:00:00:${String((vuId >> 16) & 0xff).padStart(2, '0')}:${String((vuId >> 8) & 0xff).padStart(2, '0')}:${String(vuId & 0xff).padStart(2, '0')}`,
    hardware_uuid: `00000000-0000-4000-8000-${String(vuId).padStart(12, '0')}`,
  };
}

const headers = {
  'Content-Type': 'application/json',
  'x-agent-key': AGENT_KEY,
};

export default function () {
  const vuId = __VU;
  const checkinUrl = `${BASE_URL}/api/agent/checkin`;
  const ackUrl = `${BASE_URL}/api/agent/command-ack`;

  // 1. Checkin — may return a pending lockdown command.
  const checkinRes = http.post(checkinUrl, JSON.stringify(checkinPayload(vuId)), { headers });

  const checkinOk = check(checkinRes, {
    'checkin status is 200': (r) => r.status === 200,
  });

  // 2. If a command was returned, ACK it as executed.
  if (checkinOk) {
    let command = null;
    try {
      const body = checkinRes.json();
      command = body && body.command;
    } catch (e) {
      command = null;
    }

    if (command && command.id) {
      const ackPayload = JSON.stringify({
        hostname: `load-test-device-${String(vuId).padStart(5, '0')}`,
        command_id: command.id,
        result_status: 'executed',
        boot_lock_status: true,
      });

      const ackRes = http.post(ackUrl, ackPayload, { headers });

      check(ackRes, {
        'ack status is 200': (r) => r.status === 200,
        'ack ok': (r) => {
          try {
            const b = r.json();
            return b && b.ok === true;
          } catch (e) {
            return false;
          }
        },
      });
    }
  }

  // Burst test — short sleep between iterations to keep pressure high.
  sleep(1);
}
