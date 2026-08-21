// Hashing-parity vitest suite (Phase 7). Unit-tests the probe logic of
// scripts/lib/hashing-parity.mjs — the shared probe the wire-parity gate runs on the
// plugin's src/library/integrity.ts and the backend's src/wire-types/integrity.ts copies.
// The gate CLI itself (scripts/check-wire-parity.mjs) stays untested, consistent with the
// repo precedent (its top-level pin-read/git side effects make it untestable as-is); every
// probe decision is exercised through the lib. The plugin's integrity copy is unreachable
// from this repo (read-only checkout at the pinned rev), so the plugin side is represented
// by an independently-written clone of the same Web Crypto SHA-256 dialect — the test's
// stand-in for what the gate compares on the shipped tree.

import { describe, it, expect } from 'vitest';
import * as integrityModule from '../src/wire-types/integrity';
// scripts/lib/hashing-parity.mjs is a declaration-less .mjs lib (Phase 5 ships no .d.mts),
// so tsc cannot type its exports; vitest/esbuild resolves the real module at runtime, so the
// probe surface is still exercised. The directive self-invalidates if the error ever disappears.
// @ts-expect-error
import { SHA256_ABC_KAT, HEX_64_RE, canonicalProtocolJson, probeIntegrity, hashingParityError } from '../scripts/lib/hashing-parity.mjs';

// Independent re-implementation of the D6 SHA-256 dialect (TextEncoder → subtle.digest →
// lowercase hex), standing in for the plugin's src/library/integrity.ts copy.
async function cloneSha256String(content: string): Promise<string> {
  const bytes = new TextEncoder().encode(content);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function cloneVerifyIntegrity(content: string, expectedSha256: string): Promise<boolean> {
  return (await cloneSha256String(content)).toLowerCase() === expectedSha256.toLowerCase();
}

const pluginLikeModule = { sha256String: cloneSha256String, verifyIntegrity: cloneVerifyIntegrity };

// Static multi-byte UTF-8 content (Cyrillic) — exercises byte encoding, not just ASCII.
const CYRILLIC_CONTENT = 'Радиология — КТ грудной клетки';
const CYRILLIC_EXTRA_CASE = { name: 'Cyrillic (test-local)', content: CYRILLIC_CONTENT };

describe('hashing-parity — anchors against the real backend module', () => {
  it('sha256String("abc") resolves to the absolute KAT anchor', async () => {
    expect(await integrityModule.sha256String('abc')).toBe(SHA256_ABC_KAT);
  });
  it('the KAT constant itself is the standard SHA-256("abc") vector (anchor is not a corrupted copy)', () => {
    expect(SHA256_ABC_KAT).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
  it('sha256String("") resolves to the standard empty-string vector', async () => {
    expect(await integrityModule.sha256String('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
  it('every digest in a probe of the real module is lowercase hex-64', async () => {
    const probe = await probeIntegrity(integrityModule);
    for (const [name, value] of Object.entries(probe.sha256String)) {
      expect(typeof value, `sha256String[${name}]`).toBe('string');
      expect(value, `sha256String[${name}]`).toMatch(HEX_64_RE);
    }
  });
  it('the probe pins the fixed KAT case through the probe path', async () => {
    const probe = await probeIntegrity(integrityModule);
    expect(probe.sha256String['SHA-256 KAT "abc"']).toBe(SHA256_ABC_KAT);
  });
});

describe('hashing-parity — canonicalProtocolJson (seed.ts dialect)', () => {
  it('emits exactly JSON.stringify(doc, null, 2) + newline — the byte stream seed.ts hashes', () => {
    const doc = { nodes: [{ id: 'n1', kind: 'start' }], layoutDirection: 'ltr' };
    expect(canonicalProtocolJson(doc)).toBe(JSON.stringify(doc, null, 2) + '\n');
  });
  it('ends with a trailing newline and indents nested objects with two spaces', () => {
    const doc = { a: { b: [1, 2] }, c: 'x' };
    const out = canonicalProtocolJson(doc);
    expect(out.endsWith('\n')).toBe(true);
    expect(out).toContain('"a": {\n    "b": [');
  });
});

describe('hashing-parity — probeIntegrity + hashingParityError', () => {
  it('identical probes on both sides yield null', async () => {
    const pluginProbe = await probeIntegrity(pluginLikeModule, [CYRILLIC_EXTRA_CASE]);
    const backendProbe = await probeIntegrity(integrityModule, [CYRILLIC_EXTRA_CASE]);
    expect(hashingParityError(pluginProbe, backendProbe)).toBeNull();
  });
  it('multi-byte UTF-8 Cyrillic hashes identically on both sides', async () => {
    const pluginProbe = await probeIntegrity(pluginLikeModule, [CYRILLIC_EXTRA_CASE]);
    const backendProbe = await probeIntegrity(integrityModule, [CYRILLIC_EXTRA_CASE]);
    const pluginHex = pluginProbe.sha256String[CYRILLIC_EXTRA_CASE.name];
    const backendHex = backendProbe.sha256String[CYRILLIC_EXTRA_CASE.name];
    expect(pluginHex).toMatch(HEX_64_RE);
    expect(pluginHex).toBe(backendHex);
    expect(pluginHex).not.toBe(SHA256_ABC_KAT); // multi-byte content, not the ASCII KAT
  });
  it('encoding drift (uppercase hex output) is caught and names the failing case', async () => {
    const driftModule = {
      async sha256String(content: string): Promise<string> {
        return (await cloneSha256String(content)).toUpperCase();
      },
      verifyIntegrity: cloneVerifyIntegrity,
    };
    const pluginProbe = await probeIntegrity(driftModule);
    const backendProbe = await probeIntegrity(integrityModule);
    const err = hashingParityError(pluginProbe, backendProbe);
    expect(err).not.toBeNull();
    expect(err).toContain('SHA-256 KAT "abc"');
  });
  it('digest drift (wrong KAT) is caught and names the failing case', async () => {
    const driftModule = {
      async sha256String(): Promise<string> {
        return '0'.repeat(64);
      },
      verifyIntegrity: cloneVerifyIntegrity,
    };
    const pluginProbe = await probeIntegrity(driftModule);
    const backendProbe = await probeIntegrity(integrityModule);
    const err = hashingParityError(pluginProbe, backendProbe);
    expect(err).not.toBeNull();
    expect(err).toContain('SHA-256 KAT "abc"');
  });
  it('lockstep drift (both sides with the same wrong KAT) is caught by the absolute anchor', async () => {
    const wrongModule = {
      async sha256String(): Promise<string> {
        return '0'.repeat(64);
      },
      verifyIntegrity: cloneVerifyIntegrity,
    };
    const pluginProbe = await probeIntegrity(wrongModule);
    const backendProbe = await probeIntegrity(wrongModule);
    expect(hashingParityError(pluginProbe, backendProbe)).not.toBeNull();
  });
  it('case-sensitive verifyIntegrity (uppercase expected rejected) is caught and names the case', async () => {
    const caseSensitiveModule = {
      sha256String: cloneSha256String,
      async verifyIntegrity(content: string, expectedSha256: string): Promise<boolean> {
        return (await cloneSha256String(content)) === expectedSha256;
      },
    };
    const pluginProbe = await probeIntegrity(caseSensitiveModule);
    const backendProbe = await probeIntegrity(integrityModule);
    const err = hashingParityError(pluginProbe, backendProbe);
    expect(err).not.toBeNull();
    expect(err).toContain('match:abc (uppercase)');
  });
  it('a missing verifyIntegrity export is caught — the probe records {threw} instead of crashing', async () => {
    const missingExportModule = { sha256String: cloneSha256String };
    const pluginProbe = await probeIntegrity(missingExportModule);
    const backendProbe = await probeIntegrity(integrityModule);
    expect(pluginProbe.verifyIntegrity['match:abc']).toMatchObject({ threw: expect.any(String) });
    const err = hashingParityError(pluginProbe, backendProbe);
    expect(err).not.toBeNull();
    expect(err).toContain('match:abc');
  });
});

describe('hashing-parity — verifyIntegrity semantics (never throws)', () => {
  it('match → true; uppercase expected → true; mismatch → false, never throwing', async () => {
    expect(await integrityModule.verifyIntegrity('abc', SHA256_ABC_KAT)).toBe(true);
    expect(await integrityModule.verifyIntegrity('abc', SHA256_ABC_KAT.toUpperCase())).toBe(true);
    expect(await integrityModule.verifyIntegrity('abc', '0'.repeat(64))).toBe(false);
  });
  it('the probe surfaces the three verifyIntegrity semantics results', async () => {
    const probe = await probeIntegrity(integrityModule);
    expect(probe.verifyIntegrity['match:abc']).toBe(true);
    expect(probe.verifyIntegrity['match:abc (uppercase)']).toBe(true);
    expect(probe.verifyIntegrity['mismatch:abc']).toBe(false);
  });
});
