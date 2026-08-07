// DUPLICATED from the plugin's src/library/library-model.ts (D2 — hand-written
// byte-for-byte; D5 — parity gate compares the served types). Mirror of the SERVED wire
// types + guards: PackageManifest, CatalogEntry, PackageSnippetFile + isPackageManifest/
// isCatalogEntry (and the private helpers isPackageSnippetFile/isOptionalAuthor/
// isOptionalString). Client-only types (CatalogSnapshot, InstalledRecord, ReleaseBundle,
// CatalogFetchResult, LibraryStoreError) are NOT duplicated — they are not served on the
// wire; the parity gate (Slice 4) compares only the served types.

import { isProtocolDocumentV1, type ProtocolDocumentV1 } from './protocol-document';

export const PACKAGE_MANIFEST_SCHEMA = 'radiprotocol.package' as const;
export const PACKAGE_MANIFEST_VERSION = 1 as const;

export interface PackageSnippetFile {
  relPath: string;
  sha256: string;
}

export interface PackageManifest {
  readonly schema: typeof PACKAGE_MANIFEST_SCHEMA;
  readonly version: typeof PACKAGE_MANIFEST_VERSION;
  packageId: string;
  releaseVersion: string;
  protocolDoc: ProtocolDocumentV1;
  protocolSha256: string;
  snippetFiles: PackageSnippetFile[];
  catalogEntryId: string;
  author?: { displayName: string };
  publishedAt: string;
}

export interface CatalogEntry {
  packageId: string;
  title: string;
  description: string;
  author: { displayName: string };
  latestVersion: string;
  categories: string[];
  updatedAt: string;
  summary?: string;
}

function isPackageSnippetFile(value: unknown): value is PackageSnippetFile {
  if (typeof value !== 'object' || value === null) return false;
  const f = value as Record<string, unknown>;
  return typeof f['relPath'] === 'string' && typeof f['sha256'] === 'string';
}

function isOptionalAuthor(value: unknown): boolean {
  if (value === undefined) return true;
  if (typeof value !== 'object' || value === null) return false;
  return typeof (value as Record<string, unknown>)['displayName'] === 'string';
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

export function isPackageManifest(value: unknown): value is PackageManifest {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v['schema'] === PACKAGE_MANIFEST_SCHEMA &&
    v['version'] === PACKAGE_MANIFEST_VERSION &&
    typeof v['packageId'] === 'string' &&
    typeof v['releaseVersion'] === 'string' &&
    isProtocolDocumentV1(v['protocolDoc']) &&
    typeof v['protocolSha256'] === 'string' &&
    Array.isArray(v['snippetFiles']) &&
    v['snippetFiles'].every((f) => isPackageSnippetFile(f)) &&
    typeof v['catalogEntryId'] === 'string' &&
    typeof v['publishedAt'] === 'string' &&
    isOptionalAuthor(v['author'])
  );
}

export function isCatalogEntry(value: unknown): value is CatalogEntry {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  const author = v['author'];
  const authorOk =
    typeof author === 'object' &&
    author !== null &&
    typeof (author as Record<string, unknown>)['displayName'] === 'string';
  return (
    typeof v['packageId'] === 'string' &&
    typeof v['title'] === 'string' &&
    typeof v['description'] === 'string' &&
    typeof v['latestVersion'] === 'string' &&
    Array.isArray(v['categories']) &&
    v['categories'].every((c) => typeof c === 'string') &&
    typeof v['updatedAt'] === 'string' &&
    isOptionalString(v['summary']) &&
    authorOk
  );
}
