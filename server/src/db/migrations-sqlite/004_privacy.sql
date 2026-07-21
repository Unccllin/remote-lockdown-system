-- Migration 004: SQLite version — encrypt sensitive location fields at rest (FA5)
-- See migrations/004_privacy.sql for full rationale.

ALTER TABLE location_reports ADD COLUMN latitude_enc TEXT;
ALTER TABLE location_reports ADD COLUMN lat_enc_nonce TEXT;
ALTER TABLE location_reports ADD COLUMN lat_enc_tag TEXT;

ALTER TABLE location_reports ADD COLUMN longitude_enc TEXT;
ALTER TABLE location_reports ADD COLUMN lon_enc_nonce TEXT;
ALTER TABLE location_reports ADD COLUMN lon_enc_tag TEXT;

ALTER TABLE location_reports ADD COLUMN city_enc TEXT;
ALTER TABLE location_reports ADD COLUMN city_enc_nonce TEXT;
ALTER TABLE location_reports ADD COLUMN city_enc_tag TEXT;

ALTER TABLE location_reports ADD COLUMN region_enc TEXT;
ALTER TABLE location_reports ADD COLUMN region_enc_nonce TEXT;
ALTER TABLE location_reports ADD COLUMN region_enc_tag TEXT;

ALTER TABLE location_reports ADD COLUMN ip_address_enc TEXT;
ALTER TABLE location_reports ADD COLUMN ip_enc_nonce TEXT;
ALTER TABLE location_reports ADD COLUMN ip_enc_tag TEXT;
