#!/usr/bin/env node
/**
 * firmware-tls-proxy.js — terminate TLS for firmware, forward to the Express API.
 *
 * Why this exists
 * ---------------
 * PblApp refuses plaintext http:// in release builds (C3 §4: "Plaintext fallback:
 * never"), so the firmware cannot talk to the Express server directly. EDK2 validates
 * the server certificate against DER certificates in the platform TlsCaCertificate
 * store, which is fed by policy key 78 (D-132), so the certificate this proxy presents
 * must be signed by the CA the policy pins.
 *
 * Usage:
 *   node scripts/firmware-tls-proxy.js \
 *     --cert /tmp/assets/server-cert.pem --key /tmp/assets/server-key.pem \
 *     --port 9443 --target http://127.0.0.1:3001
 *
 * Every request is logged with its byte count, because "the firmware reached OUR server"
 * is the fact this proxy exists to make observable.
 */

const fs = require('fs');
const http = require('http');
const https = require('https');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const certPath = arg('cert');
const keyPath = arg('key');
const target = arg('target', 'http://127.0.0.1:3001');

if (!certPath || !keyPath) {
  console.error('usage: firmware-tls-proxy.js --cert <pem> --key <pem> [--port 9443] [--target http://127.0.0.1:3001]');
  process.exit(2);
}

const port = Number(arg('port', '9443'));
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`invalid --port: ${arg('port')}`);
  process.exit(2);
}

let targetUrl;
try {
  targetUrl = new URL(target);
} catch {
  // new URL() throws TypeError on anything that is not an absolute URL.
  console.error(`invalid --target (expected scheme://host[:port]): ${target}`);
  process.exit(2);
}
if (!['http:', 'https:'].includes(targetUrl.protocol)) {
  console.error(`invalid --target protocol: ${targetUrl.protocol}`);
  process.exit(2);
}

// EDK2's TCP/TLS stack is old and opinionated. S232 proved the firmware works against a
// Python ssl server; against Node's defaults it completes the handshake and then resets
// before sending the request (S234). These knobs exist so the peer can be matched to what
// the firmware expects, one hypothesis at a time:
//   --tls12-only        cap at TLSv1.2 (EDK2 has no TLS 1.3)
//   --cipher <name>     pin the suite the firmware negotiated
//   --no-tickets        disable session tickets / resumption
const tlsOptions = {
  cert: fs.readFileSync(certPath),
  key: fs.readFileSync(keyPath),
};
if (process.argv.includes('--tls12-only')) {
  tlsOptions.maxVersion = 'TLSv1.2';
  tlsOptions.minVersion = 'TLSv1.2';
}
const cipherArg = arg('cipher');
if (cipherArg) {
  tlsOptions.ciphers = cipherArg;
  tlsOptions.honorCipherOrder = true;
}
if (process.argv.includes('--no-tickets')) {
  tlsOptions.sessionTimeout = 0;
  tlsOptions.ticketKeys = undefined;
}

const server = https.createServer(tlsOptions, (req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      // The firmware's request is the artifact: log method, path and size immediately.
      console.log(`[proxy] ${req.method} ${req.url} from ${req.socket.remoteAddress} -> ${body.length} bytes`);
      if (body.length) {
        console.log(`[proxy]   sha256=${require('crypto').createHash('sha256').update(body).digest('hex').slice(0, 16)}…`);
      }

      const upstream = http.request(
        {
          hostname: targetUrl.hostname,
          port: targetUrl.port || 80,
          path: req.url,
          method: req.method,
          headers: { ...req.headers, host: targetUrl.host, 'content-length': body.length },
        },
        (up) => {
          const out = [];
          up.on('data', (c) => out.push(c));
          up.on('end', () => {
            const payload = Buffer.concat(out);
            console.log(`[proxy] <- ${up.statusCode} ${payload.length} bytes`);
            res.writeHead(up.statusCode || 502, up.headers);
            res.end(payload);
          });
        }
      );
      upstream.on('error', (err) => {
        console.log(`[proxy] upstream error: ${err.message}`);
        res.writeHead(502).end('upstream error');
      });
      upstream.end(body);
    });
  }
);

// TLS-level events matter as much as requests: "no request logged" is ambiguous between
// "the guest never opened a connection" and "the handshake failed", and the firmware only
// says "Online fetch failed: Aborted" either way (S234).
server.on('tlsClientError', (err, socket) => {
  console.log(
    `[proxy] TLS handshake failed from ${socket?.remoteAddress || '?'}: ${err.code || err.message}`
  );
});
server.on('secureConnection', (socket) => {
  console.log(
    `[proxy] TLS established from ${socket.remoteAddress} (${socket.getProtocol()} ${socket.getCipher()?.name || '?'})`
  );
});

server.listen(port, '127.0.0.1', () => {
  console.log(`[proxy] listening on 127.0.0.1:${port} -> ${target}`);
});
