/**
 * PBL device store — KV-backed device records.
 *
 * Uses a separate KV prefix `pbl_devices:` to avoid collision with
 * the existing agent device store.
 */

export type PblDeviceStatus = 'active' | 'locked' | 'recovering' | 'tracking';

export interface PblDevice {
  device_id: string; // SHA-256(AK public area), hex
  status: PblDeviceStatus;
  enrolled_at: string; // ISO timestamp
  hostname?: string;
  hardware_uuid?: string;
  lock_reason?: string;
}

const PREFIX = 'pbl_devices:';

/** Get a PBL device by device_id. */
export async function getDevice(
  kv: KVNamespace,
  deviceId: string,
): Promise<PblDevice | null> {
  const data = await kv.get(`${PREFIX}${deviceId}`, 'json');
  return data as PblDevice | null;
}

/** Put a PBL device record. */
export async function putDevice(
  kv: KVNamespace,
  device: PblDevice,
): Promise<void> {
  await kv.put(`${PREFIX}${device.device_id}`, JSON.stringify(device));
}

/** Set device status (used by admin lock/unlock operations). */
export async function setDeviceStatus(
  kv: KVNamespace,
  deviceId: string,
  status: PblDeviceStatus,
  lockReason?: string,
): Promise<PblDevice | null> {
  const device = await getDevice(kv, deviceId);
  if (!device) return null;
  device.status = status;
  if (lockReason !== undefined) {
    device.lock_reason = lockReason;
  }
  await putDevice(kv, device);
  return device;
}

// ---------------------------------------------------------------------------
// Device list and admin management (D-206)
// ---------------------------------------------------------------------------

/** List all PBL devices.
 *
 *  Uses KV list() to enumerate keys with the `pbl_devices:` prefix.
 *  Returns up to 1000 devices (KV list() limit).
 */
export async function listDevices(
  kv: KVNamespace,
): Promise<PblDevice[]> {
  const devices: PblDevice[] = [];
  let cursor: string | undefined;

  do {
    const result = await kv.list({ prefix: PREFIX, cursor });
    for (const key of result.keys) {
      const data = await kv.get(key.name, 'json');
      if (data) {
        devices.push(data as PblDevice);
      }
    }
    // The Workers lib types `list_complete` as a boolean, so the union is not
    // discriminated and neither `!result.allowed`-style nor ternary narrowing
    // works. An `in` guard narrows on the property's presence, which is exactly
    // what KV guarantees: `cursor` exists only when the listing is incomplete.
    cursor = 'cursor' in result ? result.cursor : undefined;
  } while (cursor);

  return devices;
}

/** Delete a PBL device by device_id. */
export async function deleteDevice(
  kv: KVNamespace,
  deviceId: string,
): Promise<boolean> {
  const device = await getDevice(kv, deviceId);
  if (!device) return false;
  await kv.delete(`${PREFIX}${deviceId}`);
  return true;
}
