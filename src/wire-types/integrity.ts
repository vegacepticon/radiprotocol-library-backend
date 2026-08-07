// DUPLICATED from the plugin's src/library/integrity.ts (D6 — SHA-256 byte-identical
// via Web Crypto globalThis.crypto.subtle, lowercase hex). Framed as INTEGRITY (detect
// byte corruption/tamper relative to a manifest hash), NOT authenticity — ed25519 is
// deferred (D11). The UI must never mark unsigned releases "trusted".

function toHex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i]!.toString(16).padStart(2, '0');
  }
  return out;
}

function subtle(): SubtleCrypto {
  const s = globalThis.crypto?.subtle;
  if (s === undefined) {
    throw new Error('[RadiProtocol] Web Crypto subtle.digest unavailable — cannot compute SHA-256');
  }
  return s;
}

export async function sha256String(content: string): Promise<string> {
  const bytes = new TextEncoder().encode(content);
  const digest = await subtle().digest('SHA-256', bytes);
  return toHex(digest as ArrayBuffer);
}

export async function verifyIntegrity(content: string, expectedSha256: string): Promise<boolean> {
  const actual = await sha256String(content);
  return actual.toLowerCase() === expectedSha256.toLowerCase();
}
