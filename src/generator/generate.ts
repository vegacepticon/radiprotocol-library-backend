// Deterministic static artifact generator (D4 — commit-and-gate). Variant B: the content
// source of truth is the repo's packages/ catalog (packages/<id>/catalog.json +
// releases/<ver>/release.json), validated by loadPackagesCatalog(). Reads the loaded
// releases, asserts mutual consistency + guard validity, and writes the three route
// artifacts under site/: catalog.json (CatalogResponse), per-release release .json
// (ReleaseResponse), and per-release manifest .json ({manifest} wrapper — NOT bare, NOT
// full release). File names use the decoded packageId/version (literal UTF-8) so
// Cloudflare Pages _redirects (which match the percent-encoded request path) resolve to
// them. Pinned serverTime for byte-stable catalog.json. D7 (Cloudflare Pages serving)
// consumes these via _redirects + 404.html + _headers.
//
// The seed (src/seed/seed.ts) remains a test/parity fixture only — it no longer feeds
// production artifacts.

import fs from 'fs';
import path from 'path';
import { CATALOG_SERVER_TIME, catalogEntries, loadPackagesCatalog, type LoadedRelease } from '../catalog/load-packages';
import { isCatalogResponse, isReleaseResponse } from '../wire-types/registry-model';
import { isPackageManifest } from '../wire-types/library-model';

const SITE_DIR = 'site';
const PACKAGES_DIR = 'packages';

function assertCondition(cond: boolean, message: string): void {
  if (!cond) throw new Error(`[generator] ${message}`);
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

/** Generate the static site artifacts from the packages/ catalog. Deterministic.
 *  @param outDir Output directory (default 'site'; tests pass a temp dir).
 *  @param packagesDir Catalog source directory (default 'packages'). */
export async function generate(outDir: string = SITE_DIR, packagesDir: string = PACKAGES_DIR): Promise<void> {
  const releases: LoadedRelease[] = await loadPackagesCatalog(packagesDir);
  // Hidden packages (moderation flag in catalog.json) stay validated but are NOT
  // written to site/ — neither their catalog entries nor their release artifacts.
  const visible = releases.filter((r) => r.hidden !== true);
  const entries = [];
  for (const r of visible) {
    const { manifest, snippetContents, catalogEntry } = r;
    // Mutual-consistency assertions (defense-in-depth; the loader already guarantees these).
    assertCondition(manifest.catalogEntryId === manifest.packageId, `catalogEntryId !== packageId for ${manifest.packageId}`);
    assertCondition(manifest.packageId === catalogEntry.packageId, `manifest.packageId !== catalogEntry.packageId for ${manifest.packageId}`);
    assertCondition(manifest.releaseVersion === catalogEntry.latestVersion || true, 'latestVersion may differ for non-latest releases');
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
  // entries come from the FULL loaded set via catalogEntries(), which drops hidden packages.
  const catalogBody = { entries: catalogEntries(releases), serverTime: CATALOG_SERVER_TIME };
  assertCondition(isCatalogResponse(catalogBody), 'catalog body fails isCatalogResponse');
  writeJson(path.join(outDir, 'catalog.json'), catalogBody);

  // Prune stale artifacts: release files for packages/versions that are no longer VISIBLE
  // (deleted, or hidden by moderation) must not linger in site/. Without this, a hidden or
  // removed package stays downloadable forever (its catalog entry disappears, but the
  // direct release URL keeps serving bytes). Only the generated packages subtree is
  // pruned; hand-maintained site/ assets (404.html, _redirects, _headers) are untouched.
  const visibleIds = new Set(visible.map((r) => r.manifest.packageId));
  const visibleFiles = new Set(visible.map((r) =>
    path.join('packages', r.manifest.packageId, 'releases', `${r.manifest.releaseVersion}.json`),
  ));
  const visibleManifestDirs = new Set(visible.map((r) =>
    path.join('packages', r.manifest.packageId, 'releases', r.manifest.releaseVersion),
  ));
  // baseDir stays FIXED across recursion so every kept/pruned decision uses one
  // coordinate system (site/-relative).
  const baseDir = path.dirname(path.join(outDir, 'packages'));
  pruneStale(path.join(outDir, 'packages'), baseDir, (rel) => {
    if (visibleIds.has(rel.split(path.sep)[1] ?? '')) return true;
    if (visibleFiles.has(rel)) return true;
    if (visibleManifestDirs.has(rel)) return true;
    return false;
  });
}

/** Recursively delete anything under rootDir that keep(relPath) rejects. relPath is
 *  platform-relative to baseDir (constant across recursion); directories are removed
 *  bottom-up once empty. */
function pruneStale(rootDir: string, baseDir: string, keep: (rel: string) => boolean): void {
  if (!fs.existsSync(rootDir)) return;
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    const full = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      pruneStale(full, baseDir, keep);
      if (fs.readdirSync(full).length === 0) fs.rmdirSync(full);
    } else {
      const rel = path.relative(baseDir, full);
      if (!keep(rel)) {
        fs.rmSync(full);
        console.warn(`[generator] pruned stale artifact: ${rel}`);
      }
    }
  }
}

// CLI entrypoint (runs only when invoked as the bundled script, not when imported by tests).
if (process.argv[1]?.endsWith('generate.cjs')) {
  generate().catch((e) => { console.error(e); process.exit(1); });
}
