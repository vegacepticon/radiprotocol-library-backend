// DUPLICATED from the plugin's src/protocol/protocol-document.ts (D2 — hand-written
// byte-for-byte; D5 — cross-repo parity gate compares these). Same sentinels, same
// interface field names/optionality, same createEmptyProtocolDocument key order (the
// hashed bytes for protocolSha256), same shallow isProtocolDocumentV1 guard. Zero Obsidian
// imports. The only adaptation: RPNodeKind is re-declared inline (the backend has no
// graph layer); the guard does not check `kind`, so this is type-only and wire-irrelevant.

/** Canonical schema identifier for RadiProtocol JSON files. */
export const PROTOCOL_SCHEMA = 'radiprotocol.protocol' as const;

/** Current on-disk schema version. Bump on breaking changes. */
export const PROTOCOL_VERSION = 1 as const;

/** Node kinds (duplicated from the plugin's src/graph/graph-model.ts:7-14). */
export type RPNodeKind =
  | 'start'
  | 'question'
  | 'answer'
  | 'text-block'
  | 'loop-start'      // @deprecated — legacy parseable for migration-error
  | 'loop-end'        // @deprecated — legacy parseable for migration-error
  | 'snippet';

export interface ProtocolDocumentV1 {
  schema: typeof PROTOCOL_SCHEMA;
  version: typeof PROTOCOL_VERSION;
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  nodes: ProtocolNodeRecord[];
  edges: ProtocolEdgeRecord[];
  selfCheckEnabled?: boolean;
  selfCheckItems?: string[];
  viewport?: { x: number; y: number; zoom: number };
  layoutDirection?: 'LR' | 'TB';
}

export interface ProtocolNodeRecord {
  id: string;
  kind: RPNodeKind | null;
  x: number;
  y: number;
  width: number;
  height: number;
  color?: string;
  text?: string;
  fields: Record<string, unknown>;
}

export interface ProtocolEdgeRecord {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  label?: string;
  isLoopExit?: boolean;
}

export function createEmptyProtocolDocument(
  id: string,
  title: string,
  now = new Date(),
  startNodeId = `node-${now.getTime()}-${Math.random().toString(36).slice(2, 8)}`,
): ProtocolDocumentV1 {
  const iso = now.toISOString();
  return {
    schema: PROTOCOL_SCHEMA,
    version: PROTOCOL_VERSION,
    id,
    title,
    createdAt: iso,
    updatedAt: iso,
    nodes: [
      {
        id: startNodeId,
        kind: 'start',
        x: 0,
        y: 0,
        width: 200,
        height: 80,
        color: 'rgba(76, 175, 80, 0.28)',
        fields: {},
      },
    ],
    edges: [],
    layoutDirection: 'LR',
  };
}

export function isProtocolDocumentV1(value: unknown): value is ProtocolDocumentV1 {
  if (typeof value !== 'object' || value === null) return false;
  const doc = value as Record<string, unknown>;
  return (
    doc['schema'] === PROTOCOL_SCHEMA &&
    doc['version'] === PROTOCOL_VERSION &&
    typeof doc['id'] === 'string' &&
    typeof doc['title'] === 'string' &&
    typeof doc['createdAt'] === 'string' &&
    typeof doc['updatedAt'] === 'string' &&
    Array.isArray(doc['nodes']) &&
    Array.isArray(doc['edges'])
  );
}
