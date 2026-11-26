-- 020: rearm_requests — a re-arm is approved, not handed out (ADR-011, D-226).
--
-- `POST /api/rearm` is unauthenticated by necessity: the PblPersistDxe bootstrap that calls it
-- carries no device secret (the firmware comment says so), and it identifies the machine by
-- `hardware_uuid` — a value printed in firmware setup and readable from Windows. The route used to
-- answer that request with a fresh API key for any flagged device, so whoever held a stolen laptop
-- could re-key the very machine this product locks, ACK lock commands without locking, and cut off
-- the real agent.
--
-- Now the request is recorded here and a super-admin approves it. One row per device: a device can
-- only have one outstanding ask, and re-requesting refreshes it rather than queueing duplicates.
--
--   status      pending  -> waiting for an administrator
--               approved -> the next POST /api/rearm may consume it (deleted on use)
--               denied   -> refused; the device may ask again only after a new request is made
--   expires_at  an approval is time-limited so it cannot be banked until a thief needs it
--
-- The row is deleted when an approval is consumed, which is what makes it single-use.

CREATE TABLE IF NOT EXISTS rearm_requests (
  device_id     UUID PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  hardware_uuid TEXT NOT NULL,
  hostname      TEXT,
  requested_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source_ip     TEXT,
  status        TEXT NOT NULL DEFAULT 'pending',
  decided_at    TIMESTAMPTZ,
  decided_by    UUID REFERENCES admins(id) ON DELETE SET NULL,
  expires_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS rearm_requests_status_idx ON rearm_requests (status, requested_at DESC);
