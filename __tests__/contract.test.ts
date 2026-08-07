import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { generate } from '../src/generator/generate';
import { isCatalogResponse, isReleaseResponse } from '../src/wire-types/registry-model';
import { isPackageManifest } from '../src/wire-types/library-model';
import { buildSeedReleases } from '../src/seed/seed';

let siteDir: string;
beforeEach(() => { siteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'contract-')); });
afterEach(() => { fs.rmSync(siteDir, { recursive: true, force: true }); });

describe('contract — the three read routes (simulated against the generated site/)', () => {
  it('GET /catalog → CatalogResponse passing isCatalogResponse', async () => {
    await generate(siteDir);
    const catalog = JSON.parse(fs.readFileSync(path.join(siteDir, 'catalog.json'), 'utf8'));
    expect(isCatalogResponse(catalog)).toBe(true);
  });

  it('GET /packages/{enc(id)}/releases/{enc(ver)} → ReleaseResponse; the encode→decode round-trip resolves to the literal-UTF-8 file + identity matches (FR3)', async () => {
    await generate(siteDir);
    const releases = await buildSeedReleases();
    for (const r of releases) {
      const id = r.manifest.packageId;
      const ver = r.manifest.releaseVersion;
      const encId = encodeURIComponent(id);
      const encVer = encodeURIComponent(ver);
      if (id !== 'chest-ct') expect(encId).not.toBe(id); // encoding non-trivial for Cyrillic + space
      const decodedId = decodeURIComponent(encId);
      const decodedVer = decodeURIComponent(encVer);
      expect(decodedId).toBe(id);   // the percent-encode → decode round-trip is lossless
      expect(decodedVer).toBe(ver);
      const releasePath = path.join(siteDir, 'packages', decodedId, 'releases', `${decodedVer}.json`);
      expect(fs.existsSync(releasePath)).toBe(true);
      const body = JSON.parse(fs.readFileSync(releasePath, 'utf8'));
      expect(isReleaseResponse(body)).toBe(true);
      expect(body.manifest.packageId).toBe(id);
      expect(body.manifest.releaseVersion).toBe(ver);
    }
  });

  it('GET /packages/{enc(id)}/releases/{enc(ver)}/manifest → { manifest } wrapper; the encode→decode round-trip resolves to the literal-UTF-8 file + identity matches', async () => {
    await generate(siteDir);
    const releases = await buildSeedReleases();
    for (const r of releases) {
      const id = r.manifest.packageId;
      const ver = r.manifest.releaseVersion;
      const decodedId = decodeURIComponent(encodeURIComponent(id));
      const decodedVer = decodeURIComponent(encodeURIComponent(ver));
      expect(decodedId).toBe(id);   // the percent-encode → decode round-trip is lossless
      expect(decodedVer).toBe(ver);
      const manifestPath = path.join(siteDir, 'packages', decodedId, 'releases', decodedVer, 'manifest.json');
      expect(fs.existsSync(manifestPath)).toBe(true);
      const body = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { manifest: unknown };
      expect(isPackageManifest(body.manifest)).toBe(true);
      expect((body.manifest as { packageId: string; releaseVersion: string }).packageId).toBe(id);
      expect((body.manifest as { packageId: string; releaseVersion: string }).releaseVersion).toBe(ver);
      expect(Object.keys(body)).toEqual(['manifest']); // the wrapper, NOT bare, NOT full release
    }
  });

  it('404 behavior: an unknown release has NO generated .json (→ _redirects falls through) + site/404.html + _redirects are committed', async () => {
    await generate(siteDir);
    expect(fs.existsSync(path.join(siteDir, 'packages', 'unknown', 'releases', '9.9.9.json'))).toBe(false);
    expect(fs.existsSync(path.join(siteDir, 'packages', 'unknown', 'releases', '9.9.9', 'manifest.json'))).toBe(false);
    expect(fs.existsSync('site/404.html')).toBe(true);
    expect(fs.existsSync('site/_redirects')).toBe(true);
  });

  it('every generated file passes the backend guards (== plugin guards, per the parity gate)', async () => {
    await generate(siteDir);
    const releases = await buildSeedReleases();
    const catalog = JSON.parse(fs.readFileSync(path.join(siteDir, 'catalog.json'), 'utf8'));
    expect(isCatalogResponse(catalog)).toBe(true);
    for (const r of releases) {
      const releaseBody = JSON.parse(fs.readFileSync(path.join(siteDir, 'packages', r.manifest.packageId, 'releases', `${r.manifest.releaseVersion}.json`), 'utf8'));
      expect(isReleaseResponse(releaseBody)).toBe(true);
      const manifestBody = JSON.parse(fs.readFileSync(path.join(siteDir, 'packages', r.manifest.packageId, 'releases', r.manifest.releaseVersion, 'manifest.json'), 'utf8'));
      expect(isPackageManifest(manifestBody.manifest)).toBe(true);
    }
  });
});
