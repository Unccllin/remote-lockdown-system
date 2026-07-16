-- Privacy hardening: encrypt sensitive location fields at rest (FA5)
--
-- Adds encrypted columns for latitude, longitude, city, region, ip_address.
-- These fields are PII-sensitive (they reveal the physical location of
-- the device and its user). The plaintext columns are retained for
-- dual-mode read (CC16) during the backfill transition.
--
-- Encryption: AES-256-GCM via LOCATION_FIELD_KEY (separate from
-- FIELD_ENCRYPTION_KEY — different blast radius).
--
-- Residual risk: lat/lon are encrypted at rest, but the dashboard must
-- decrypt them for map display. The DPIA documents this as accepted
-- residual risk (the data is only decrypted in the admin dashboard's
-- server-side read path, never exposed via API in plaintext to the agent).

ALTER TABLE location_reports ADD COLUMN IF NOT EXISTS latitude_enc TEXT;
ALTER TABLE location_reports ADD COLUMN IF NOT EXISTS lat_enc_nonce TEXT;
ALTER TABLE location_reports ADD COLUMN IF NOT EXISTS lat_enc_tag TEXT;

ALTER TABLE location_reports ADD COLUMN IF NOT EXISTS longitude_enc TEXT;
ALTER TABLE location_reports ADD COLUMN IF NOT EXISTS lon_enc_nonce TEXT;
ALTER TABLE location_reports ADD COLUMN IF NOT EXISTS lon_enc_tag TEXT;

ALTER TABLE location_reports ADD COLUMN IF NOT EXISTS city_enc TEXT;
ALTER TABLE location_reports ADD COLUMN IF NOT EXISTS city_enc_nonce TEXT;
ALTER TABLE location_reports ADD COLUMN IF NOT EXISTS city_enc_tag TEXT;

ALTER TABLE location_reports ADD COLUMN IF NOT EXISTS region_enc TEXT;
ALTER TABLE location_reports ADD COLUMN IF NOT EXISTS region_enc_nonce TEXT;
ALTER TABLE location_reports ADD COLUMN IF NOT EXISTS region_enc_tag TEXT;

ALTER TABLE location_reports ADD COLUMN IF NOT EXISTS ip_address_enc TEXT;
ALTER TABLE location_reports ADD COLUMN IF NOT EXISTS ip_enc_nonce TEXT;
ALTER TABLE location_reports ADD COLUMN IF NOT EXISTS ip_enc_tag TEXT;
