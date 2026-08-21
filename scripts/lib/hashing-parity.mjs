// Hashing-parity probe harness (D5/D9 — probe-based parity gate extension). The plugin and
// backend each carry a duplicated SHA-256 helper (plugin src/library/integrity.ts ↔ backend
// src/wire-types/integrity.ts). The wire contract depends on the two copies behaving
// identically — the backend seed hashes protocol docs + snippets with its copy
// (src/seed/seed.ts), and the plugin re-verifies those exact hashes at install time. A
// divergence (digest algorithm, hex encoding, case handling, throwing semantics) breaks
// EVERY registry install and, before this module, surfaced only as a failed install,
// never as a gate failure.
//
// This module is the pure, zero-dep probe surface: it runs deterministic inputs through
// either bundled copy's sha256String/verifyIntegrity and compares outputs pairwise AND
// against absolute anchors. The pairwise diff catches one-sided drift; the hard-coded
// SHA-256("abc") known-answer vector (SHA256_ABC_KAT) and the ^[0-9a-f]{64}$ shape check
// (HEX_64_RE) are the ONLY defense against lockstep drift — both copies switching to
// SHA-512 or base64 in one commit. Do NOT "simplify" the anchors away: without them a
// lockstep change passes the gate silently while every install breaks.
//
// Surface contract: both sides must export sha256String and verifyIntegrity as functions;
// extra exports are tolerated (the plugin's sha256Bytes is deliberately excluded —
// plugin-only, nothing wire-served or install-verified uses it). verifyIntegrity is
// probed for its never-throws semantics (mismatch → false, the contract library-installer
// relies on); a throw is recorded as { threw: <message> } and treated as a divergence,
// never propagated.

/** SHA-256("abc") known-answer vector — the absolute digest anchor. Both repos' test
 *  suites already pin this same value (plugin src/__tests__/library/integrity.test.ts,
 *  backend __tests__/wire-types.test.ts). */
export const SHA256_ABC_KAT = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

/** Lowercase hex-64 digest shape — the absolute encoding anchor. */
export const HEX_64_RE = /^[0-9a-f]{64}$/;

/** The probe-result key whose digest hashingParityError anchors against SHA256_ABC_KAT
 *  (the fixed case whose content is the 'abc' KAT input). */
const ABC_CASE_NAME = 'SHA-256 KAT "abc"';

/** Static sha256String probe cases. The Cyrillic case exercises UTF-8 byte encoding
 *  (each Cyrillic code point encodes to 2 UTF-8 bytes), not just ASCII. */
export const HASHING_CASES = [
  { name: 'empty string', content: '' },
  { name: ABC_CASE_NAME, content: 'abc' },
  { name: 'multi-byte UTF-8 (Cyrillic)', content: 'Протокол КТ грудной клетки' },
];

/** The exact byte stream the backend seed hashes for the wire protocol-doc hash:
 *  JSON.stringify(doc, null, 2) + '\n' (src/seed/seed.ts). The dialect string itself
 *  lives in callers (seed.ts backend, library-installer.ts plugin), not in integrity.ts —
 *  a seed-side pretty-print change would pass this gate yet break install-time
 *  verification; anchored here by mirroring, not by enforcing. */
export function canonicalProtocolJson(doc) {
  return JSON.stringify(doc, null, 2) + '\n';
}

/** Run one async call, recording a throw as { threw: message } instead of propagating,
 *  so a throwing sha256String/verifyIntegrity is a recorded divergence, not a crash. */
async function capture(fn, fnName, args) {
  if (typeof fn !== 'function') return { threw: `${fnName} is not a function` };
  try {
    return await fn(...args);
  } catch (e) {
    return { threw: e instanceof Error ? e.message : String(e) };
  }
}

/** Run every fixed sha256String case plus extraCases through one module's sha256String,
 *  and probe the module's verifyIntegrity semantics (match → true, uppercase expected →
 *  true — case-insensitive per integrity.ts, mismatch → false without throwing).
 *  @param {object} mod module whose sha256String/verifyIntegrity to probe (both required
 *    as functions; extras tolerated)
 *  @param {Array<{name: string, content: string}>} [extraCases] additional sha256String cases
 *  @returns {{ sha256String: Record<string, string | {threw: string}>,
 *              verifyIntegrity: Record<string, boolean | {threw: string}> }} */
export async function probeIntegrity(mod, extraCases = []) {
  const sha256String = typeof mod?.sha256String === 'function' ? mod.sha256String : null;
  const verifyIntegrity = typeof mod?.verifyIntegrity === 'function' ? mod.verifyIntegrity : null;

  const sha256StringResults = {};
  for (const { name, content } of [...HASHING_CASES, ...extraCases]) {
    sha256StringResults[name] = await capture(sha256String, 'sha256String', [content]);
  }

  const verifyIntegrityResults = {
    'match:abc': await capture(verifyIntegrity, 'verifyIntegrity', ['abc', SHA256_ABC_KAT]),
    'match:abc (uppercase)': await capture(verifyIntegrity, 'verifyIntegrity', ['abc', SHA256_ABC_KAT.toUpperCase()]),
    'mismatch:abc': await capture(verifyIntegrity, 'verifyIntegrity', ['abc', '0'.repeat(64)]),
  };

  return { sha256String: sha256StringResults, verifyIntegrity: verifyIntegrityResults };
}

/** Compare two probe results (primitive values, or {threw: <message>} records). */
function sameValue(a, b) {
  if (typeof a === 'object' && a !== null && typeof b === 'object' && b !== null) {
    return a.threw !== undefined && b.threw !== undefined && a.threw === b.threw;
  }
  return a === b;
}

/** Render a probe value for error messages: {threw} → 'threw: <message>', else String(v). */
function fmt(v) {
  if (typeof v === 'object' && v !== null && v.threw !== undefined) return `threw: ${v.threw}`;
  return String(v);
}

/** Compare two probes pairwise, anchored against the absolute KAT/hex-64 digests.
 *  Returns null when every sha256String case matches pairwise AND every digest is
 *  lowercase hex-64 AND the 'abc' case equals SHA256_ABC_KAT AND every verifyIntegrity
 *  result is a boolean (never a throw) with matching values; else one aggregated
 *  multi-line message naming every failing case with plugin value, backend value, and
 *  the violated anchor.
 *  @param {ReturnType<typeof probeIntegrity>} pluginProbe
 *  @param {ReturnType<typeof probeIntegrity>} backendProbe
 *  @returns {string | null} */
export function hashingParityError(pluginProbe, backendProbe) {
  const problems = [];
  const pluginSha = (pluginProbe && pluginProbe.sha256String) || {};
  const backendSha = (backendProbe && backendProbe.sha256String) || {};
  const pluginVerify = (pluginProbe && pluginProbe.verifyIntegrity) || {};
  const backendVerify = (backendProbe && backendProbe.verifyIntegrity) || {};

  const shaNames = new Set([...Object.keys(pluginSha), ...Object.keys(backendSha)]);
  for (const name of shaNames) {
    const label = `sha256String['${name}']`;
    const p = pluginSha[name];
    const b = backendSha[name];
    if (!sameValue(p, b)) {
      problems.push(`${label}: plugin ${fmt(p)} vs backend ${fmt(b)}`);
    } else if (typeof p !== 'string' || !HEX_64_RE.test(p)) {
      problems.push(`${label}: both sides ${fmt(p)} — expected a lowercase hex-64 digest (${HEX_64_RE})`);
    }
    if (name === ABC_CASE_NAME) {
      if (typeof p !== 'string' || p !== SHA256_ABC_KAT) {
        problems.push(`${label}: plugin ${fmt(p)} vs anchor ${SHA256_ABC_KAT}`);
      }
      if (typeof b !== 'string' || b !== SHA256_ABC_KAT) {
        problems.push(`${label}: backend ${fmt(b)} vs anchor ${SHA256_ABC_KAT}`);
      }
    }
  }

  const verifyNames = new Set([...Object.keys(pluginVerify), ...Object.keys(backendVerify)]);
  for (const name of verifyNames) {
    const label = `verifyIntegrity['${name}']`;
    const p = pluginVerify[name];
    const b = backendVerify[name];
    if (typeof p !== 'boolean') {
      problems.push(`${label}: plugin ${fmt(p)} — verifyIntegrity must return a boolean, never throw`);
    } else if (typeof b !== 'boolean') {
      problems.push(`${label}: backend ${fmt(b)} — verifyIntegrity must return a boolean, never throw`);
    } else if (p !== b) {
      problems.push(`${label}: plugin ${p} vs backend ${b}`);
    }
  }

  if (problems.length === 0) return null;
  return ['integrity.ts hashing behavior diverged:', ...problems.map((line) => `  ${line}`)].join('\n');
}
