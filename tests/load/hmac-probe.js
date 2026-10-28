// hmac-probe.js — prove that a running server actually ENFORCES HMAC signatures.
//
// A load run with the wrong K6_HMAC_SECRET fails at authentication (unknown
// x-agent-key) before signatures are examined, so it does not prove signature
// enforcement. This probe uses the right key and then breaks one thing at a
// time: signature, timestamp, key, and nonce replay.
//
// Usage (server must run with REQUIRE_HMAC=true and devices seeded with
// --hmac-secret <same secret>):
//   node tests/load/hmac-probe.js
//   BASE=http://127.0.0.1:3001 K6_HMAC_SECRET=... node tests/load/hmac-probe.js
//
// Derivation is the same one tests/load/lib/sign.js uses.
const crypto = require('crypto');

const BASE = process.env.BASE || 'http://<tailnet-ip>:3001';
const SECRET = process.env.K6_HMAC_SECRET || 'hmac-load-2026';
const VU = 1;
const idx = String(VU).padStart(5, '0');
const hostname = `load-test-device-${idx}`;

const apiKey = crypto.createHmac('sha256', SECRET).update(hostname).digest('base64');
const body = JSON.stringify({
  hostname,
  mac_address: `02:00:00:00:00:${String(VU & 0xff).padStart(2, '0')}`,
  hardware_uuid: `00000000-0000-4000-8000-${String(VU).padStart(12, '0')}`,
});

function headers({ key = apiKey, ts = Math.floor(Date.now() / 1000), tamper = null } = {}) {
  const nonce = crypto.randomBytes(16).toString('hex');
  const bodyHash = crypto.createHash('sha256').update(body).digest('hex');
  let sig = crypto.createHmac('sha256', key).update(`${ts}:${nonce}:${bodyHash}`).digest('hex');
  if (tamper === 'signature') sig = sig.slice(0, -2) + (sig.endsWith('00') ? '11' : '00');
  return {
    'Content-Type': 'application/json',
    'x-agent-key': key,
    'x-timestamp': String(ts),
    'x-nonce': nonce,
    'x-signature': sig,
    'x-sig-version': 'v1',
  };
}

async function probe(label, opts, expectStatus, expectText) {
  const res = await fetch(`${BASE}/api/agent/checkin`, {
    method: 'POST',
    headers: headers(opts),
    body,
  });
  const text = await res.text();
  const ok = res.status === expectStatus && (!expectText || text.includes(expectText));
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(34)} ${res.status}  ${text.slice(0, 90)}`
  );
  return ok;
}

(async () => {
  const results = [];
  results.push(await probe('correct signature', {}, 200, ''));
  results.push(await probe('corrupted signature', { tamper: 'signature' }, 401, 'signature mismatch'));
  results.push(await probe('stale timestamp', { ts: 1 }, 401, 'timestamp'));
  results.push(await probe('unknown key', { key: crypto.randomBytes(32).toString('base64') }, 401, ''));

  // Replay: reuse one nonce twice.
  const h = headers();
  const first = await fetch(`${BASE}/api/agent/checkin`, { method: 'POST', headers: h, body });
  const second = await fetch(`${BASE}/api/agent/checkin`, { method: 'POST', headers: h, body });
  const replayOk = first.status === 200 && second.status === 401;
  console.log(
    `${replayOk ? 'PASS' : 'FAIL'}  ${'replayed nonce'.padEnd(34)} ${first.status} then ${second.status}`
  );
  results.push(replayOk);

  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} probes behaved as expected`);
  process.exit(passed === results.length ? 0 : 1);
})();
