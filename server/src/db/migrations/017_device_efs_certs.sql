-- 017: Per-device EFS certificate backups.
--
-- The agent escrows its EFS recovery certificate (a base64 .pfx plus its
-- password) so an admin can recover encrypted files after a wipe; the Worker
-- stores it in KV under `efs_cert:{deviceId}`, and the agent already posts to
-- POST /api/agent/efs-cert — but Express had neither the upload nor the download
-- route, so a self-hosted agent's upload 404'd and no backup was ever kept (S208,
-- found by the cross-surface audit).
--
-- The password protects the .pfx, so it is stored encrypted when
-- FIELD_ENCRYPTION_KEY is configured (the repo's dual-mode pattern: the plaintext
-- column is kept for rows written before encryption existed). The .pfx itself is
-- already an encrypted container and is stored as base64.
--
-- One row per device: the agent re-uploads on every lockdown, and a newer backup
-- replaces the older one — the same overwrite semantics as the KV key.

CREATE TABLE IF NOT EXISTS device_efs_certs (
  device_id UUID PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  cert_base64 TEXT NOT NULL,
  cert_password TEXT,
  cert_password_enc TEXT,
  cert_password_nonce TEXT,
  cert_password_tag TEXT,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
