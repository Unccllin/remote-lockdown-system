-- 015: Single-use enrolment tokens (token-based device enrolment).
--
-- Why: the Worker implements POST /api/enroll/token + /api/enroll/claim, and both
-- the dashboard's Enroll page and `installer.py --token` depend on them. The
-- Express server implemented neither, so token enrolment 404'd on self-hosted
-- deployments (S204). This table backs the same contract here.
--
-- Only the SHA-256 of the token is stored: the plaintext is shown once in the
-- response and never persisted, so a database read cannot be replayed as an
-- enrolment. `used_at` is the single-use marker — the claim route updates it
-- conditionally (WHERE used_at IS NULL) so two concurrent claims cannot both win.
--
-- created_by is the admin who issued the token, so the audit row can name the
-- human who authorised the enrolment. It is TEXT rather than a FK type because
-- the id arrives from the JWT and the column only carries provenance.

CREATE TABLE IF NOT EXISTS enrollment_tokens (
  id UUID PRIMARY KEY,
  token_hash VARCHAR(64) NOT NULL UNIQUE,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_enrollment_tokens_hash ON enrollment_tokens(token_hash);
