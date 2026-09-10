/**
 * GET /v1/firmware — Download the PBL UEFI application (PblApp.efi).
 *
 * Serves the firmware binary from KV storage. The firmware is stored
 * at KV key `pbl_firmware:current` as base64-encoded bytes.
 *
 * Upload with: wrangler kv key put --binding=LOCKDOWN_KV "pbl_firmware:current" \
 *   --base64 < <(base64 < PblApp.efi)
 *
 * Response: application/octet-stream (raw EFI binary)
 *
 * No auth required — the firmware binary is not secret.
 */

const FIRMWARE_KV_KEY = 'pbl_firmware:current';

export async function handleFirmwareDownload(
  _request: Request,
  env: { LOCKDOWN_KV: KVNamespace },
): Promise<Response> {
  const stored = await env.LOCKDOWN_KV.get(FIRMWARE_KV_KEY, 'text');
  if (!stored) {
    return new Response(
      JSON.stringify({ error: 'Firmware not uploaded. Use wrangler kv key put to upload PblApp.efi.' }),
      {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  }

  const firmwareBytes = Uint8Array.from(Buffer.from(stored, 'base64'));

  return new Response(firmwareBytes, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': 'attachment; filename="PblApp.efi"',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
