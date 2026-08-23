import { describe, it, expect } from 'vitest';
import {
  buildMermaidFlowchart, buildSubmissionPreviewComment,
} from '../src/moderation/preview';
import type { PackageManifest } from '../src/wire-types/library-model';

function node(id: string, kind: string | null, fields: Record<string, unknown> = {}) {
  return { id, kind, x: 0, y: 0, width: 200, height: 80, fields };
}

function edge(id: string, fromNodeId: string, toNodeId: string, extra: Record<string, unknown> = {}) {
  return { id, fromNodeId, toNodeId, ...extra };
}

function manifest(doc: Record<string, unknown>, snippetCount = 0): PackageManifest {
  return {
    schema: 'radiprotocol.package',
    version: 1,
    packageId: 'chest-ct',
    releaseVersion: '1.0.0',
    protocolDoc: doc as never,
    protocolSha256: 'a'.repeat(64),
    snippetFiles: Array.from({ length: snippetCount }, (_, i) => ({ relPath: `s${i}.md`, sha256: 'b'.repeat(64) })),
    catalogEntryId: 'chest-ct',
    publishedAt: '2026-01-01T00:00:00.000Z',
    author: { displayName: 'A' },
  };
}

const SIMPLE_DOC = {
  nodes: [
    node('n1', 'start'),
    node('q1', 'question', { questionText: 'Сегменты?' }),
    node('a1', 'answer', { answerText: 'Норма' }),
    node('t1', 'text-block', { content: 'Заключение: без патологии' }),
  ],
  edges: [edge('e1', 'n1', 'q1'), edge('e2', 'q1', 'a1', { label: 'да' })],
};

describe('buildMermaidFlowchart', () => {
  it('renders one line per node with kind-appropriate shapes', () => {
    const body = buildMermaidFlowchart(manifest(SIMPLE_DOC));
    const lines = body.split('\n');
    expect(lines[0]).toBe('flowchart LR');
    expect(lines).toContain('  n1(["🚦 start"])');
    expect(lines).toContain('  q1{"Сегменты?"}');
    expect(lines).toContain('  a1(["Норма"])');
    expect(lines).toContain('  t1["Заключение: без патологии"]');
  });

  it('renders labeled edges in quotes and unlabeled edges bare', () => {
    const body = buildMermaidFlowchart(manifest(SIMPLE_DOC));
    expect(body).toContain('  n1 --> q1');
    expect(body).toContain('  q1 -- "да" --> a1');
  });

  it('escapes mermaid-hostile characters in labels and edge captions', () => {
    const doc = {
      nodes: [node('q', 'question', { questionText: '<A> & "B">' })],
      edges: [],
    };
    const body = buildMermaidFlowchart(manifest(doc));
    expect(body).toContain('&lt;A&gt; &amp; &quot;B&quot;&gt;');
    expect(body).not.toContain('<A>');
  });

  it('truncates long labels at 40 chars with an ellipsis', () => {
    const long = 'х'.repeat(100);
    const doc = { nodes: [node('q', 'question', { questionText: long })], edges: [] };
    const body = buildMermaidFlowchart(manifest(doc));
    expect(body).toContain('"' + 'х'.repeat(39) + '…"');
  });

  it('drops dangling edges instead of crashing', () => {
    const doc = {
      nodes: [node('n1', 'start')],
      edges: [edge('e1', 'n1', 'ghost')],
    };
    const body = buildMermaidFlowchart(manifest(doc));
    expect(body).not.toContain('ghost'); // edge to a nonexistent node is skipped entirely
    expect(body).toContain('flowchart LR');
  });

  it('is deterministic — same input, same bytes', () => {
    const a = buildMermaidFlowchart(manifest(SIMPLE_DOC));
    const b = buildMermaidFlowchart(manifest(SIMPLE_DOC));
    expect(a).toBe(b);
  });
});

describe('buildSubmissionPreviewComment', () => {
  it('includes identity, stats, and the mermaid block', () => {
    const comment = buildSubmissionPreviewComment({ manifest: manifest(SIMPLE_DOC, 2) });
    expect(comment).toContain('**chest-ct** @ 1.0.0');
    expect(comment).toContain('Nodes: 4 (1 questions, 1 answers)');
    expect(comment).toContain('Edges: 2');
    expect(comment).toContain('Snippet files: 2');
    expect(comment).toContain('```mermaid');
    expect(comment).toContain('flowchart LR');
    expect(comment.trimEnd().endsWith('```')).toBe(true);
  });
});
