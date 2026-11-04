-- 016: devices.serial_number.
--
-- The Worker's device record has carried serial_number since enrolment, and the
-- dashboard's Device detail page renders a "Serial Number" row — but the Express
-- schema had no such column, so the row was permanently "N/A" on self-hosted
-- deployments and the enrolment claim could not store what the installer sends
-- (S204). Nullable: existing rows have no serial, and not every platform reports one.

ALTER TABLE devices ADD COLUMN IF NOT EXISTS serial_number VARCHAR(255);
