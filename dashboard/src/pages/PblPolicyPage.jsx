import { useState, useEffect } from 'react';
import { pblPolicy, pblAdmin } from '../api/pblClient';

/**
 * D-209: PBL Policy Management page.
 *
 * Super-admin only. Shows:
 * - Signing key info (verdict + policy KID)
 * - Current policy version
 * - Policy blob download (COSE_Sign1 binary)
 * - Policy blob upload (super-admin only)
 * - Form-based policy creation (super-admin only)
 * - Policy version list
 */
function PblPolicyPage() {
  const [keyInfo, setKeyInfo] = useState(null);
  const [policyVersion, setPolicyVersion] = useState('latest');
  const [policySize, setPolicySize] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [uploadVersion, setUploadVersion] = useState('');
  const [uploadFile, setUploadFile] = useState(null);
  const [policyVersions, setPolicyVersions] = useState([]);
  const [policyLatestVersion, setPolicyLatestVersion] = useState(null);

  // D-209: Form-based policy creation state
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [creating, setCreating] = useState(false);
  const [formVersion, setFormVersion] = useState('');
  const [formExpiresAt, setFormExpiresAt] = useState('');
  const [formMinPblVersion, setFormMinPblVersion] = useState('1');
  const [formSpiRequired, setFormSpiRequired] = useState(true);
  const [formUsbDciPolicy, setFormUsbDciPolicy] = useState('disabled');
  const [formBitlockerTier, setFormBitlockerTier] = useState('standard');
  const [formS3Policy, setFormS3Policy] = useState('disabled');
  const [formNetworkBootPolicy, setFormNetworkBootPolicy] = useState('absent');
  const [formBitlockerRequired, setFormBitlockerRequired] = useState(true);
  const [formFirmwareRecovery, setFormFirmwareRecovery] = useState('none');
  const [formLockServiceUri, setFormLockServiceUri] = useState('');
  const [formAttestationUri, setFormAttestationUri] = useState('');
  const [formPolicyUri, setFormPolicyUri] = useState('');
  const [formOverrideChallengeUri, setFormOverrideChallengeUri] = useState('');
  const [formVerdictFreshness, setFormVerdictFreshness] = useState('900');
  const [formGracePeriod, setFormGracePeriod] = useState('604800');
  const [formWipeDeadline, setFormWipeDeadline] = useState('86400');
  // Complex array fields as JSON text
  const [formOemPkAllowlist, setFormOemPkAllowlist] = useState('[]');
  const [formPkfailDenylist, setFormPkfailDenylist] = useState('[]');
  const [formDbExpectations, setFormDbExpectations] = useState('[]');
  const [formDbxExpectations, setFormDbxExpectations] = useState('[]');
  const [formBootmgrSvnFloor, setFormBootmgrSvnFloor] = useState('0');
  const [formSpiOemMatrix, setFormSpiOemMatrix] = useState('[]');
  const [formFirmwareFloors, setFormFirmwareFloors] = useState('[]');
  const [formTpmFirmwareFloors, setFormTpmFirmwareFloors] = useState('[]');
  const [formTpmPinPolicy, setFormTpmPinPolicy] = useState('[]');
  const [formNvIndexBase, setFormNvIndexBase] = useState('29360128');
  const [formBcdHash, setFormBcdHash] = useState('');
  const [formWinreWimHash, setFormWinreWimHash] = useState('');
  const [formRecoverysequenceTarget, setFormRecoverysequenceTarget] = useState('{default}');
  const [formLockServiceCertPin, setFormLockServiceCertPin] = useState('');
  const [formTlsCaPin, setFormTlsCaPin] = useState('');
  const [formVerdictSigningKeySpki, setFormVerdictSigningKeySpki] = useState('');

  useEffect(() => {
    loadData();
  }, []);

  async function loadData() {
    setLoading(true);
    setError(null);
    try {
      const [keyResp, policyResp] = await Promise.all([
        pblAdmin.getKeyInfo(),
        pblPolicy.get('latest').catch(() => null),
      ]);
      setKeyInfo(keyResp.data);
      if (policyResp && policyResp.data) {
        setPolicySize(policyResp.data.byteLength || policyResp.data.length || 0);
      }
      // D-209: Load policy version list
      loadPolicyVersions();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setLoading(false);
    }
  }

  async function loadPolicyVersions() {
    try {
      const resp = await pblPolicy.list();
      setPolicyVersions(resp.data.versions || []);
      setPolicyLatestVersion(resp.data.latest_version || null);
    } catch {
      // Policy list endpoint may not be available in all environments
    }
  }

  async function handleDownload() {
    try {
      const resp = await pblPolicy.get(policyVersion || 'latest');
      const blob = new Blob([resp.data], { type: 'application/cose' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `policy-${policyVersion || 'latest'}.cose`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    }
  }

  async function handleUpload(e) {
    e.preventDefault();
    if (!uploadFile) {
      setError('Select a policy blob file first');
      return;
    }
    try {
      const buf = await uploadFile.arrayBuffer();
      await pblPolicy.store(buf, uploadVersion || undefined);
      setError(null);
      setUploadFile(null);
      setUploadVersion('');
      loadData();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    }
  }

  // D-209: Form-based policy creation
  async function handleCreate(e) {
    e.preventDefault();
    setCreating(true);
    setError(null);
    try {
      // Parse JSON array fields
      const parseJson = (str, fallback) => {
        try { return JSON.parse(str); } catch { return fallback; }
      };
      const fields = {
        version: parseInt(formVersion, 10),
        expires_at: formExpiresAt ? parseInt(formExpiresAt, 10) : undefined,
        min_pbl_version: parseInt(formMinPblVersion, 10) || 1,
        spi_protection_required: formSpiRequired,
        usb_dci_policy: formUsbDciPolicy,
        bitlocker_sealing_tier: formBitlockerTier,
        s3_policy: formS3Policy,
        network_boot_policy: formNetworkBootPolicy,
        bitlocker_required: formBitlockerRequired,
        firmware_recovery_expectation: formFirmwareRecovery,
        lock_service_uri: formLockServiceUri,
        attestation_uri: formAttestationUri,
        policy_uri: formPolicyUri,
        override_challenge_uri: formOverrideChallengeUri,
        verdict_freshness_seconds: parseInt(formVerdictFreshness, 10) || 900,
        grace_period_seconds: parseInt(formGracePeriod, 10) || 604800,
        wipe_deadline_seconds: parseInt(formWipeDeadline, 10) || 86400,
        oem_pk_allowlist: parseJson(formOemPkAllowlist, []),
        pkfail_denylist: parseJson(formPkfailDenylist, []),
        db_expectations: parseJson(formDbExpectations, []),
        dbx_expectations: parseJson(formDbxExpectations, []),
        bootmgr_svn_floor: parseInt(formBootmgrSvnFloor, 10) || 0,
        spi_oem_matrix: parseJson(formSpiOemMatrix, []),
        firmware_floors: parseJson(formFirmwareFloors, []),
        tpm_firmware_floors: parseJson(formTpmFirmwareFloors, []),
        tpm_pin_policy: parseJson(formTpmPinPolicy, []),
        nv_index_base: parseInt(formNvIndexBase, 10) || 0x01C00000,
        bcd_hash: formBcdHash,
        winre_wim_hash: formWinreWimHash,
        recoverysequence_target: formRecoverysequenceTarget,
        lock_service_cert_pin: formLockServiceCertPin,
        tls_ca_pin: formTlsCaPin,
        verdict_signing_key_spki: formVerdictSigningKeySpki,
      };
      await pblPolicy.create(fields);
      setShowCreateForm(false);
      loadData();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setCreating(false);
    }
  }

  if (loading) return <div className="p-6">Loading policy info…</div>;

  return (
    <div className="p-6 max-w-4xl">
      <h1 className="text-2xl font-bold mb-6">PBL Policy Management</h1>

      {error && (
        <div className="mb-4 p-3 bg-red-100 border border-red-400 text-red-700 rounded">
          {error}
        </div>
      )}

      {/* Signing Keys */}
      <div className="mb-6 p-4 bg-gray-50 rounded border">
        <h2 className="text-lg font-semibold mb-3">Signing Keys</h2>
        {keyInfo ? (
          <div className="space-y-2">
            <div>
              <span className="font-medium">Verdict signing key: </span>
              <code className="text-sm bg-gray-200 px-1 rounded">
                {keyInfo.verdict_signing_key?.kid || 'not generated'}
              </code>
              <span className="text-gray-500 ml-2">({keyInfo.verdict_signing_key?.algorithm || '—'})</span>
            </div>
            <div>
              <span className="font-medium">Policy signing key: </span>
              <code className="text-sm bg-gray-200 px-1 rounded">
                {keyInfo.policy_signing_key?.kid || 'not generated'}
              </code>
              <span className="text-gray-500 ml-2">({keyInfo.policy_signing_key?.algorithm || '—'})</span>
            </div>
          </div>
        ) : (
          <p className="text-gray-500">No key info available</p>
        )}
      </div>

      {/* Policy Download */}
      <div className="mb-6 p-4 bg-gray-50 rounded border">
        <h2 className="text-lg font-semibold mb-3">Download Policy</h2>
        <div className="flex gap-2 items-end">
          <div>
            <label className="block text-sm font-medium mb-1">Version</label>
            <input
              type="text"
              value={policyVersion}
              onChange={(e) => setPolicyVersion(e.target.value)}
              placeholder="latest"
              className="px-2 py-1 border rounded text-sm"
            />
          </div>
          <button
            onClick={handleDownload}
            className="px-4 py-1.5 bg-blue-600 text-white rounded hover:bg-blue-700 text-sm"
          >
            Download
          </button>
        </div>
        {policySize !== null && (
          <p className="text-sm text-gray-500 mt-2">
            Current policy size: {policySize} bytes
          </p>
        )}
      </div>

      {/* Form-based Policy Creation (super-admin only) */}
      <div className="mb-6 p-4 bg-gray-50 rounded border">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold">Create New Policy</h2>
          <button
            onClick={() => setShowCreateForm(!showCreateForm)}
            className="px-3 py-1 bg-blue-100 rounded text-sm hover:bg-blue-200"
          >
            {showCreateForm ? 'Hide Form' : 'Show Form'}
          </button>
        </div>
        {showCreateForm && (
          <form onSubmit={handleCreate} className="space-y-4">
            {/* Metadata */}
            <div className="p-3 bg-white rounded border">
              <h3 className="text-sm font-semibold mb-2">Metadata (C4 §2.1)</h3>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium mb-1">Version (uint) *</label>
                  <input
                    type="number" min="1" required
                    value={formVersion}
                    onChange={(e) => setFormVersion(e.target.value)}
                    placeholder="e.g. 7"
                    className="px-2 py-1 border rounded text-sm w-full"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">Expires At (unix ts, optional)</label>
                  <input
                    type="number"
                    value={formExpiresAt}
                    onChange={(e) => setFormExpiresAt(e.target.value)}
                    placeholder="default: +90 days"
                    className="px-2 py-1 border rounded text-sm w-full"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">Min PBL Version</label>
                  <input
                    type="number" min="1"
                    value={formMinPblVersion}
                    onChange={(e) => setFormMinPblVersion(e.target.value)}
                    className="px-2 py-1 border rounded text-sm w-full"
                  />
                </div>
              </div>
            </div>

            {/* Secure Boot */}
            <div className="p-3 bg-white rounded border">
              <h3 className="text-sm font-semibold mb-2">Secure Boot (C4 §2.2)</h3>
              <div className="space-y-2">
                <div>
                  <label className="block text-xs font-medium mb-1">OEM PK Allowlist (JSON array)</label>
                  <textarea
                    value={formOemPkAllowlist}
                    onChange={(e) => setFormOemPkAllowlist(e.target.value)}
                    placeholder='[{"subject":"HP Inc.","issuer":"HP Inc.","fingerprint":"abcd..."}]'
                    className="px-2 py-1 border rounded text-xs w-full font-mono"
                    rows={2}
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">PKfail Denylist (JSON array of hex)</label>
                  <textarea
                    value={formPkfailDenylist}
                    onChange={(e) => setFormPkfailDenylist(e.target.value)}
                    placeholder='["abcd...","ef01..."]'
                    className="px-2 py-1 border rounded text-xs w-full font-mono"
                    rows={2}
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">db Expectations (JSON array)</label>
                  <textarea
                    value={formDbExpectations}
                    onChange={(e) => setFormDbExpectations(e.target.value)}
                    placeholder='[{"fingerprint":"abcd...","label":"Windows UEFI CA 2023"}]'
                    className="px-2 py-1 border rounded text-xs w-full font-mono"
                    rows={2}
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">dbx Expectations (JSON array)</label>
                  <textarea
                    value={formDbxExpectations}
                    onChange={(e) => setFormDbxExpectations(e.target.value)}
                    placeholder='[{"fingerprint":"abcd...","label":"MS 2011 Prod CA revocation"}]'
                    className="px-2 py-1 border rounded text-xs w-full font-mono"
                    rows={2}
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">bootmgr SVN Floor</label>
                  <input
                    type="number" min="0"
                    value={formBootmgrSvnFloor}
                    onChange={(e) => setFormBootmgrSvnFloor(e.target.value)}
                    className="px-2 py-1 border rounded text-sm w-32"
                  />
                </div>
              </div>
            </div>

            {/* SPI + Firmware */}
            <div className="p-3 bg-white rounded border">
              <h3 className="text-sm font-semibold mb-2">SPI + Firmware (C4 §2.3-2.4)</h3>
              <div className="space-y-2">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={formSpiRequired}
                    onChange={(e) => setFormSpiRequired(e.target.checked)}
                  />
                  SPI Protection Required
                </label>
                <div>
                  <label className="block text-xs font-medium mb-1">SPI OEM Matrix (JSON array)</label>
                  <textarea
                    value={formSpiOemMatrix}
                    onChange={(e) => setFormSpiOemMatrix(e.target.value)}
                    placeholder='[{"vendor":"HP","product":"EliteBook 840","protocol":"HpSpiLib","status":"ok"}]'
                    className="px-2 py-1 border rounded text-xs w-full font-mono"
                    rows={2}
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">Firmware Floors (JSON array)</label>
                  <textarea
                    value={formFirmwareFloors}
                    onChange={(e) => setFormFirmwareFloors(e.target.value)}
                    placeholder='[{"vendor":"HP","product":"EliteBook 840 G10","min_version":"U70 Ver. 01.05.00","advisories":["LogoFAIL"]}]'
                    className="px-2 py-1 border rounded text-xs w-full font-mono"
                    rows={2}
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">USB DCI Policy</label>
                  <select
                    value={formUsbDciPolicy}
                    onChange={(e) => setFormUsbDciPolicy(e.target.value)}
                    className="px-2 py-1 border rounded text-sm"
                  >
                    <option value="disabled">disabled</option>
                    <option value="allowlisted_only">allowlisted_only</option>
                  </select>
                </div>
              </div>
            </div>

            {/* TPM */}
            <div className="p-3 bg-white rounded border">
              <h3 className="text-sm font-semibold mb-2">TPM Policy (C4 §2.5)</h3>
              <div className="space-y-2">
                <div>
                  <label className="block text-xs font-medium mb-1">TPM Firmware Floors (JSON array)</label>
                  <textarea
                    value={formTpmFirmwareFloors}
                    onChange={(e) => setFormTpmFirmwareFloors(e.target.value)}
                    placeholder='[{"vendor":"Intel","model":"PTT","min_version":"11.0.0.0","risk":"TPM-Fail"}]'
                    className="px-2 py-1 border rounded text-xs w-full font-mono"
                    rows={2}
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">TPM PIN Policy (JSON array)</label>
                  <textarea
                    value={formTpmPinPolicy}
                    onChange={(e) => setFormTpmPinPolicy(e.target.value)}
                    placeholder='[{"tpm_type":"dtpm","pin_required":true}]'
                    className="px-2 py-1 border rounded text-xs w-full font-mono"
                    rows={2}
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium mb-1">NV Index Base</label>
                    <input
                      type="number"
                      value={formNvIndexBase}
                      onChange={(e) => setFormNvIndexBase(e.target.value)}
                      className="px-2 py-1 border rounded text-sm w-full"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium mb-1">BitLocker Sealing Tier</label>
                    <select
                      value={formBitlockerTier}
                      onChange={(e) => setFormBitlockerTier(e.target.value)}
                      className="px-2 py-1 border rounded text-sm w-full"
                    >
                      <option value="standard">standard</option>
                      <option value="high_assurance">high_assurance</option>
                    </select>
                  </div>
                </div>
              </div>
            </div>

            {/* Boot Config */}
            <div className="p-3 bg-white rounded border">
              <h3 className="text-sm font-semibold mb-2">Boot Config (C4 §2.6)</h3>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium mb-1">S3 Policy</label>
                  <select
                    value={formS3Policy}
                    onChange={(e) => setFormS3Policy(e.target.value)}
                    className="px-2 py-1 border rounded text-sm w-full"
                  >
                    <option value="disabled">disabled</option>
                    <option value="allowed">allowed</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">Network Boot Policy</label>
                  <select
                    value={formNetworkBootPolicy}
                    onChange={(e) => setFormNetworkBootPolicy(e.target.value)}
                    className="px-2 py-1 border rounded text-sm w-full"
                  >
                    <option value="absent">absent</option>
                    <option value="https_pinned_only">https_pinned_only</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">BCD Hash (hex)</label>
                  <input
                    type="text"
                    value={formBcdHash}
                    onChange={(e) => setFormBcdHash(e.target.value)}
                    placeholder="hex SHA-256"
                    className="px-2 py-1 border rounded text-sm w-full font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">winre.wim Hash (hex)</label>
                  <input
                    type="text"
                    value={formWinreWimHash}
                    onChange={(e) => setFormWinreWimHash(e.target.value)}
                    placeholder="hex SHA-256"
                    className="px-2 py-1 border rounded text-sm w-full font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">Recoverysequence Target</label>
                  <input
                    type="text"
                    value={formRecoverysequenceTarget}
                    onChange={(e) => setFormRecoverysequenceTarget(e.target.value)}
                    className="px-2 py-1 border rounded text-sm w-full"
                  />
                </div>
                <label className="flex items-center gap-2 text-sm col-span-2">
                  <input
                    type="checkbox"
                    checked={formBitlockerRequired}
                    onChange={(e) => setFormBitlockerRequired(e.target.checked)}
                  />
                  BitLocker Required
                </label>
              </div>
            </div>

            {/* Endpoints + Pins */}
            <div className="p-3 bg-white rounded border">
              <h3 className="text-sm font-semibold mb-2">Endpoints + Pins (C4 §2.7-2.8)</h3>
              <div className="space-y-2">
                <div>
                  <label className="block text-xs font-medium mb-1">Firmware Recovery Expectation</label>
                  <select
                    value={formFirmwareRecovery}
                    onChange={(e) => setFormFirmwareRecovery(e.target.value)}
                    className="px-2 py-1 border rounded text-sm"
                  >
                    <option value="none">none</option>
                    <option value="dual_image">dual_image</option>
                    <option value="intel_pfr">intel_pfr</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">Lock Service URI</label>
                  <input
                    type="text"
                    value={formLockServiceUri}
                    onChange={(e) => setFormLockServiceUri(e.target.value)}
                    placeholder="https://pbl-verdict.example.com"
                    className="px-2 py-1 border rounded text-sm w-full"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">Attestation URI</label>
                  <input
                    type="text"
                    value={formAttestationUri}
                    onChange={(e) => setFormAttestationUri(e.target.value)}
                    placeholder="https://pbl-verdict.example.com/v1/attest"
                    className="px-2 py-1 border rounded text-sm w-full"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">Policy URI</label>
                  <input
                    type="text"
                    value={formPolicyUri}
                    onChange={(e) => setFormPolicyUri(e.target.value)}
                    placeholder="https://pbl-verdict.example.com/v1/policy"
                    className="px-2 py-1 border rounded text-sm w-full"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">Override Challenge URI</label>
                  <input
                    type="text"
                    value={formOverrideChallengeUri}
                    onChange={(e) => setFormOverrideChallengeUri(e.target.value)}
                    placeholder="https://pbl-verdict.example.com/v1/override/challenge"
                    className="px-2 py-1 border rounded text-sm w-full"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">Lock Service Cert Pin (hex SHA-256)</label>
                  <input
                    type="text"
                    value={formLockServiceCertPin}
                    onChange={(e) => setFormLockServiceCertPin(e.target.value)}
                    placeholder="hex"
                    className="px-2 py-1 border rounded text-sm w-full font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">TLS CA Pin (hex SHA-256)</label>
                  <input
                    type="text"
                    value={formTlsCaPin}
                    onChange={(e) => setFormTlsCaPin(e.target.value)}
                    placeholder="hex"
                    className="px-2 py-1 border rounded text-sm w-full font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">Verdict Signing Key SPKI (hex DER)</label>
                  <input
                    type="text"
                    value={formVerdictSigningKeySpki}
                    onChange={(e) => setFormVerdictSigningKeySpki(e.target.value)}
                    placeholder="hex"
                    className="px-2 py-1 border rounded text-sm w-full font-mono"
                  />
                </div>
              </div>
            </div>

            {/* Verdict Cache + Override */}
            <div className="p-3 bg-white rounded border">
              <h3 className="text-sm font-semibold mb-2">Verdict Cache + Override (C4 §2.9)</h3>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-medium mb-1">Freshness (sec)</label>
                  <input
                    type="number"
                    value={formVerdictFreshness}
                    onChange={(e) => setFormVerdictFreshness(e.target.value)}
                    className="px-2 py-1 border rounded text-sm w-full"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">Grace Period (sec)</label>
                  <input
                    type="number"
                    value={formGracePeriod}
                    onChange={(e) => setFormGracePeriod(e.target.value)}
                    className="px-2 py-1 border rounded text-sm w-full"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">Wipe Deadline (sec)</label>
                  <input
                    type="number"
                    value={formWipeDeadline}
                    onChange={(e) => setFormWipeDeadline(e.target.value)}
                    className="px-2 py-1 border rounded text-sm w-full"
                  />
                </div>
              </div>
            </div>

            <button
              type="submit"
              disabled={creating}
              className="px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700 text-sm disabled:opacity-50"
            >
              {creating ? 'Creating…' : 'Create + Sign Policy'}
            </button>
          </form>
        )}
      </div>

      {/* Policy Upload (super-admin only) */}
      <div className="mb-6 p-4 bg-gray-50 rounded border">
        <h2 className="text-lg font-semibold mb-3">Upload Signed Policy</h2>
        <form onSubmit={handleUpload} className="space-y-3">
          <div>
            <label className="block text-sm font-medium mb-1">Version (optional)</label>
            <input
              type="text"
              value={uploadVersion}
              onChange={(e) => setUploadVersion(e.target.value)}
              placeholder="auto-generated if empty"
              className="px-2 py-1 border rounded text-sm w-48"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Policy blob (.cose file)</label>
            <input
              type="file"
              accept=".cose,application/cose"
              onChange={(e) => setUploadFile(e.target.files[0])}
              className="text-sm"
            />
          </div>
          <button
            type="submit"
            className="px-4 py-1.5 bg-green-600 text-white rounded hover:bg-green-700 text-sm"
          >
            Upload Policy
          </button>
        </form>
      </div>

      {/* Policy List */}
      <div className="mb-6 p-4 bg-gray-50 rounded border">
        <h2 className="text-lg font-semibold mb-3">Policy Versions</h2>
        <button
          onClick={loadPolicyVersions}
          className="px-3 py-1 bg-gray-200 rounded text-sm mb-2 hover:bg-gray-300"
        >
          Refresh
        </button>
        {policyVersions.length > 0 ? (
          <div className="space-y-1">
            <div className="text-sm text-gray-500">
              Latest: <code className="bg-gray-200 px-1 rounded">{policyLatestVersion || '—'}</code>
            </div>
            <ul className="text-sm font-mono">
              {policyVersions.map((v) => (
                <li
                  key={v}
                  className={v === policyLatestVersion ? 'font-bold text-green-700' : ''}
                >
                  {v}
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="text-sm text-gray-500">No policy versions stored</p>
        )}
      </div>
    </div>
  );
}

export default PblPolicyPage;
