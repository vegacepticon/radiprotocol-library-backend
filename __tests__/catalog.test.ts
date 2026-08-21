import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  loadPackagesCatalog, catalogEntries, compareVersions,
  slugifyForNamespace, CatalogValidationError, isPackageCatalog,
} from '../src/catalog/load-packages';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

// A minimal valid release bundle (mirrors the seed's shape).
async function writePackage(opts: {
  packageId: string;
  version?: string;
  title?: string;
  declaredVersions?: string[];
  appendReleases?: boolean;
  omitRelease?: boolean;
  corruptHash?: boolean;
}): Promise<void> {
  const version = opts.version ?? '1.0.0';
  const doc = {
    schema: 'radiprotocol.protocol', version: 1,
    id: `${opts.packageId}-1`, title: opts.title ?? `Pkg ${opts.packageId}`,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    nodes: [{ id: 'n1', kind: 'start', x: 0, y: 0, width: 200, height: 80, fields: {} }],
    edges: [], layoutDirection: 'LR',
  };
  const canonical = JSON.stringify(doc, null, 2) + '\n';
  // sha256 of the canonical bytes via the same Web Crypto the loader uses.
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  const protocolSha256 = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  const snippetContent = '# Snippet\n\ntext\n';
  const sDigest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(snippetContent));
  let snippetSha = [...new Uint8Array(sDigest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  if (opts.corruptHash) snippetSha = '0'.repeat(64);

  const manifest = {
    schema: 'radiprotocol.package', version: 1,
    packageId: opts.packageId, releaseVersion: version,
    protocolDoc: doc, protocolSha256,
    snippetFiles: [{ relPath: 's.md', sha256: snippetSha }],
    catalogEntryId: opts.packageId,
    author: { displayName: 'A' }, publishedAt: '2026-01-01T00:00:00.000Z',
  };
  const relDir = path.join(dir, opts.packageId, 'releases', version);
  fs.mkdirSync(relDir, { recursive: true });
  if (!opts.omitRelease) {
    fs.writeFileSync(path.join(relDir, 'release.json'), JSON.stringify({
      manifest,
      snippetContents: [{ relPath: 's.md', content: snippetContent }],
    }, null, 2) + '\n');
  }
  const cat = {
    title: opts.title ?? `Pkg ${opts.packageId}`,
    description: 'desc', categories: ['c'], author: { displayName: 'A' },
    releases: (opts.appendReleases === false
      ? (opts.declaredVersions ?? [version])
      : [...(opts.declaredVersions ?? []), version]
    ).map((v) => ({ releaseVersion: v })),
  };
  fs.writeFileSync(path.join(dir, opts.packageId, 'catalog.json'), JSON.stringify(cat, null, 2) + '\n');
}

describe('loadPackagesCatalog — valid catalogs', () => {
  it('loads a single package with identity + hashes intact', async () => {
    await writePackage({ packageId: 'chest-ct' });
    const releases = await loadPackagesCatalog(dir);
    expect(releases).toHaveLength(1);
    expect(releases[0]!.manifest.packageId).toBe('chest-ct');
    expect(releases[0]!.manifest.releaseVersion).toBe('1.0.0');
    expect(releases[0]!.catalogEntry.latestVersion).toBe('1.0.0');
    expect(releases[0]!.catalogEntry.updatedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('sorts packages by packageId deterministically (code-unit order)', async () => {
    await writePackage({ packageId: 'zeta' });
    await writePackage({ packageId: 'alpha' });
    const releases = await loadPackagesCatalog(dir);
    expect(releases.map((r) => r.manifest.packageId)).toEqual(['alpha', 'zeta']);
  });

  it('multi-release package: latestVersion = max semver, updatedAt = max publishedAt', async () => {
    await writePackage({ packageId: 'p', version: '1.0.0' });
    await writePackage({ packageId: 'p', version: '1.10.0' });
    await writePackage({ packageId: 'p', version: '0.9.0' });
    // The helper overwrites catalog.json each call — rewrite it declaring ALL versions.
    fs.writeFileSync(path.join(dir, 'p', 'catalog.json'), JSON.stringify({
      title: 'Pkg p', description: 'desc', categories: ['c'], author: { displayName: 'A' },
      releases: ['1.0.0', '1.10.0', '0.9.0'].map((v) => ({ releaseVersion: v })),
    }, null, 2) + '\n');
    const releases = await loadPackagesCatalog(dir);
    expect(releases).toHaveLength(3);
    for (const r of releases) {
      expect(r.catalogEntry.latestVersion).toBe('1.10.0');
      expect(r.catalogEntry.updatedAt).toBe('2026-01-01T00:00:00.000Z');
    }
    expect(catalogEntries(releases)).toHaveLength(1);
  });

  it('empty directory throws CatalogValidationError', async () => {
    await expect(loadPackagesCatalog(dir)).rejects.toBeInstanceOf(CatalogValidationError);
  });
});

describe('loadPackagesCatalog — invalid catalogs (aggregated errors)', () => {
  it('missing release.json is an error', async () => {
    await writePackage({ packageId: 'p', omitRelease: true });
    await expect(loadPackagesCatalog(dir)).rejects.toThrow(/no release directories|unreadable or invalid/);
  });

  it('undeclared version dir + declared-but-missing version are both errors', async () => {
    await writePackage({ packageId: 'p', declaredVersions: ['1.0.0', '2.0.0'] });
    fs.mkdirSync(path.join(dir, 'p', 'releases', '3.0.0'), { recursive: true });
    try {
      await loadPackagesCatalog(dir);
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(CatalogValidationError);
      const errs = (e as CatalogValidationError).errors;
      expect(errs.some((x) => x.includes('declares release 2.0.0'))).toBe(true);
      expect(errs.some((x) => x.includes('releases/3.0.0/ exists but'))).toBe(true);
    }
  });

  it('corrupted snippet hash fails validation', async () => {
    await writePackage({ packageId: 'p', corruptHash: true });
    await expect(loadPackagesCatalog(dir)).rejects.toThrow(/snippet "s\.md" sha256 mismatch/);
  });

  it('identity mismatch between manifest and directories fails', async () => {
    await writePackage({ packageId: 'p' });
    const releasePath = path.join(dir, 'p', 'releases', '1.0.0', 'release.json');
    const body = JSON.parse(fs.readFileSync(releasePath, 'utf8'));
    body.manifest.packageId = 'other-id';
    fs.writeFileSync(releasePath, JSON.stringify(body, null, 2));
    await expect(loadPackagesCatalog(dir)).rejects.toThrow(/manifest\.packageId "other-id" !== directory "p"/);
  });

  it('invalid catalog.json shape fails with isPackageCatalog message', async () => {
    fs.mkdirSync(path.join(dir, 'p'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'p', 'catalog.json'), '{"title": "no releases"}');
    await expect(loadPackagesCatalog(dir)).rejects.toThrow(/fails isPackageCatalog/);
  });

  it('aggregates MULTIPLE errors across packages in one throw', async () => {
    await writePackage({ packageId: 'bad-a', omitRelease: true });
    await writePackage({ packageId: 'bad-b', corruptHash: true });
    try {
      await loadPackagesCatalog(dir);
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(CatalogValidationError);
      expect((e as CatalogValidationError).errors.length).toBeGreaterThanOrEqual(2);
    }
  });
});

describe('helpers', () => {
  it('compareVersions orders semver numerically (not lexicographically)', () => {
    expect(compareVersions('1.10.0', '1.9.0')).toBeGreaterThan(0);
    expect(compareVersions('2.0.0', '1.99.99')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0-beta', '1.0.0')).toBeLessThan(0);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
  });

  it('slugifyForNamespace mirrors the plugin slugifyLabel semantics', () => {
    expect(slugifyForNamespace('Chest CT')).toBe('chest-ct');
    expect(slugifyForNamespace('КТ грудной клетки')).toBe('кт-грудной-клетки');
    expect(slugifyForNamespace('--weird--id--')).toBe('weird-id');
  });

  it('isPackageCatalog accepts the migrated shape and rejects garbage', () => {
    expect(isPackageCatalog({ title: 't', description: 'd', categories: ['c'], author: { displayName: 'a' }, releases: [{ releaseVersion: '1.0.0' }] })).toBe(true);
    expect(isPackageCatalog({ title: 't', description: 'd', categories: ['c'], author: { displayName: 'a' }, releases: [] })).toBe(false);
    expect(isPackageCatalog(null)).toBe(false);
    expect(isPackageCatalog('x')).toBe(false);
  });
});
