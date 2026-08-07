import { describe, it, expect } from 'vitest';
import {
  isPackageManifest, isCatalogEntry, PACKAGE_MANIFEST_SCHEMA, PACKAGE_MANIFEST_VERSION,
  type PackageManifest, type CatalogEntry,
} from '../src/wire-types/library-model';
import {
  isCatalogResponse, isReleaseResponse, type CatalogResponse, type ReleaseResponse,
} from '../src/wire-types/registry-model';
import {
  isProtocolDocumentV1, createEmptyProtocolDocument,
} from '../src/wire-types/protocol-document';
import { sha256String, verifyIntegrity } from '../src/wire-types/integrity';

function validManifest(): PackageManifest {
  return {
    schema: PACKAGE_MANIFEST_SCHEMA, version: PACKAGE_MANIFEST_VERSION,
    packageId: 'chest-ct', releaseVersion: '1.0.0',
    protocolDoc: createEmptyProtocolDocument('id-1', 'Chest CT', new Date('2026-01-01T00:00:00Z'), 'node-seed'),
    protocolSha256: 'a'.repeat(64),
    snippetFiles: [{ relPath: 'lung.md', sha256: 'b'.repeat(64) }],
    catalogEntryId: 'chest-ct', publishedAt: '2026-01-01T00:00:00Z',
  };
}
function validCatalogEntry(): CatalogEntry {
  return { packageId: 'chest-ct', title: 'Chest CT', description: 'd', author: { displayName: 'X' }, latestVersion: '1.0.0', categories: ['radiology'], updatedAt: 't' };
}

describe('wire-types — isProtocolDocumentV1', () => {
  it('accepts a createEmptyProtocolDocument output', () => {
    expect(isProtocolDocumentV1(createEmptyProtocolDocument('id-1', 'T', new Date('2026-01-01T00:00:00Z'), 'n1'))).toBe(true);
  });
  it('rejects wrong schema sentinel', () => {
    const doc = createEmptyProtocolDocument('id-1', 'T', new Date('2026-01-01T00:00:00Z'), 'n1');
    expect(isProtocolDocumentV1({ ...doc, schema: 'wrong' })).toBe(false);
  });
  it('rejects wrong version', () => {
    const doc = createEmptyProtocolDocument('id-1', 'T', new Date('2026-01-01T00:00:00Z'), 'n1');
    expect(isProtocolDocumentV1({ ...doc, version: 2 })).toBe(false);
  });
  it('rejects non-array nodes', () => {
    const doc = createEmptyProtocolDocument('id-1', 'T', new Date('2026-01-01T00:00:00Z'), 'n1');
    expect(isProtocolDocumentV1({ ...doc, nodes: 'not-array' })).toBe(false);
  });
  it('is shallow — does NOT validate node kind (layoutDirection ignored)', () => {
    const doc = createEmptyProtocolDocument('id-1', 'T', new Date('2026-01-01T00:00:00Z'), 'n1');
    // @ts-expect-error — intentionally wrong kind to prove the guard ignores it
    doc.nodes[0]!.kind = 'bogus';
    expect(isProtocolDocumentV1(doc)).toBe(true);
  });
});

describe('wire-types — isPackageManifest', () => {
  it('accepts a valid manifest', () => {
    expect(isPackageManifest(validManifest())).toBe(true);
  });
  it('rejects wrong schema sentinel', () => {
    expect(isPackageManifest({ ...validManifest(), schema: 'wrong' })).toBe(false);
  });
  it('rejects null author (isOptionalAuthor rejects null)', () => {
    expect(isPackageManifest({ ...validManifest(), author: null })).toBe(false);
  });
  it('accepts absent author (optional)', () => {
    const { author, ...rest } = validManifest();
    expect(isPackageManifest(rest)).toBe(true);
  });
  it('rejects non-array snippetFiles', () => {
    expect(isPackageManifest({ ...validManifest(), snippetFiles: 'x' })).toBe(false);
  });
  it('rejects snippetFiles with bad element (relPath not string)', () => {
    expect(isPackageManifest({ ...validManifest(), snippetFiles: [{ relPath: 42, sha256: 'b'.repeat(64) }] })).toBe(false);
  });
});

describe('wire-types — isCatalogEntry (author REQUIRED)', () => {
  it('accepts a valid entry', () => {
    expect(isCatalogEntry(validCatalogEntry())).toBe(true);
  });
  it('rejects missing author (required, unlike manifest)', () => {
    const { author, ...rest } = validCatalogEntry();
    expect(isCatalogEntry(rest)).toBe(false);
  });
  it('rejects null summary (isOptionalString rejects null)', () => {
    expect(isCatalogEntry({ ...validCatalogEntry(), summary: null })).toBe(false);
  });
  it('rejects categories with non-string element', () => {
    expect(isCatalogEntry({ ...validCatalogEntry(), categories: ['ok', 42] })).toBe(false);
  });
});

describe('wire-types — isCatalogResponse / isReleaseResponse / {manifest} wrapper', () => {
  it('accepts a valid CatalogResponse', () => {
    const body: CatalogResponse = { entries: [validCatalogEntry()], serverTime: 't' };
    expect(isCatalogResponse(body)).toBe(true);
  });
  it('rejects CatalogResponse with non-array entries', () => {
    expect(isCatalogResponse({ entries: 'x', serverTime: 't' })).toBe(false);
  });
  it('accepts a valid ReleaseResponse', () => {
    const body: ReleaseResponse = { manifest: validManifest(), snippetContents: [{ relPath: 'lung.md', content: '# Lung' }] };
    expect(isReleaseResponse(body)).toBe(true);
  });
  it('accepts the manifest-only {manifest} wrapper — extra keys tolerated', () => {
    const wrapper = { manifest: validManifest() };
    expect(isPackageManifest(wrapper.manifest)).toBe(true);
  });
  it('rejects ReleaseResponse with bad snippetContents element', () => {
    expect(isReleaseResponse({ manifest: validManifest(), snippetContents: [{ relPath: 'lung.md' }] })).toBe(false);
  });
});

describe('wire-types — integrity (SHA-256, byte-identical to plugin)', () => {
  it('known-answer vector: sha256String("abc")', async () => {
    expect(await sha256String('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
  it('produces lowercase 64-char hex', async () => {
    expect(await sha256String('hello')).toMatch(/^[0-9a-f]{64}$/);
  });
  it('verifyIntegrity is case-insensitive and never throws on mismatch', async () => {
    expect(await verifyIntegrity('abc', 'BA7816BF8F01CFEA414140DE5DAE2223B00361A396177A9CB410FF61F20015AD')).toBe(true);
    expect(await verifyIntegrity('abc', '0'.repeat(64))).toBe(false);
  });
  it('protocolSha256 contract: SHA-256 of JSON.stringify(doc, null, 2) + newline', async () => {
    const doc = createEmptyProtocolDocument('id-1', 'Chest CT', new Date('2026-01-01T00:00:00Z'), 'node-seed');
    const canonical = JSON.stringify(doc, null, 2) + '\n';
    const expected = await sha256String(canonical);
    expect(await verifyIntegrity(canonical, expected)).toBe(true);
  });
});
