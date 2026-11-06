-- 018: devices.agent_version + agent_version_at.
--
-- The fleet cannot answer "which build is on that machine?" (D-222). The agent has
-- always sent its version: POST /api/agent/update reads `x-agent-version` (or
-- ?version) to decide whether an update is available, and POST /api/agent/checkin's
-- documented body carries `agent_version` — but neither path stored it, and `devices`
-- had no column for it. So a rollout instruction could not come with a way to check
-- compliance, and a sunset like D-221's had to be announced as a warning instead of a
-- verifiable step.
--
-- Both columns are nullable and stay null for a device that has never reported a
-- version: "unknown" is a different fact from "on version X", and the dashboard shows
-- it as such rather than guessing. agent_version_at records when the value was last
-- reported, so a stale version is distinguishable from a current one.

ALTER TABLE devices ADD COLUMN IF NOT EXISTS agent_version VARCHAR(64);
ALTER TABLE devices ADD COLUMN IF NOT EXISTS agent_version_at TIMESTAMPTZ;
