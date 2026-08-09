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

module.exports = { getDeviceById, getDeviceByApiKeyHash, getDeviceByHostname, getDeviceByHardwareIdentity };
