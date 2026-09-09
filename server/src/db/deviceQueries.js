const pool = require('./pool');

async function getDeviceById(deviceId) {
  const result = await pool.query('SELECT * FROM devices WHERE id = $1', [deviceId]);
  return result.rows[0] || null;
}

async function getDeviceByApiKeyHash(apiKeyHash) {
  const result = await pool.query('SELECT * FROM devices WHERE api_key_hash = $1 LIMIT 1', [apiKeyHash]);
  return result.rows[0] || null;
}

async function getDeviceByHostname(hostname) {
  const result = await pool.query('SELECT * FROM devices WHERE hostname = $1', [hostname]);
  return result.rows[0] || null;
}

async function getDeviceByHardwareIdentity(hostname, macAddress, hardwareUuid) {
  let device;
  if (macAddress || hardwareUuid) {
    const result = await pool.query(
      `SELECT * FROM devices
       WHERE (mac_address = $1 AND $1 IS NOT NULL)
          OR (hardware_uuid = $2 AND $2 IS NOT NULL)
       LIMIT 1`,
      [macAddress || null, hardwareUuid || null]
    );
    device = result.rows[0];
  }
  if (!device && hostname) {
    device = await getDeviceByHostname(hostname);
  }
  return device || null;
}

// D-206: PBL device identity mapping.
// PBL devices are identified by SHA-256(AK public area) hex (64 chars).
// Agent devices use UUID primary keys. These queries link the two.

/** Find an agent device by its PBL device_id (SHA-256 of AK public area). */
async function getDeviceByPblDeviceId(pblDeviceId) {
  const result = await pool.query(
    'SELECT * FROM devices WHERE pbl_device_id = $1 LIMIT 1',
    [pblDeviceId],
  );
  return result.rows[0] || null;
}

/** Link a PBL device_id to an existing agent device record.
 *  Returns the updated device, or null if the agent device was not found.
 *  Throws if the PBL device_id is already linked to a different agent device. */
async function setPblDeviceId(deviceId, pblDeviceId) {
  const result = await pool.query(
    'UPDATE devices SET pbl_device_id = $2 WHERE id = $1 RETURNING *',
    [deviceId, pblDeviceId],
  );
  return result.rows[0] || null;
}

/** Unlink a PBL device_id from an agent device record.
 *  Returns the updated device, or null if the agent device was not found. */
async function clearPblDeviceId(deviceId) {
  const result = await pool.query(
    'UPDATE devices SET pbl_device_id = NULL WHERE id = $1 RETURNING *',
    [deviceId],
  );
  return result.rows[0] || null;
}

module.exports = {
  getDeviceById,
  getDeviceByApiKeyHash,
  getDeviceByHostname,
  getDeviceByHardwareIdentity,
  getDeviceByPblDeviceId,
  setPblDeviceId,
  clearPblDeviceId,
};
