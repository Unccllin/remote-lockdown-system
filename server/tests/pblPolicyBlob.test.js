/**
 * D-209: Policy blob generation round-trip tests.
 *
 * Tests the full policy creation pipeline: POST /v1/policy/create with all
 * C4 §2 fields → COSE_Sign1 blob → decode → verify all fields present.
 *
 * The existing D-209 tests in pblVerdictPolicyEnroll.test.js cover the
 * endpoint (auth, validation, defaults, storage). This file verifies that
 * the CBOR payload inside the COSE_Sign1 blob contains all ~40 C4 §2
 * fields with correct values and types.
 */

const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');

const { router, createEnv, getPolicySigningKeys } = require('../src/routes/pbl');
const { setSharedKvStore } = require('../src/pbl/kvStore');
const cbor = require('../src/pbl/cbor');
const cose = require('../src/pbl/cose');

const JWT_SECRET = 'test-secret-key-that-is-long-enough-for-validation-32';
process.env.JWT_SECRET = JWT_SECRET;

function makeToken(role = 'super-admin') {
  return jwt.sign({ id: 'admin-1', username: 'admin', role }, JWT_SECRET, { expiresIn: '1h' });
}

function createApp(env) {
  const app = express();
  app.use('/v1', (req, res, next) => {
    const ct = (req.headers['content-type'] || '').split(';')[0].trim();
    if (ct === 'application/cbor') {
      express.raw({ type: 'application/cbor', limit: '256kb' })(req, res, next);
    } else {
      express.json({ limit: '1mb' })(req, res, next);
    }
  });
  app.use('/v1', (req, res, next) => {
    req._pblEnv = env || createEnv();
    next();
  });
  app.use('/v1', router);
  return app;
}

/** Full policy input with all C4 §2 fields populated with test values. */
function fullPolicyInput() {
  return {
    // §2.1 Metadata
    version: 42,
    issued_at: 1700000000,
    expires_at: 1700000000 + 90 * 24 * 3600,
    min_pbl_version: 2,
    // §2.2 Secure Boot
    oem_pk_allowlist: [
      { subject: 'HP Inc.', issuer: 'HP Inc. Root CA', fingerprint: 'aabbccdd' },
      { subject: 'Dell Inc.', issuer: 'Dell Root CA', fingerprint: 'eeff0011' },
    ],
    pkfail_denylist: ['deadbeef', 'cafebabe'],
    db_expectations: [{ fingerprint: '11223344', label: 'Microsoft UEFI CA' }],
    dbx_expectations: [{ fingerprint: '55667788', label: 'Revoked Boot Loader' }],
    bootmgr_svn_floor: 7,
    // §2.3 SPI protections
    spi_protection_required: true,
    spi_oem_matrix: [
      { vendor: 'HP', product: 'EliteBook', protocol: 'tcg-spi', status: 'supported' },
    ],
    // §2.4 Firmware floors
    firmware_floors: [
      { vendor: 'HP', product: 'EliteBook 840', min_version: '1.5.0', advisories: ['CVE-2024-0001'] },
    ],
    amt_allowlist: [
      { device_id: '00112233', reason: 'Corporate fleet' },
    ],
    usb_dci_policy: 'disabled',
    // §2.5 TPM policy
    tpm_session_requirements: { hmac: true, param_encrypt: true, salted: true, bound: true },
    tpm_firmware_floors: [
      { vendor: 'Infineon', model: 'SLB9670', min_version: '7.83', risk: 'low' },
    ],
    tpm_pin_policy: [{ tpm_type: 'dtpm', pin_required: true }],
    nv_index_base: 0x01C00000,
    bitlocker_sealing_tier: 'tpm-and-pin',
    // §2.6 Boot config
    s3_policy: 'enforce',
    kernel_dma_protection_required: true,
    mor_required: true,
    network_boot_policy: 'absent',
    bcd_hash: 'aabbccddeeff00112233445566778899',
    winre_wim_hash: 'bbccddeeff0011223344556677889900',
    recoverysequence_target: '{custom}',
    bitlocker_required: true,
    // §2.7 Recovery
    firmware_recovery_expectation: 'capsule-update',
    // §2.8 Pins and endpoints
    lock_service_uri: 'https://pbl.example.com',
    lock_service_cert_pin: 'ccddeeff00112233',
    lock_service_cert_pin_history: ['aabbccdd', 'eeff0011'],
    tls_ca_pin: 'ddee001122334455',
    attestation_uri: 'https://pbl.example.com/attest',
    policy_uri: 'https://pbl.example.com/policy',
    verdict_signing_key_spki: '998877665544332211',
    signing_cert_chain: ['aabb', 'ccdd', 'eeff'],
    // §2.9 Verdict cache and override
    verdict_freshness_seconds: 600,
    grace_period_seconds: 30 * 24 * 3600,
    wipe_deadline_seconds: 12 * 3600,
    override_rate_limit: { max_attempts: 3, window_seconds: 1800 },
    override_challenge_uri: 'https://pbl.example.com/override',
  };
}

beforeEach(() => {
  setSharedKvStore(new Map());
});

describe('D-209: Policy blob round-trip (all C4 §2 fields)', () => {
  it('creates a policy blob and decodes all fields', async () => {
    const env = createEnv();
    const app = createApp(env);
    const input = fullPolicyInput();

    const resp = await request(app)
      .post('/v1/policy/create')
      .set('Authorization', 'Bearer ' + makeToken('super-admin'))
      .set('Content-Type', 'application/json')
      .send(input);

    expect(resp.status).toBe(200);
    expect(resp.body.stored).toBe(true);
    expect(resp.body.version).toBe('42');

    // Retrieve the stored COSE_Sign1 blob
    const storedB64 = await env.LOCKDOWN_KV.get('pbl_policy:42', 'text');
    expect(storedB64).toBeDefined();
    const coseBlob = Buffer.from(storedB64, 'base64');

    // Decode COSE_Sign1 = [protected, unprotected, payload, signature]
    const coseArray = cbor.decodeFirst(coseBlob);
    expect(coseArray).toBeInstanceOf(Array);
    expect(coseArray).toHaveLength(4);

    const protectedHeader = cbor.decodeFirst(coseArray[0]);
    const payload = coseArray[2];
    const signature = coseArray[3];

    // Verify protected header has alg and kid
    expect(protectedHeader.get(1)).toBe(-7); // ES256
    expect(protectedHeader.get(4)).toBeInstanceOf(Buffer); // kid

    // Decode the policy payload (CBOR map with numeric keys)
    const policy = cbor.decodeFirst(payload);
    expect(policy).toBeInstanceOf(Map);

    // §2.1 Metadata (keys 1-4)
    expect(policy.get(1)).toBe(42); // version
    expect(policy.get(2)).toBe(1700000000); // issued_at
    expect(policy.get(3)).toBe(1700000000 + 90 * 24 * 3600); // expires_at
    expect(policy.get(4)).toBe(2); // min_pbl_version

    // §2.2 Secure Boot (keys 10-14)
    const oemPk = policy.get(10);
    expect(oemPk).toBeInstanceOf(Array);
    expect(oemPk).toHaveLength(2);
    expect(oemPk[0].get(1)).toBe('HP Inc.');
    expect(oemPk[0].get(2)).toBe('HP Inc. Root CA');

    const pkfailDeny = policy.get(11);
    expect(pkfailDeny).toBeInstanceOf(Array);
    expect(pkfailDeny).toHaveLength(2);

    const dbExp = policy.get(12);
    expect(dbExp).toBeInstanceOf(Array);
    expect(dbExp[0].get(2)).toBe('Microsoft UEFI CA');

    const dbxExp = policy.get(13);
    expect(dbxExp).toBeInstanceOf(Array);
    expect(dbxExp[0].get(2)).toBe('Revoked Boot Loader');

    expect(policy.get(14)).toBe(7); // bootmgr_svn_floor

    // §2.3 SPI protections (keys 20-21)
    expect(policy.get(20)).toBe(true);
    const spiMatrix = policy.get(21);
    expect(spiMatrix[0].get(1)).toBe('HP');
    expect(spiMatrix[0].get(3)).toBe('tcg-spi');

    // §2.4 Firmware floors (keys 30-32)
    const fwFloors = policy.get(30);
    expect(fwFloors[0].get(1)).toBe('HP');
    expect(fwFloors[0].get(3)).toBe('1.5.0');

    const amtAllow = policy.get(31);
    expect(amtAllow).toHaveLength(1);

    expect(policy.get(32)).toBe('disabled'); // usb_dci_policy

    // §2.5 TPM policy (keys 40-44)
    const tpmSess = policy.get(40);
    expect(tpmSess.get(1)).toBe(true); // hmac
    expect(tpmSess.get(4)).toBe(true); // bound

    const tpmFwFloors = policy.get(41);
    expect(tpmFwFloors[0].get(1)).toBe('Infineon');

    const tpmPin = policy.get(42);
    expect(tpmPin[0].get(1)).toBe('dtpm');
    expect(tpmPin[0].get(2)).toBe(true);

    expect(policy.get(43)).toBe(0x01C00000); // nv_index_base
    expect(policy.get(44)).toBe('tpm-and-pin'); // bitlocker_sealing_tier

    // §2.6 Boot config (keys 50-57)
    expect(policy.get(50)).toBe('enforce'); // s3_policy
    expect(policy.get(51)).toBe(true); // kernel_dma_protection_required
    expect(policy.get(52)).toBe(true); // mor_required
    expect(policy.get(53)).toBe('absent'); // network_boot_policy
    expect(policy.get(54)).toBeInstanceOf(Buffer); // bcd_hash
    expect(policy.get(55)).toBeInstanceOf(Buffer); // winre_wim_hash
    expect(policy.get(56)).toBe('{custom}'); // recoverysequence_target
    expect(policy.get(57)).toBe(true); // bitlocker_required

    // §2.7 Recovery (key 60)
    expect(policy.get(60)).toBe('capsule-update');

    // §2.8 Pins and endpoints (keys 70-77)
    expect(policy.get(70)).toBe('https://pbl.example.com');
    expect(policy.get(71)).toBeInstanceOf(Buffer); // lock_service_cert_pin
    const pinHistory = policy.get(72);
    expect(pinHistory).toHaveLength(2);
    expect(policy.get(73)).toBeInstanceOf(Buffer); // tls_ca_pin
    expect(policy.get(74)).toBe('https://pbl.example.com/attest');
    expect(policy.get(75)).toBe('https://pbl.example.com/policy');
    expect(policy.get(76)).toBeInstanceOf(Buffer); // verdict_signing_key_spki
    const certChain = policy.get(77);
    expect(certChain).toHaveLength(3);

    // §2.9 Verdict cache and override (keys 80-84)
    expect(policy.get(80)).toBe(600); // verdict_freshness_seconds
    expect(policy.get(81)).toBe(30 * 24 * 3600); // grace_period_seconds
    expect(policy.get(82)).toBe(12 * 3600); // wipe_deadline_seconds
    const rateLimit = policy.get(83);
    expect(rateLimit.get(1)).toBe(3); // max_attempts
    expect(rateLimit.get(2)).toBe(1800); // window_seconds
    expect(policy.get(84)).toBe('https://pbl.example.com/override');

    // Verify signature is 64 bytes (ES256)
    expect(signature).toBeInstanceOf(Buffer);
    expect(signature.length).toBe(64);
  });

  it('policy blob is a valid COSE_Sign1 (signature verifies)', async () => {
    const env = createEnv();
    const app = createApp(env);
    const input = fullPolicyInput();

    const resp = await request(app)
      .post('/v1/policy/create')
      .set('Authorization', 'Bearer ' + makeToken('super-admin'))
      .set('Content-Type', 'application/json')
      .send(input);

    expect(resp.status).toBe(200);

    const storedB64 = await env.LOCKDOWN_KV.get('pbl_policy:42', 'text');
    const coseBlob = Buffer.from(storedB64, 'base64');
    const coseArray = cbor.decodeFirst(coseBlob);
    const protectedHeader = coseArray[0];
    const payload = coseArray[2];
    const signature = coseArray[3];

    // Reconstruct Sig_structure and verify
    const sigStructure = cose.buildSigStructure(protectedHeader, payload);
    // Get the policy signing key from env
    const keys = await getPolicySigningKeys(env);
    const valid = await cose.verifySignature(keys.publicKey, sigStructure, signature, keys.algorithm);
    expect(valid).toBe(true);
  });

  it('policy blob with minimal fields (defaults) still produces valid COSE_Sign1', async () => {
    const env = createEnv();
    const app = createApp(env);

    const resp = await request(app)
      .post('/v1/policy/create')
      .set('Authorization', 'Bearer ' + makeToken('super-admin'))
      .set('Content-Type', 'application/json')
      .send({ version: 1 });

    expect(resp.status).toBe(200);

    const storedB64 = await env.LOCKDOWN_KV.get('pbl_policy:1', 'text');
    const coseBlob = Buffer.from(storedB64, 'base64');
    const coseArray = cbor.decodeFirst(coseBlob);
    expect(coseArray).toHaveLength(4);

    const policy = cbor.decodeFirst(coseArray[2]);
    // Defaults should be present
    expect(policy.get(1)).toBe(1); // version
    expect(policy.get(4)).toBe(1); // min_pbl_version default
    expect(policy.get(20)).toBe(true); // spi_protection_required default
    expect(policy.get(50)).toBe('disabled'); // s3_policy default
    expect(policy.get(80)).toBe(900); // verdict_freshness_seconds default
  });

  it('policy blob size is within 64 KiB budget (C4 §1.1)', async () => {
    const env = createEnv();
    const app = createApp(env);
    const input = fullPolicyInput();

    const resp = await request(app)
      .post('/v1/policy/create')
      .set('Authorization', 'Bearer ' + makeToken('super-admin'))
      .set('Content-Type', 'application/json')
      .send(input);

    expect(resp.status).toBe(200);
    expect(resp.body.size).toBeLessThan(64 * 1024); // 64 KiB budget
  });
});
