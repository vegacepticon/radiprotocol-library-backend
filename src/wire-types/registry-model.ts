// DUPLICATED from the plugin's src/library/registry-model.ts (D2 — hand-written
// byte-for-byte; D5 — parity gate). Mirror: CatalogResponse, ReleaseResponse +
// isCatalogResponse/isReleaseResponse. Zero Obsidian imports. (The plugin's
// ReleaseFetchResult/ReleaseManifestFetchResult are client-side result types, not served
// on the wire — not duplicated.)

import type { CatalogEntry, PackageManifest } from './library-model';
import { isCatalogEntry, isPackageManifest } from './library-model';

export interface CatalogResponse {
  entries: CatalogEntry[];
  serverTime: string;
}

export interface ReleaseResponse {
  manifest: PackageManifest;
  snippetContents: Array<{ relPath: string; content: string }>;
}

export function isCatalogResponse(value: unknown): value is CatalogResponse {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    Array.isArray(v['entries']) &&
    v['entries'].every((e) => isCatalogEntry(e)) &&
    typeof v['serverTime'] === 'string'
  );
}

export function isReleaseResponse(value: unknown): value is ReleaseResponse {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (!isPackageManifest(v['manifest'])) return false;
  if (!Array.isArray(v['snippetContents'])) return false;
  return v['snippetContents'].every((s) => {
    if (typeof s !== 'object' || s === null) return false;
    const sc = s as Record<string, unknown>;
    return typeof sc['relPath'] === 'string' && typeof sc['content'] === 'string';
  });
}
