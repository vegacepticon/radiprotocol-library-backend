import { describe, it, expect } from 'vitest';
import { SEED, buildSeedReleases } from '../src/seed/seed';
import { isPackageManifest, isCatalogEntry } from '../src/wire-types/library-model';
import { sha256String } from '../src/wire-types/integrity';

describe('seed — definition invariants', () => {
  it('includes a Cyrillic packageId and one with a space (FR3)', () => {
    const ids = SEED.map((p) => p.packageId);
    expect(ids).toContain('КТ-грудная-клетка');
    expect(ids).toContain('chest ct');
  });
  it('all packageIds are slash-free (a %2F would decode into a path separator)', () => {
    for (const p of SEED) expect(p.packageId.includes('/')).toBe(false);
  });
  it('all releaseVersions are slash-free', () => {
    for (const p of SEED) expect(p.releaseVersion.includes('/')).toBe(false);
  });
  it('every snippet file relPath ends with .md and is traversal-safe', () => {
    for (const p of SEED) for (const f of p.snippetFiles) {
      expect(f.relPath.endsWith('.md')).toBe(true);
      expect(f.relPath.includes('..')).toBe(false);
      expect(f.relPath.startsWith('/')).toBe(false);
    }
  });
  it('every snippetNode snippetPath matches a snippetFile relPath', () => {
    for (const p of SEED) {
      const relPaths = new Set(p.snippetFiles.map((f) => f.relPath));
      for (const sn of p.snippetNodes) expect(relPaths.has(sn.snippetPath)).toBe(true);
    }
  });
});

describe('seed — buildSeedReleases', () => {
  it('produces one release per seed package', async () => {
    const releases = await buildSeedReleases();
    expect(releases).toHaveLength(SEED.length);
  });
  it('each manifest passes isPackageManifest', async () => {
    const releases = await buildSeedReleases();
    for (const r of releases) expect(isPackageManifest(r.manifest)).toBe(true);
  });
  it('each catalogEntry passes isCatalogEntry', async () => {
    const releases = await buildSeedReleases();
    for (const r of releases) expect(isCatalogEntry(r.catalogEntry)).toBe(true);
  });
  it('catalogEntryId === packageId (identity)', async () => {
    const releases = await buildSeedReleases();
    for (const r of releases) expect(r.manifest.catalogEntryId).toBe(r.manifest.packageId);
  });
  it('snippetContents relPath set === snippetFiles relPath set', async () => {
    const releases = await buildSeedReleases();
    for (const r of releases) {
      const contentPaths = new Set(r.snippetContents.map((s) => s.relPath));
      const filePaths = new Set(r.manifest.snippetFiles.map((f) => f.relPath));
      expect(contentPaths).toEqual(filePaths);
    }
  });
  it('protocolSha256 === SHA-256 of JSON.stringify(protocolDoc, null, 2) + newline', async () => {
    const releases = await buildSeedReleases();
    for (const r of releases) {
      const canonical = JSON.stringify(r.manifest.protocolDoc, null, 2) + '\n';
      expect(r.manifest.protocolSha256).toBe(await sha256String(canonical));
    }
  });
  it('each snippetFiles sha256 === SHA-256 of the matching content bytes', async () => {
    const releases = await buildSeedReleases();
    for (const r of releases) {
      const contentMap = new Map(r.snippetContents.map((s) => [s.relPath, s.content]));
      for (const f of r.manifest.snippetFiles) {
        expect(f.sha256).toBe(await sha256String(contentMap.get(f.relPath)!));
      }
    }
  });
  it('is deterministic — building twice produces byte-identical manifests', async () => {
    const a = await buildSeedReleases();
    const b = await buildSeedReleases();
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
  it('known-answer SHA-256 vector holds', async () => {
    expect(await sha256String('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
