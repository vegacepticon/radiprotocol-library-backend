// Catalog source-of-truth loader + validator (Variant B). The `packages/` directory in the
// repo root is the human/CI-editable content catalog:
//
//   packages/<packageId>/catalog.json              — PackageCatalog (title/desc/categories/author + releases[])
//   packages/<packageId>/releases/<ver>/release.json — ReleaseResponse-shaped bundle ({ manifest, snippetContents })
//
// A release.json is EXACTLY the plugin's export format (LibraryService.writePackageExport),
// so a submission is a plugin-exported file dropped into the right directory — no conversion.
// The loader validates every invariant the served artifacts depend on (identity, hashes,
// catalog consistency, semver ordering) and throws CatalogValidationError with all errors
// aggregated. The generator consumes loadPackagesCatalog(); CI runs the same loader as the
// `check:packages` gate, and the submit proxy runs the same checks before opening a PR.

import fs from 'fs';
import path from 'path';
import {
  isPackageManifest,
  type CatalogEntry,
  type PackageManifest,
} from '../wire-types/library-model';
import { isReleaseResponse, type ReleaseResponse } from '../wire-types/registry-model';
import { sha256String } from '../wire-types/integrity';

/** Pinned catalog serverTime for byte-stable catalog.json output. */
export const CATALOG_SERVER_TIME = '2026-01-01T00:00:00.000Z';

/** Per-package catalog metadata file (packages/<id>/catalog.json). */
export interface PackageCatalog {
  title: string;
  description: string;
  categories: string[];
  author: { displayName: string };
  /** Declared releases; each must have a matching releases/<ver>/release.json on disk. */
  releases: Array<{ releaseVersion: string; createdAt?: string; publishedAt?: string }>;
}

/** One validated release ready for artifact generation. */
export interface LoadedRelease {
  manifest: PackageManifest;
  snippetContents: Array<{ relPath: string; content: string }>;
  catalogEntry: CatalogEntry;
}

/** Aggregated validation failure (all problems listed, not just the first). */
export class CatalogValidationError extends Error {
  readonly errors: string[];
  constructor(errors: string[]) {
    super(`catalog validation failed:\n  - ${errors.join('\n  - ')}`);
    this.name = 'CatalogValidationError';
    this.errors = errors;
  }
}

/** Guard for the hand-edited PackageCatalog file (NOT a wire type — repo-only). */
export function isPackageCatalog(value: unknown): value is PackageCatalog {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v['title'] !== 'string' || typeof v['description'] !== 'string') return false;
  if (!Array.isArray(v['categories']) || !v['categories'].every((c) => typeof c === 'string')) return false;
  const author = v['author'];
  if (typeof author !== 'object' || author === null || typeof (author as Record<string, unknown>)['displayName'] !== 'string') return false;
  if (!Array.isArray(v['releases']) || v['releases'].length === 0) return false;
  return v['releases'].every((r) => {
    if (typeof r !== 'object' || r === null) return false;
    const rel = r as Record<string, unknown>;
    return typeof rel['releaseVersion'] === 'string';
  });
}

/** Strict semver-ish compare (major.minor.patch, prerelease < release). Returns >0 if a>b. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.');
  const pb = b.split('.');
  for (let i = 0; i < 3; i++) {
    const na = parseInt(pa[i] ?? '0', 10) || 0;
    const nb = parseInt(pb[i] ?? '0', 10) || 0;
    if (na !== nb) return na - nb;
  }
  const preA = (pa[2] ?? '').includes('-');
  const preB = (pb[2] ?? '').includes('-');
  if (preA !== preB) return preA ? -1 : 1; // 1.0.0-beta < 1.0.0
  return 0;
}

function readJsonFile(filePath: string, errors: string[]): unknown | undefined {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    errors.push(`${filePath}: unreadable or invalid JSON (${(e as Error).message})`);
    return undefined;
  }
}

/**
 * Load + validate the whole packages/ catalog. Throws CatalogValidationError (aggregated)
 * on any problem. Deterministic: packages sorted by packageId (code-unit order), catalog
 * entries carry latestVersion = max release, updatedAt = max publishedAt.
 */
export async function loadPackagesCatalog(packagesDir = 'packages'): Promise<LoadedRelease[]> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const loaded: LoadedRelease[] = [];

  let packageDirs: string[] = [];
  try {
    packageDirs = fs.readdirSync(packagesDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    throw new CatalogValidationError([`${packagesDir}: directory not readable`]);
  }
  if (packageDirs.length === 0) errors.push(`${packagesDir}: no packages found`);

  for (const packageId of packageDirs) {
    const pkgDir = path.join(packagesDir, packageId);

    const catalogRaw = readJsonFile(path.join(pkgDir, 'catalog.json'), errors);
    if (catalogRaw === undefined) continue;
    if (!isPackageCatalog(catalogRaw)) {
      errors.push(`${pkgDir}/catalog.json: fails isPackageCatalog`);
      continue;
    }

    const releasesDir = path.join(pkgDir, 'releases');
    let versionDirs: string[] = [];
    try {
      versionDirs = fs.readdirSync(releasesDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      errors.push(`${releasesDir}: directory not readable`);
      continue;
    }
    if (versionDirs.length === 0) {
      errors.push(`${releasesDir}: no release directories`);
      continue;
    }
    for (const ver of catalogRaw.releases.map((r) => r.releaseVersion)) {
      if (!versionDirs.includes(ver)) errors.push(`${pkgDir}: catalog.json declares release ${ver} but releases/${ver}/ is missing`);
    }
    for (const ver of versionDirs) {
      if (!catalogRaw.releases.some((r) => r.releaseVersion === ver)) {
        errors.push(`${pkgDir}: releases/${ver}/ exists but catalog.json does not declare it`);
      }
    }

    const pkgReleases: LoadedRelease[] = [];
    for (const ver of versionDirs) {
      const releasePath = path.join(releasesDir, ver, 'release.json');
      const releaseRaw = readJsonFile(releasePath, errors);
      if (releaseRaw === undefined) continue;
      if (!isReleaseResponse(releaseRaw)) {
        errors.push(`${releasePath}: fails isReleaseResponse (must be exactly { manifest, snippetContents } with a valid PackageManifest)`);
        continue;
      }
      const release = releaseRaw as ReleaseResponse;
      const { manifest, snippetContents } = release;

      // Identity: directory names are authoritative.
      if (manifest.packageId !== packageId) errors.push(`${releasePath}: manifest.packageId "${manifest.packageId}" !== directory "${packageId}"`);
      if (manifest.releaseVersion !== ver) errors.push(`${releasePath}: manifest.releaseVersion "${manifest.releaseVersion}" !== directory "${ver}"`);
      if (manifest.catalogEntryId !== packageId) errors.push(`${releasePath}: manifest.catalogEntryId "${manifest.catalogEntryId}" !== "${packageId}"`);

      // Hash integrity (defense-in-depth: the plugin re-verifies on install, but a bad
      // hash must never reach the registry).
      const protocolCanonical = JSON.stringify(manifest.protocolDoc, null, 2) + '\n';
      const actualProtocolSha = await sha256String(protocolCanonical);
      if (actualProtocolSha !== manifest.protocolSha256.toLowerCase()) {
        errors.push(`${releasePath}: protocolSha256 mismatch (expected ${manifest.protocolSha256}, computed ${actualProtocolSha})`);
      }
      const contentByPath = new Map(snippetContents.map((s) => [s.relPath, s.content]));
      for (const f of manifest.snippetFiles) {
        const content = contentByPath.get(f.relPath);
        if (content === undefined) {
          errors.push(`${releasePath}: snippetFiles declares "${f.relPath}" but snippetContents has no such entry`);
          continue;
        }
        const actual = await sha256String(content);
        if (actual !== f.sha256.toLowerCase()) {
          errors.push(`${releasePath}: snippet "${f.relPath}" sha256 mismatch (expected ${f.sha256}, computed ${actual})`);
        }
      }
      for (const s of snippetContents) {
        if (!manifest.snippetFiles.some((f) => f.relPath === s.relPath)) {
          errors.push(`${releasePath}: snippetContents has "${s.relPath}" but snippetFiles does not declare it`);
        }
      }

      const publishedAt = catalogRaw.releases.find((r) => r.releaseVersion === ver)?.publishedAt ?? manifest.publishedAt;
      pkgReleases.push({
        manifest,
        snippetContents,
        catalogEntry: {
          packageId,
          title: catalogRaw.title,
          description: catalogRaw.description,
          author: catalogRaw.author,
          latestVersion: ver, // replaced by max below
          categories: catalogRaw.categories,
          updatedAt: publishedAt,
          // summary intentionally omitted (optional wire field)
        },
      });
    }

    if (pkgReleases.length === 0) continue;
    // latestVersion = max by semver; updatedAt = max publishedAt across releases.
    const latest = pkgReleases.reduce((acc, r) =>
      compareVersions(r.manifest.releaseVersion, acc.manifest.releaseVersion) > 0 ? r : acc,
    );
    const maxUpdated = pkgReleases
      .map((r) => r.manifest.publishedAt)
      .sort()
      .at(-1)!;
    for (const r of pkgReleases) {
      r.catalogEntry.latestVersion = latest.manifest.releaseVersion;
      r.catalogEntry.updatedAt = maxUpdated;
    }
    loaded.push(...pkgReleases);
  }

  // Cross-package: duplicate packageId directories cannot happen (fs), but duplicate
  // slugs after slugification would trip the plugin's FR-7 collision warning. That is a
  // WARNING (the installer namespace is slug+hash, so installs still coexist), not an
  // error — surfaced to the validator output without failing the gate.
  const bySlug = new Map<string, string>();
  for (const packageId of packageDirs) {
    const slug = slugifyForNamespace(packageId);
    const existing = bySlug.get(slug);
    if (existing !== undefined) {
      warnings.push(`slug overlap: "${packageId}" and "${existing}" both slugify to "${slug}" (FR-7 collision warning on install; namespace is slug+hash so they coexist)`);
    } else {
      bySlug.set(slug, packageId);
    }
  }

  if (errors.length > 0) throw new CatalogValidationError(errors);
  for (const w of warnings) console.warn(`⚠ ${w}`);
  loaded.sort((a, b) => (a.manifest.packageId < b.manifest.packageId ? -1 : a.manifest.packageId > b.manifest.packageId ? 1 : 0));
  return loaded;
}

/**
 * Slug normalization for the install-namespace collision check. Mirrors the plugin's
 * slugifyPackageId semantics (slugifyLabel: lowercase, non letter/number runs → '-',
 * Unicode-aware so Cyrillic is preserved, edge dashes stripped); duplicated here because
 * the backend has no plugin imports (the parity gate pins the plugin's copy).
 *
 * NOTE: the installer's namespace segment is actually `slug-shortHash(rawId)`
 * (library-paths.packageNamespaceSegment), so distinct raw ids never collide on disk —
 * this check mirrors only the legacy slug-only semantics that buildLocalPackage's
 * FR-7 `collisionWith` warning uses. The synthetic seed packages "chest-ct" and
 * "chest ct" are therefore a WARNING-level situation, not an error: they coexist by
 * design in the seed (exercising FR3 percent-encoded paths) and install side by side.
 */
export function slugifyForNamespace(packageId: string): string {
  return packageId.toLowerCase().trim().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');
}

/** Build the catalog.json entries view (deduped per package — one entry per packageId). */
export function catalogEntries(releases: LoadedRelease[]): CatalogEntry[] {
  const seen = new Set<string>();
  const entries: CatalogEntry[] = [];
  for (const r of releases) {
    if (seen.has(r.catalogEntry.packageId)) continue;
    seen.add(r.catalogEntry.packageId);
    entries.push(r.catalogEntry);
  }
  return entries;
}

/** Re-export for the CLI validator script (keeps scripts thin). */
export { isPackageManifest };
