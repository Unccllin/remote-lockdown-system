/**
 * X.509 certificate chain support for D-205.
 *
 * The cert chain provides an alternative trust path for the policy signing
 * key: instead of pinning the SPKI directly, firmware pins the root CA
 * cert. The policy blob carries the full chain (C4 key 77), and firmware
 * verifies the chain back to the pinned root CA, then extracts the leaf
 * SPKI for signature verification.
 *
 * Chain format (C4 key 77): array of bstr, ordered [leaf, intermediate, root CA].
 * Each bstr is a DER-encoded X.509 certificate.
 *
 * The chain is generated offline by scripts/generate-cert-chain.sh and
 * stored in KV. The serverless worker loads it from KV and embeds it in
 * the policy blob. Verification is done by firmware (blocked by no EDK2).
 */

/** KV key for the cert chain (DER bytes, base64-encoded). */
const CERT_CHAIN_KV_KEY = 'pbl_cert_chain:current';

/** Load the cert chain from KV.
 *
 *  @param kv  KV namespace
 *  @returns Array of DER-encoded cert bytes (empty if not provisioned)
 */
export async function loadCertChain(kv: KVNamespace): Promise<Uint8Array[]> {
  const stored = await kv.get(CERT_CHAIN_KV_KEY, 'text');
  if (!stored) return [];

  try {
    // The chain is stored as base64-encoded concatenated DER bytes.
    // Each cert is a DER SEQUENCE, so we can split by finding SEQUENCE tags.
    const chainBytes = Uint8Array.from(Buffer.from(stored, 'base64'));
    return splitDerCerts(chainBytes);
  } catch {
    return [];
  }
}

/** Store the cert chain in KV.
 *
 *  @param kv          KV namespace
 *  @param chainBytes  Concatenated DER cert bytes
 */
export async function storeCertChain(
  kv: KVNamespace,
  chainBytes: Uint8Array,
): Promise<void> {
  const base64 = Buffer.from(chainBytes).toString('base64');
  await kv.put(CERT_CHAIN_KV_KEY, base64);
}

/** Split concatenated DER certificates into individual cert byte arrays.
 *
 *  Each X.509 cert is a DER SEQUENCE. We parse the DER length to find
 *  the boundary between certs.
 *
 *  @param chainBytes  Concatenated DER cert bytes
 *  @returns Array of individual cert DER bytes
 */
export function splitDerCerts(chainBytes: Uint8Array): Uint8Array[] {
  const certs: Uint8Array[] = [];
  let offset = 0;

  while (offset < chainBytes.length) {
    // Each cert starts with 0x30 (DER SEQUENCE tag)
    if (chainBytes[offset] !== 0x30) {
      break;
    }

    // Parse the length (DER length encoding)
    const lengthByte = chainBytes[offset + 1];
    let headerSize: number;
    let contentLength: number;

    if (lengthByte < 0x80) {
      // Short form: length is in one byte
      headerSize = 2;
      contentLength = lengthByte;
    } else {
      // Long form: first byte is 0x80 | num_length_bytes
      const numLengthBytes = lengthByte & 0x7f;
      headerSize = 2 + numLengthBytes;
      contentLength = 0;
      for (let i = 0; i < numLengthBytes; i++) {
        contentLength = (contentLength << 8) | chainBytes[offset + 2 + i];
      }
    }

    const certSize = headerSize + contentLength;
    if (offset + certSize > chainBytes.length) {
      break;
    }

    certs.push(chainBytes.slice(offset, offset + certSize));
    offset += certSize;
  }

  return certs;
}
