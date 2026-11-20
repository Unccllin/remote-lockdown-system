/**
 * `/v1/*` — the firmware-facing PBL routes, in one dispatcher.
 *
 * Extracted from worker.ts (S278). Everything it calls already lived in `pbl/*`; this file is the
 * routing and validation layer over those handlers, plus per-device / per-IP rate limiting.
 */
import type { Env } from '../env';
import { errorResponse } from '../../http';
import { requireRole } from '../../admin-auth';
import { rotateSigningKey, getKidHistory } from '../signing';
import { loadCertChain, storeCertChain, splitDerCerts } from '../certs';
import { handleVerdict } from './verdict';
import { handlePolicy, handleStorePolicy } from './policy';
import { handleEnrollPbl } from './enroll';
import { handleAttest } from './attest';
import { handleOverrideChallenge, handleOverrideResponse } from './override';
import { handleSigningKey } from './signingKey';
import { handleFirmwareDownload } from './firmware';
import {
  listDevices as listPblDevices, deleteDevice as deletePblDevice, getDevice as getPblDevice,
  setDeviceStatus as setPblDeviceStatus,
} from '../devices';
import { checkIpRateLimit, rateLimitResponse, IP_RATE_LIMITS } from '../rateLimit';
import { getSigningKeys, getPolicySigningKeys, resetKeyCache } from '../keys';

export async function handlePblRoute(
  request: Request,
  env: Env,
  path: string,
  method: string,
): Promise<Response> {
  try {
    // D-210: Rate limiting
    // - Per-device for firmware endpoints (verdict, attest, enroll) — NAT-safe
    // - IP-based for admin endpoints (devices) — no device_id in request
    // - No rate limiting for policy GET (edge-cached) or health (trivial)
    // - Override challenge/response already has per-device limiting in override.ts

    // IP-based rate limiting for admin device management endpoints
    if (path.startsWith('/v1/devices') && IP_RATE_LIMITS.devices) {
      const rl = await checkIpRateLimit(env.LOCKDOWN_KV, request, 'devices', IP_RATE_LIMITS.devices);
      if (rl.allowed === false) {
        return rateLimitResponse(rl.retryAfter);
      }
    }

    if (path === '/v1/verdict' && method === 'POST') {
      const keys = await getSigningKeys(env);
      return handleVerdict(request, env, keys);
    }

    // GET /v1/policy/:version — return signed policy blob (C4 §6)
    if (path.startsWith('/v1/policy/') && method === 'GET') {
      const versionParam = path.substring('/v1/policy/'.length);
      // D-205: Policy blobs are signed by the policy signing key (C4 §1),
      // separate from the verdict signing key.
      const policyKeys = await getPolicySigningKeys(env);
      const verdictKeys = await getSigningKeys(env);
      return handlePolicy(request, env, policyKeys, verdictKeys, versionParam);
    }

    // POST /v1/policy — store a policy blob (admin only)
    if (path === '/v1/policy' && method === 'POST') {
      const __a = await requireRole(request, env, 'operator');
      if (__a instanceof Response) return __a;
      const policyKeys = await getPolicySigningKeys(env);
      const verdictKeys = await getSigningKeys(env);
      return handleStorePolicy(request, env, policyKeys, verdictKeys);
    }

    // POST /v1/enroll — PBL TPM-based enrollment (C1 §6)
    if (path === '/v1/enroll' && method === 'POST') {
      return handleEnrollPbl(request, env);
    }

    // POST /v1/attest — TPM quote verification (C1 §6, D-203)
    if (path === '/v1/attest' && method === 'POST') {
      return handleAttest(request, env);
    }

    // POST /v1/override/challenge — REQ-14 offline override challenge (D-204)
    if (path === '/v1/override/challenge' && method === 'POST') {
      return handleOverrideChallenge(request, env);
    }

    // POST /v1/override/response — REQ-14 offline override response (D-204)
    if (path === '/v1/override/response' && method === 'POST') {
      const keys = await getSigningKeys(env);
      return handleOverrideResponse(request, env, keys);
    }

    // GET /v1/signing-key — return server's verdict signing key info (D-205)
    // Public endpoint — returns kid + SPKI for policy blob construction
    if (path === '/v1/signing-key' && method === 'GET') {
      return handleSigningKey(request, env);
    }

    // GET /v1/firmware — download PblApp.efi from KV (D-130)
    // Public endpoint — firmware binary is not secret
    if (path === '/v1/firmware' && method === 'GET') {
      return handleFirmwareDownload(request, env);
    }

    // GET /v1/devices — list all PBL devices (admin only, D-206)
    if (path === '/v1/devices' && method === 'GET') {
      const __a = await requireRole(request, env, 'viewer');
      if (__a instanceof Response) return __a;
      const devices = await listPblDevices(env.LOCKDOWN_KV);
      return new Response(
        JSON.stringify({ devices, count: devices.length }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    // GET /v1/devices/:id — get a single PBL device (admin only, D-206)
    if (path.startsWith('/v1/devices/') && !path.includes('/lock') && !path.includes('/unlock') && !path.includes('/track') && !path.includes('/agent-mapping') && method === 'GET') {
      const __a = await requireRole(request, env, 'viewer');
      if (__a instanceof Response) return __a;
      const deviceId = path.substring('/v1/devices/'.length);
      const device = await getPblDevice(env.LOCKDOWN_KV, deviceId);
      if (!device) {
        return errorResponse('Device not found', 404);
      }
      return new Response(
        JSON.stringify({ device }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    // POST /v1/devices/:id/lock — admin lock device (D-206)
    if (path.startsWith('/v1/devices/') && path.endsWith('/lock') && method === 'POST') {
      const __a = await requireRole(request, env, 'operator');
      if (__a instanceof Response) return __a;
      const deviceId = path.substring('/v1/devices/'.length, path.length - '/lock'.length);
      const device = await setPblDeviceStatus(env.LOCKDOWN_KV, deviceId, 'locked', 'admin_lock');
      if (!device) {
        return errorResponse('Device not found', 404);
      }
      return new Response(
        JSON.stringify({ device }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    // POST /v1/devices/:id/unlock — admin unlock device (D-206)
    if (path.startsWith('/v1/devices/') && path.endsWith('/unlock') && method === 'POST') {
      const __a = await requireRole(request, env, 'operator');
      if (__a instanceof Response) return __a;
      const deviceId = path.substring('/v1/devices/'.length, path.length - '/unlock'.length);
      const device = await setPblDeviceStatus(env.LOCKDOWN_KV, deviceId, 'active');
      if (!device) {
        return errorResponse('Device not found', 404);
      }
      return new Response(
        JSON.stringify({ device }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    // POST /v1/devices/:id/track — admin track device (C5 covert tracking, D-211)
    if (path.startsWith('/v1/devices/') && path.endsWith('/track') && method === 'POST') {
      const __a = await requireRole(request, env, 'operator');
      if (__a instanceof Response) return __a;
      const deviceId = path.substring('/v1/devices/'.length, path.length - '/track'.length);
      const device = await setPblDeviceStatus(env.LOCKDOWN_KV, deviceId, 'tracking', 'reported_stolen');
      if (!device) {
        return errorResponse('Device not found', 404);
      }
      return new Response(
        JSON.stringify({ device }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    // POST /v1/devices/:id/stop-track — admin stop tracking device (C5, D-211)
    if (path.startsWith('/v1/devices/') && path.endsWith('/stop-track') && method === 'POST') {
      const __a = await requireRole(request, env, 'operator');
      if (__a instanceof Response) return __a;
      const deviceId = path.substring('/v1/devices/'.length, path.length - '/stop-track'.length);
      const device = await setPblDeviceStatus(env.LOCKDOWN_KV, deviceId, 'active');
      if (!device) {
        return errorResponse('Device not found', 404);
      }
      return new Response(
        JSON.stringify({ device }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    // GET /v1/devices/:id/agent-mapping — look up agent device by PBL device_id (D-206)
    // Returns the agent device record linked to this PBL device, if any.
    // The agent device data is stored in the server's PostgreSQL/SQLite DB,
    // not in KV. The serverless Worker stores the mapping in KV as
    // `pbl_device_mapping:{pbl_device_id}` → { agent_device_id }.
    // NOTE: Must come before the general DELETE /v1/devices/:id route.
    if (path.startsWith('/v1/devices/') && path.endsWith('/agent-mapping') && method === 'GET') {
      const __a = await requireRole(request, env, 'operator');
      if (__a instanceof Response) return __a;
      const deviceId = path.substring('/v1/devices/'.length, path.length - '/agent-mapping'.length);
      const mappingKey = `pbl_device_mapping:${deviceId}`;
      const mapping = await env.LOCKDOWN_KV.get(mappingKey, 'text');
      if (!mapping) {
        return new Response(
          JSON.stringify({ mapped: false, pbl_device_id: deviceId }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(
        JSON.stringify({ mapped: true, pbl_device_id: deviceId, agent_device_id: mapping }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    // POST /v1/devices/:id/agent-mapping — link a PBL device to an agent device (D-206)
    // Body: { agent_device_id: string } — the UUID of the agent device record.
    if (path.startsWith('/v1/devices/') && path.endsWith('/agent-mapping') && method === 'POST') {
      const __a = await requireRole(request, env, 'operator');
      if (__a instanceof Response) return __a;
      const deviceId = path.substring('/v1/devices/'.length, path.length - '/agent-mapping'.length);
      const pblDevice = await getPblDevice(env.LOCKDOWN_KV, deviceId);
      if (!pblDevice) {
        return errorResponse('PBL device not found', 404);
      }
      let body: { agent_device_id?: string };
      try {
        body = await request.json();
      } catch {
        return errorResponse('invalid JSON body', 400);
      }
      if (!body.agent_device_id || typeof body.agent_device_id !== 'string') {
        return errorResponse('agent_device_id is required', 400);
      }
      const mappingKey = `pbl_device_mapping:${deviceId}`;
      await env.LOCKDOWN_KV.put(mappingKey, body.agent_device_id);
      return new Response(
        JSON.stringify({ mapped: true, pbl_device_id: deviceId, agent_device_id: body.agent_device_id }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    // DELETE /v1/devices/:id/agent-mapping — unlink a PBL device from an agent device (D-206)
    if (path.startsWith('/v1/devices/') && path.endsWith('/agent-mapping') && method === 'DELETE') {
      const __a = await requireRole(request, env, 'operator');
      if (__a instanceof Response) return __a;
      const deviceId = path.substring('/v1/devices/'.length, path.length - '/agent-mapping'.length);
      const mappingKey = `pbl_device_mapping:${deviceId}`;
      const existing = await env.LOCKDOWN_KV.get(mappingKey, 'text');
      if (!existing) {
        return errorResponse('No agent device mapping found', 404);
      }
      await env.LOCKDOWN_KV.delete(mappingKey);
      return new Response(
        JSON.stringify({ unmapped: true, pbl_device_id: deviceId }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    // DELETE /v1/devices/:id — admin delete device (D-206)
    if (path.startsWith('/v1/devices/') && method === 'DELETE') {
      const __a = await requireRole(request, env, 'operator');
      if (__a instanceof Response) return __a;
      const deviceId = path.substring('/v1/devices/'.length);
      const deleted = await deletePblDevice(env.LOCKDOWN_KV, deviceId);
      if (!deleted) {
        return errorResponse('Device not found', 404);
      }
      return new Response(
        JSON.stringify({ deleted: true }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    // POST /v1/admin/rotate-key — rotate the verdict signing key (D-205, admin only)
    if (path === '/v1/admin/rotate-key' && method === 'POST') {
      const __a = await requireRole(request, env, 'super-admin');
      if (__a instanceof Response) return __a;
      try {
        const { keys: newKeys, kidHistory } = await rotateSigningKey(env.LOCKDOWN_KV);
        // Invalidate the cached key so subsequent requests use the new key
        resetKeyCache();
        const kidHex = Array.from(newKeys.kid)
          .map(b => b.toString(16).padStart(2, '0'))
          .join('');
        return new Response(
          JSON.stringify({
            rotated: true,
            new_kid: kidHex,
            kid_history_count: kidHistory.length,
            kid_history: kidHistory.map(k =>
              Array.from(k).map(b => b.toString(16).padStart(2, '0')).join('')
            ),
            spki_size: newKeys.spki.length,
            algorithm: newKeys.algorithm,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'rotation failed';
        return errorResponse(msg, 500);
      }
    }

    // GET /v1/admin/key-info — get current signing key info (D-205, admin only)
    if (path === '/v1/admin/key-info' && method === 'GET') {
      const __a = await requireRole(request, env, 'viewer');
      if (__a instanceof Response) return __a;
      const keys = await getSigningKeys(env);
      const policyKeys = await getPolicySigningKeys(env);
      const kidHistory = await getKidHistory(env.LOCKDOWN_KV);
      return new Response(
        JSON.stringify({
          verdict_key: {
            kid: Array.from(keys.kid).map(b => b.toString(16).padStart(2, '0')).join(''),
            spki_size: keys.spki.length,
            algorithm: keys.algorithm,
          },
          policy_key: {
            kid: Array.from(policyKeys.kid).map(b => b.toString(16).padStart(2, '0')).join(''),
            spki_size: policyKeys.spki.length,
            algorithm: policyKeys.algorithm,
          },
          kid_history: kidHistory.map(k =>
            Array.from(k).map(b => b.toString(16).padStart(2, '0')).join('')
          ),
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    // POST /v1/admin/cert-chain — store the X.509 cert chain in KV (D-205, admin only)
    // Body: raw DER bytes (concatenated certs) or JSON { chain: "<base64>" }
    if (path === '/v1/admin/cert-chain' && method === 'POST') {
      const __a = await requireRole(request, env, 'super-admin');
      if (__a instanceof Response) return __a;
      try {
        const contentType = request.headers.get('Content-Type') || '';
        let chainBytes: Uint8Array;

        if (contentType.includes('application/json')) {
          const body = await request.json() as { chain?: string };
          if (!body.chain) {
            return errorResponse('chain (base64) required in JSON body', 400);
          }
          chainBytes = Uint8Array.from(Buffer.from(body.chain, 'base64'));
        } else {
          // Raw DER bytes
          chainBytes = new Uint8Array(await request.arrayBuffer());
        }

        if (chainBytes.length === 0) {
          return errorResponse('cert chain cannot be empty', 400);
        }

        // Validate: must be valid DER SEQUENCEs
        const certs = splitDerCerts(chainBytes);
        if (certs.length === 0) {
          return errorResponse('no valid DER certificates found', 400);
        }
        if (certs.length < 2) {
          return errorResponse('cert chain must have at least 2 certs (leaf + CA)', 400);
        }

        await storeCertChain(env.LOCKDOWN_KV, chainBytes);

        return new Response(
          JSON.stringify({
            stored: true,
            cert_count: certs.length,
            total_size: chainBytes.length,
            cert_sizes: certs.map(c => c.length),
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'store failed';
        return errorResponse(msg, 500);
      }
    }

    // GET /v1/admin/cert-chain — get cert chain info (D-205, admin only)
    if (path === '/v1/admin/cert-chain' && method === 'GET') {
      const __a = await requireRole(request, env, 'viewer');
      if (__a instanceof Response) return __a;
      const certs = await loadCertChain(env.LOCKDOWN_KV);
      return new Response(
        JSON.stringify({
          provisioned: certs.length > 0,
          cert_count: certs.length,
          cert_sizes: certs.map(c => c.length),
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    // DELETE /v1/admin/cert-chain — remove cert chain from KV (D-205, admin only)
    if (path === '/v1/admin/cert-chain' && method === 'DELETE') {
      const __a = await requireRole(request, env, 'super-admin');
      if (__a instanceof Response) return __a;
      await env.LOCKDOWN_KV.delete('pbl_cert_chain:current');
      return new Response(
        JSON.stringify({ deleted: true }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    // POST /v1/admin/operator-key — store the operator override public key (D-204, admin only)
    // Body: JSON { spki: "<base64>" } — the ES256 public key SPKI
    if (path === '/v1/admin/operator-key' && method === 'POST') {
      const __a = await requireRole(request, env, 'super-admin');
      if (__a instanceof Response) return __a;
      try {
        const body = await request.json() as { spki?: string };
        if (!body.spki) {
          return errorResponse('spki (base64) required in JSON body', 400);
        }
        const spkiBytes = Uint8Array.from(Buffer.from(body.spki, 'base64'));
        if (spkiBytes.length === 0) {
          return errorResponse('spki cannot be empty', 400);
        }
        // Validate: try to import as ES256 public key
        try {
          await crypto.subtle.importKey(
            'spki', spkiBytes,
            { name: 'ECDSA', namedCurve: 'P-256' },
            false, ['verify'],
          );
        } catch {
          return errorResponse('spki is not a valid ES256 public key', 400);
        }
        await env.LOCKDOWN_KV.put('pbl_operator_key:current', body.spki);
        return new Response(
          JSON.stringify({ stored: true, spki_size: spkiBytes.length }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'store failed';
        return errorResponse(msg, 500);
      }
    }

    // GET /v1/admin/operator-key — get operator key info (D-204, admin only)
    if (path === '/v1/admin/operator-key' && method === 'GET') {
      const __a = await requireRole(request, env, 'viewer');
      if (__a instanceof Response) return __a;
      const stored = await env.LOCKDOWN_KV.get('pbl_operator_key:current', 'text');
      return new Response(
        JSON.stringify({
          provisioned: !!stored,
          spki_size: stored ? Uint8Array.from(Buffer.from(stored, 'base64')).length : 0,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    // DELETE /v1/admin/operator-key — remove operator key (D-204, admin only)
    if (path === '/v1/admin/operator-key' && method === 'DELETE') {
      const __a = await requireRole(request, env, 'super-admin');
      if (__a instanceof Response) return __a;
      await env.LOCKDOWN_KV.delete('pbl_operator_key:current');
      return new Response(
        JSON.stringify({ deleted: true }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    if (path === '/v1/health' && method === 'GET') {
      return new Response(
        JSON.stringify({ status: 'ok', pbl: true }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    return new Response(
      JSON.stringify({ error: 'not found' }),
      { status: 404, headers: { 'Content-Type': 'application/json' } },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'internal error';
    return new Response(
      JSON.stringify({ error: msg }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }
}
