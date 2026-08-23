import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createHash } from 'crypto';
import { generate } from '../src/generator/generate';
import { isCatalogResponse, isReleaseResponse } from '../src/wire-types/registry-model';
import { isPackageManifest } from '../src/wire-types/library-model';
import { buildSeedReleases, SEED_SERVER_TIME } from '../src/seed/seed';

let outDir: string;
beforeEach(() => { outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-')); });
afterEach(() => { fs.rmSync(outDir, { recursive: true, force: true }); });
function readJson(p: string): unknown { return JSON.parse(fs.readFileSync(p, 'utf8')); }

describe('generator — output validity', () => {
  it('writes site/catalog.json that passes isCatalogResponse', async () => {
    await generate(outDir);
    expect(isCatalogResponse(readJson(path.join(outDir, 'catalog.json')))).toBe(true);
  });
  it('writes one release .json + one manifest .json per seed package, all passing guards', async () => {
    const releases = await buildSeedReleases();
    await generate(outDir);
    for (const r of releases) {
      const releasePath = path.join(outDir, 'packages', r.manifest.packageId, 'releases', `${r.manifest.releaseVersion}.json`);
      const manifestPath = path.join(outDir, 'packages', r.manifest.packageId, 'releases', r.manifest.releaseVersion, 'manifest.json');
      expect(fs.existsSync(releasePath)).toBe(true);
      expect(fs.existsSync(manifestPath)).toBe(true);
      expect(isReleaseResponse(readJson(releasePath))).toBe(true);
      expect(isPackageManifest((readJson(manifestPath) as { manifest: unknown }).manifest)).toBe(true);
    }
  });
  it('release manifest identity === path segments === catalog entry', async () => {
    const releases = await buildSeedReleases();
    await generate(outDir);
    const catalog = readJson(path.join(outDir, 'catalog.json')) as { entries: Array<{ packageId: string; latestVersion: string }> };
    for (const r of releases) {
      const releasePath = path.join(outDir, 'packages', r.manifest.packageId, 'releases', `${r.manifest.releaseVersion}.json`);
      const body = readJson(releasePath) as { manifest: { packageId: string; releaseVersion: string } };
      expect(body.manifest.packageId).toBe(r.manifest.packageId);
      expect(body.manifest.releaseVersion).toBe(r.manifest.releaseVersion);
      const entry = catalog.entries.find((e) => e.packageId === r.manifest.packageId);
      expect(entry).toBeDefined();
      expect(entry!.latestVersion).toBe(r.manifest.releaseVersion);
    }
  });
  it('catalog serverTime === SEED_SERVER_TIME (pinned, byte-stable)', async () => {
    await generate(outDir);
    const catalog = readJson(path.join(outDir, 'catalog.json')) as { serverTime: string };
    expect(catalog.serverTime).toBe(SEED_SERVER_TIME);
  });
  it('Cyrillic + space packageIds produce literal-UTF-8-named files (FR3)', async () => {
    await generate(outDir);
    expect(fs.existsSync(path.join(outDir, 'packages', 'КТ-грудная-клетка', 'releases', '1.0.0.json'))).toBe(true);
    expect(fs.existsSync(path.join(outDir, 'packages', 'КТ-грудная-клетка', 'releases', '1.0.0', 'manifest.json'))).toBe(true);
    expect(fs.existsSync(path.join(outDir, 'packages', 'chest ct', 'releases', '1.0.0.json'))).toBe(true);
    expect(fs.existsSync(path.join(outDir, 'packages', 'chest ct', 'releases', '1.0.0', 'manifest.json'))).toBe(true);
  });
  it('the manifest-only route body is exactly { manifest } (NOT bare, NOT full release)', async () => {
    await generate(outDir);
    const manifestOnly = readJson(path.join(outDir, 'packages', 'chest-ct', 'releases', '1.0.0', 'manifest.json')) as Record<string, unknown>;
    expect(Object.keys(manifestOnly)).toEqual(['manifest']);
  });
});

describe('generator — hidden packages', () => {
  function makeVaultPkg(pkgDir: string, packageId: string, opts: { hidden?: boolean } = {}): void {
    const doc = {
      schema: 'radiprotocol.protocol', version: 1,
      id: `${packageId}-1`, title: `Pkg ${packageId}`,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      nodes: [{ id: 'n1', kind: 'start', x: 0, y: 0, width: 200, height: 80, fields: {} }],
      edges: [], layoutDirection: 'LR',
    };
    const canonical = JSON.stringify(doc, null, 2) + '\n';
    const digest = createHash('sha256').update(canonical).digest('hex');
    const manifest = {
      schema: 'radiprotocol.package', version: 1,
      packageId, releaseVersion: '1.0.0',
      protocolDoc: doc, protocolSha256: digest,
      snippetFiles: [{ relPath: 's.md', sha256: digest }],
      catalogEntryId: packageId,
      author: { displayName: 'A' }, publishedAt: '2026-01-01T00:00:00.000Z',
    };
    const content = '# Snippet\n\ntext\n';
    const sDigest = createHash('sha256').update(content).digest('hex');
    manifest.snippetFiles[0]!.sha256 = sDigest;
    fs.mkdirSync(path.join(pkgDir, packageId, 'releases', '1.0.0'), { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, packageId, 'releases', '1.0.0', 'release.json'),
      JSON.stringify({ manifest, snippetContents: [{ relPath: 's.md', content }] }, null, 2) + '\n',
    );
    const cat: Record<string, unknown> = {
      title: `Pkg ${packageId}`, description: 'desc', categories: ['c'],
      author: { displayName: 'A' }, releases: [{ releaseVersion: '1.0.0' }],
    };
    if (opts.hidden === true) cat['hidden'] = true;
    fs.writeFileSync(path.join(pkgDir, packageId, 'catalog.json'), JSON.stringify(cat, null, 2) + '\n');
  }

  it('excludes hidden packages from catalog.json AND skips their release artifacts', async () => {
    const pkgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkgs-'));
    try {
      makeVaultPkg(pkgDir, 'visible-one');
      makeVaultPkg(pkgDir, 'ghost-pkg', { hidden: true });
      await generate(outDir, pkgDir);
      const catalog = readJson(path.join(outDir, 'catalog.json')) as { entries: Array<{ packageId: string }> };
      expect(catalog.entries.map((e) => e.packageId)).toEqual(['visible-one']);
      expect(fs.existsSync(path.join(outDir, 'packages', 'visible-one', 'releases', '1.0.0.json'))).toBe(true);
      expect(fs.existsSync(path.join(outDir, 'packages', 'ghost-pkg'))).toBe(false);
    } finally {
      fs.rmSync(pkgDir, { recursive: true, force: true });
    }
  });

  it('prunes stale artifacts of deleted AND hidden packages on regeneration (no zombie downloads)', async () => {
    const pkgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkgs-'));
    try {
      makeVaultPkg(pkgDir, 'kept');
      makeVaultPkg(pkgDir, 'removed');
      makeVaultPkg(pkgDir, 'hidden-now', { hidden: false });
      await generate(outDir, pkgDir); // first pass: everything written
      expect(fs.existsSync(path.join(outDir, 'packages', 'removed', 'releases', '1.0.0.json'))).toBe(true);

      // Second pass: one package deleted, one hidden.
      fs.rmSync(path.join(pkgDir, 'removed'), { recursive: true, force: true });
      makeVaultPkg(pkgDir, 'hidden-now', { hidden: true });
      await generate(outDir, pkgDir);

      expect(fs.existsSync(path.join(outDir, 'packages', 'kept', 'releases', '1.0.0.json'))).toBe(true);
      expect(fs.existsSync(path.join(outDir, 'packages', 'removed'))).toBe(false);
      expect(fs.existsSync(path.join(outDir, 'packages', 'hidden-now'))).toBe(false);
      const catalog = readJson(path.join(outDir, 'catalog.json')) as { entries: Array<{ packageId: string }> };
      expect(catalog.entries.map((e) => e.packageId)).toEqual(['kept']);
    } finally {
      fs.rmSync(pkgDir, { recursive: true, force: true });
    }
  });
});

describe('generator — determinism', () => {
  it('is deterministic — generating twice produces byte-identical files (raw bytes, ALL files)', async () => {
    await generate(outDir);
    const outDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-'));
    try {
      await generate(outDir2);
      const walk = (dir: string): string[] => {
        const out: string[] = [];
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) out.push(...walk(full));
          else out.push(full);
        }
        return out;
      };
      const files = walk(outDir);
      expect(files.length).toBeGreaterThan(0);
      for (const f of files) {
        const rel = path.relative(outDir, f);
        const f2 = path.join(outDir2, rel);
        expect(fs.existsSync(f2)).toBe(true);
        expect(fs.readFileSync(f, 'utf8')).toBe(fs.readFileSync(f2, 'utf8'));
      }
    } finally {
      fs.rmSync(outDir2, { recursive: true, force: true });
    }
  });
});
