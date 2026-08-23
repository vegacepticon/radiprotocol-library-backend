// Pure mermaid flowchart preview builder for submitted protocols (moderation aid).
// Given a validated release bundle, produces a deterministic GitHub-renderable
// ```mermaid``` block showing the protocol's graph structure (node kinds + edge labels),
// so a moderator can see the shape of a submission without installing it.
//
// Zero I/O, zero Obsidian imports. Node text is truncated to keep the diagram readable;
// mermaid special characters are neutralized via HTML entities inside quoted labels.

import type { PackageManifest } from '../wire-types/library-model';

/** Max characters of a node label shown in the preview diagram. */
const MAX_LABEL_CHARS = 40;

/** Escape mermaid-unfriendly characters for use inside a double-quoted node label. */
function escapeLabel(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .trim();
}

function truncate(text: string): string {
  const single = text.replace(/\s+/g, ' ').trim();
  if (single.length <= MAX_LABEL_CHARS) return single;
  return `${single.slice(0, MAX_LABEL_CHARS - 1)}…`;
}

/** Human label for one node record (mirrors the plugin's node-label semantics, simplified). */
function nodeDisplayText(fields: Record<string, unknown>, fallback: string): string {
  const candidates = ['questionText', 'answerText', 'displayLabel', 'answer_text', 'content', 'loopLabel', 'snippetLabel'];
  for (const key of candidates) {
    const v = fields[key];
    if (typeof v === 'string' && v.trim() !== '') return v;
  }
  return fallback;
}

interface PreviewNode {
  id: string;
  kind: string | null;
  text: string;
}

/** Build the mermaid flowchart body (no code fences) from a manifest's protocolDoc. */
export function buildMermaidFlowchart(manifest: PackageManifest): string {
  const doc = manifest.protocolDoc;
  const nodes: PreviewNode[] = (doc.nodes ?? []).map((n) => ({
    id: n.id,
    kind: n.kind,
    text: truncate(nodeDisplayText(
      n.fields ?? {},
      // Unlabeled structural nodes fall back to their kind.
      typeof n.kind === 'string' ? n.kind : n.id,
    )),
  }));

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const lines: string[] = ['flowchart LR'];

  for (const n of nodes) {
    const label = escapeLabel(n.text);
    switch (n.kind) {
      case 'start':
        lines.push(`  ${n.id}(["🚦 ${label}"])`);
        break;
      case 'question':
        lines.push(`  ${n.id}{"${label}"}`);
        break;
      case 'answer':
        lines.push(`  ${n.id}(["${label}"])`);
        break;
      case 'snippet':
        lines.push(`  ${n.id}[["📄 ${label}"]]`);
        break;
      case 'text-block':
        lines.push(`  ${n.id}["${label}"]`);
        break;
      default:
        // Unknown/legacy kinds render as plain boxes — never crash on future shapes.
        lines.push(`  ${n.id}["${label}"]`);
    }
  }

  for (const e of doc.edges ?? []) {
    if (!byId.has(e.fromNodeId) || !byId.has(e.toNodeId)) continue;
    const rawLabel = typeof e.label === 'string' ? e.label.trim() : '';
    if (e.isLoopExit === true || rawLabel === '') {
      lines.push(`  ${e.fromNodeId} --> ${e.toNodeId}`);
    } else {
      lines.push(`  ${e.fromNodeId} -- "${escapeLabel(truncate(rawLabel))}" --> ${e.toNodeId}`);
    }
  }

  return lines.join('\n');
}

/**
 * Full PR-comment markdown section for a release bundle: header with package identity +
 * structure stats, then the mermaid block. Deterministic output.
 */
export function buildSubmissionPreviewComment(bundle: {
  manifest: PackageManifest;
}): string {
  const { manifest } = bundle;
  const doc = manifest.protocolDoc;
  const questionCount = (doc.nodes ?? []).filter((n) => n.kind === 'question').length;
  const answerCount = (doc.nodes ?? []).filter((n) => n.kind === 'answer').length;
  const snippetCount = manifest.snippetFiles.length;

  const lines = [
    '## Protocol structure preview',
    '',
    `**${manifest.packageId}** @ ${manifest.releaseVersion} — ${doc.title}`,
    '',
    `- Nodes: ${(doc.nodes ?? []).length} (${questionCount} questions, ${answerCount} answers)`,
    `- Edges: ${(doc.edges ?? []).length}`,
    `- Snippet files: ${snippetCount}`,
    '',
    '<!-- Generated automatically to help moderation review. The full protocol is in packages/ — download the CI `release-preview` artifact and import it into Obsidian to run it before merging. -->',
    '',
    '```mermaid',
    buildMermaidFlowchart(manifest),
    '```',
  ];
  return lines.join('\n');
}
