// Shared seed definition (D10 — inherited decision #3): one seed feeds the phase-1
// generator, the parity-gate probe seeds, the contract tests, AND the future phase-2
// Supabase seed migration. Includes a Cyrillic packageId (КТ-грудная-клетка) + one with
// a space (chest ct) to exercise FR3 (percent-encoded non-ASCII path segments). Pinned
// timestamps for byte-stable deploys. Models after makeBundle (library-installer.test.ts:59-91).

import {
  createEmptyProtocolDocument,
  type ProtocolDocumentV1, type ProtocolNodeRecord, type ProtocolEdgeRecord,
} from '../wire-types/protocol-document';
import {
  PACKAGE_MANIFEST_SCHEMA, PACKAGE_MANIFEST_VERSION,
  type PackageManifest, type PackageSnippetFile, type CatalogEntry,
} from '../wire-types/library-model';
import { sha256String } from '../wire-types/integrity';

/** A snippet file declaration in the seed (relPath + content; the sha256 is computed). */
export interface SeedSnippetFile {
  relPath: string;
  content: string;
}

/** A snippet node wired into the protocol doc (binds a node to a snippet relPath). */
export interface SeedSnippetNode {
  nodeId: string;
  snippetPath: string; // matches a SeedSnippetFile.relPath
}

/** A seed package definition (deterministic; hashes computed by buildSeedReleases). */
export interface SeedPackage {
  packageId: string;       // slash-free; the seed includes a Cyrillic + a space id
  releaseVersion: string;
  title: string;
  description: string;
  categories: string[];
  authorDisplayName: string;
  createdAt: string;
  updatedAt: string;
  publishedAt: string;
  protocolId: string;
  startNodeId: string;
  snippetFiles: SeedSnippetFile[];
  snippetNodes: SeedSnippetNode[];
}

/** Pinned catalog serverTime for byte-stable catalog.json. */
export const SEED_SERVER_TIME = '2026-01-01T00:00:00.000Z';

/** The seed definition — the single source feeding the generator + parity probes + tests. */
export const SEED: SeedPackage[] = [
  {
    packageId: 'chest-ct',
    releaseVersion: '1.0.0',
    title: 'Chest CT Protocol',
    description: 'A starter chest CT reporting protocol.',
    categories: ['radiology', 'chest'],
    authorDisplayName: 'Roman Shulgha',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    publishedAt: '2026-01-01T00:00:00.000Z',
    protocolId: 'chest-ct-1',
    startNodeId: 'n-start-chest',
    snippetFiles: [{ relPath: 'lung-nodule.md', content: '# Lung nodule assessment\n\nDescribe location, size, and characteristics.\n' }],
    snippetNodes: [{ nodeId: 'n-snip-chest', snippetPath: 'lung-nodule.md' }],
  },
  {
    packageId: 'КТ-грудная-клетка', // Cyrillic — exercises FR3 percent-encoded path
    releaseVersion: '1.0.0',
    title: 'КТ грудной клетки',
    description: 'Протокол КТ грудной клетки (Cyrillic packageId round-trip).',
    categories: ['radiology', 'chest'],
    authorDisplayName: 'Roman Shulgha',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    publishedAt: '2026-01-01T00:00:00.000Z',
    protocolId: 'kt-chest-1',
    startNodeId: 'n-start-kt',
    snippetFiles: [{ relPath: 'заключение.md', content: '# Заключение\n\nОпишите findings.\n' }],
    snippetNodes: [{ nodeId: 'n-snip-kt', snippetPath: 'заключение.md' }],
  },
  {
    packageId: 'chest ct', // space — exercises FR3 percent-encoding (%20)
    releaseVersion: '1.0.0',
    title: 'Chest CT (space id)',
    description: 'A package whose id contains a space (exercises %20 encoding).',
    categories: ['radiology'],
    authorDisplayName: 'Roman Shulgha',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    publishedAt: '2026-01-01T00:00:00.000Z',
    protocolId: 'chest-ct-space-1',
    startNodeId: 'n-start-space',
    snippetFiles: [{ relPath: 'findings.md', content: '# Findings\n\nDescribe findings here.\n' }],
    snippetNodes: [{ nodeId: 'n-snip-space', snippetPath: 'findings.md' }],
  },
];

export interface SeedRelease {
  manifest: PackageManifest;
  snippetContents: Array<{ relPath: string; content: string }>;
  catalogEntry: CatalogEntry;
}

/** Build the seed releases with real SHA-256 hashes computed from the exact bytes.
 *  Deterministic: given the same SEED, produces byte-identical output (pinned timestamps,
 *  explicit startNodeId — no Math.random). */
export async function buildSeedReleases(): Promise<SeedRelease[]> {
  const releases: SeedRelease[] = [];
  for (const pkg of SEED) {
    const protocolDoc = createEmptyProtocolDocument(pkg.protocolId, pkg.title, new Date(pkg.createdAt), pkg.startNodeId);
    const nodes: ProtocolNodeRecord[] = [...protocolDoc.nodes];
    const edges: ProtocolEdgeRecord[] = [];
    for (const sn of pkg.snippetNodes) {
      nodes.push({ id: sn.nodeId, kind: 'snippet', x: 0, y: 200, width: 100, height: 100, fields: { snippetPath: sn.snippetPath } });
      edges.push({ id: `e-${pkg.startNodeId}-${sn.nodeId}`, fromNodeId: pkg.startNodeId, toNodeId: sn.nodeId });
    }
    const doc: ProtocolDocumentV1 = { ...protocolDoc, nodes, edges };

    const protocolSha256 = await sha256String(JSON.stringify(doc, null, 2) + '\n');
    const snippetFiles: PackageSnippetFile[] = [];
    const snippetContents: Array<{ relPath: string; content: string }> = [];
    for (const f of pkg.snippetFiles) {
      const sha256 = await sha256String(f.content);
      snippetFiles.push({ relPath: f.relPath, sha256 });
      snippetContents.push({ relPath: f.relPath, content: f.content });
    }

    const manifest: PackageManifest = {
      schema: PACKAGE_MANIFEST_SCHEMA, version: PACKAGE_MANIFEST_VERSION,
      packageId: pkg.packageId, releaseVersion: pkg.releaseVersion,
      protocolDoc: doc, protocolSha256,
      snippetFiles, catalogEntryId: pkg.packageId,
      author: { displayName: pkg.authorDisplayName },
      publishedAt: pkg.publishedAt,
    };
    const catalogEntry: CatalogEntry = {
      packageId: pkg.packageId, title: pkg.title, description: pkg.description,
      author: { displayName: pkg.authorDisplayName },
      latestVersion: pkg.releaseVersion, categories: pkg.categories, updatedAt: pkg.updatedAt,
    };
    releases.push({ manifest, snippetContents, catalogEntry });
  }
  return releases;
}
