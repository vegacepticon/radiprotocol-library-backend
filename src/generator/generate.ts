// Deterministic static artifact generator (D4 — commit-and-gate). Reads the shared seed
// (buildSeedReleases is the source of truth — the hashes are already computed there),
// asserts mutual consistency + guard validity, and writes the three route artifacts under
// site/: catalog.json (CatalogResponse), per-release release .json (ReleaseResponse), and
// per-release manifest .json ({manifest} wrapper — NOT bare, NOT full release). File names
// use the decoded packageId/version (literal UTF-8) so Cloudflare Pages _redirects (which
// match the percent-encoded request path) resolve to them. Pinned serverTime for byte-stable
// catalog.json. D7 (Cloudflare Pages serving) consumes these via _redirects + 404.html + _headers.

import fs from 'fs';
import path from 'path';
import { buildSeedReleases, SEED_SERVER_TIME } from '../seed/seed';
import { isCatalogResponse, isReleaseResponse } from '../wire-types/registry-model';
import { isPackageManifest } from '../wire-types/library-model';

const SITE_DIR = 'site';

function assertCondition(cond: boolean, message: string): void {
  if (!cond) throw new Error(`[generator] ${message}`);
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

/** Generate the static site artifacts from the shared seed. Deterministic.
 *  @param outDir Output directory (default 'site'; tests pass a temp dir). */
export async function generate(outDir: string = SITE_DIR): Promise<void> {
  const releases = await buildSeedReleases();
  const entries = [];
  for (const r of releases) {
    const { manifest, snippetContents, catalogEntry } = r;
    // Mutual-consistency assertions (defense-in-depth; the seed already guarantees these).
    assertCondition(manifest.catalogEntryId === manifest.packageId, `catalogEntryId !== packageId for ${manifest.packageId}`);
    assertCondition(manifest.packageId === catalogEntry.packageId, `manifest.packageId !== catalogEntry.packageId for ${manifest.packageId}`);
    assertCondition(manifest.releaseVersion === catalogEntry.latestVersion, `releaseVersion !== latestVersion for ${manifest.packageId}`);
    const contentPaths = new Set(snippetContents.map((s) => s.relPath));
    const filePaths = new Set(manifest.snippetFiles.map((f) => f.relPath));
    assertCondition(contentPaths.size === filePaths.size && [...contentPaths].every((p) => filePaths.has(p)), `snippetContents/snippetFiles relPath mismatch for ${manifest.packageId}`);

    // Guard validation (the artifacts must pass the plugin's frozen guards).
    const releaseBody = { manifest, snippetContents };
    assertCondition(isReleaseResponse(releaseBody), `release body fails isReleaseResponse for ${manifest.packageId}`);
    assertCondition(isPackageManifest(manifest), `manifest fails isPackageManifest for ${manifest.packageId}`);
    const manifestOnlyBody = { manifest };

    // Write release .json: site/packages/<id>/releases/<ver>.json (ReleaseResponse).
    writeJson(path.join(outDir, 'packages', manifest.packageId, 'releases', `${manifest.releaseVersion}.json`), releaseBody);
    // Write manifest-only .json: site/packages/<id>/releases/<ver>/manifest.json ({manifest} wrapper).
    writeJson(path.join(outDir, 'packages', manifest.packageId, 'releases', manifest.releaseVersion, 'manifest.json'), manifestOnlyBody);

    entries.push(catalogEntry);
  }
  // Write catalog.json: { entries, serverTime } (CatalogResponse — NO wire sentinel; the client stamps it).
  const catalogBody = { entries, serverTime: SEED_SERVER_TIME };
  assertCondition(isCatalogResponse(catalogBody), 'catalog body fails isCatalogResponse');
  writeJson(path.join(outDir, 'catalog.json'), catalogBody);
}

// CLI entrypoint (runs only when invoked as the bundled script, not when imported by tests).
if (process.argv[1]?.endsWith('generate.cjs')) {
  generate().catch((e) => { console.error(e); process.exit(1); });
}
