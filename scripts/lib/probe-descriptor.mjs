// Probe harness (D5 — probe-based parity gate). Derives a canonical shape descriptor from a
// guard function's BEHAVIOR by probing it with a valid seed + targeted mutations. No
// hand-written descriptors: the harness derives the descriptor identically for the plugin's
// compiled guards (at the pinned rev) and the backend's own guards, so the diff catches
// real wire-type drift. The seed self-verifies (guard(seed) === true) so a stale seed fails
// loudly. Descriptor scope = the GUARD's behavior, not the interface (declared-but-unenforced
// fields derive as { required: false, kind: 'unknown' } — the guard ignores them — and match
// on both sides).
//
// Implemented kind taxonomy: object{open, fields[]} | array | array-of{element} | string |
// number | boolean | literal{value} | null | unknown. Records = open objects with no
// constrained fields; nested objects are inlined (no $ref kind); multi-value unions are not
// separately distinguished (no current guard enforces a union). Each field: { name, required, kind }.

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function getPath(obj, path) { let cur = obj; for (const p of path) cur = cur[p]; return cur; }
function setPath(obj, path, value) {
  let cur = obj;
  for (let i = 0; i < path.length - 1; i++) cur = cur[path[i]];
  cur[path[path.length - 1]] = value;
}

function probe(guard, seed, path, value) {
  const v = clone(seed);
  setPath(v, path, value);
  try { return guard(v) === true; } catch { return false; }
}

const EXTRA_KEY = '__probe_extra_key_xyz__';

function deriveObject(guard, seed, path) {
  const obj = getPath(seed, path);
  const fields = [];
  for (const field of Object.keys(obj)) {
    const fieldPath = [...path, field];
    const required = !probe(guard, seed, fieldPath, undefined);
    const kind = deriveKind(guard, seed, fieldPath);
    fields.push({ name: field, required, kind });
  }
  const open = probe(guard, seed, [...path, EXTRA_KEY], 'x');
  return { kind: 'object', open, fields };
}

function deriveKind(guard, seed, path) {
  const value = getPath(seed, path);
  if (value === null) {
    if (probe(guard, seed, path, 'not-null')) return { kind: 'unknown' }; // guard ignores the field
    return { kind: 'null' };
  }
  if (Array.isArray(value)) {
    if (probe(guard, seed, path, 'not-an-array')) return { kind: 'unknown' }; // guard ignores the field
    if (probe(guard, seed, path, [null])) return { kind: 'array' }; // bare array (only Array.isArray)
    const elem = value[0];
    if (elem !== null && typeof elem === 'object') {
      return { kind: 'array-of', element: deriveObject(guard, seed, [...path, 0]) };
    }
    return { kind: 'array-of', element: derivePrimitive(guard, seed, [...path, 0], elem) };
  }
  if (typeof value === 'object') {
    if (probe(guard, seed, path, 'not-an-object')) return { kind: 'unknown' }; // guard ignores the field
    return deriveObject(guard, seed, path);
  }
  return derivePrimitive(guard, seed, path, value);
}

function derivePrimitive(guard, seed, path, original) {
  if (typeof original === 'string') {
    if (!probe(guard, seed, path, '__probe_other_string__')) return { kind: 'literal', value: original };
    if (probe(guard, seed, path, 42)) return { kind: 'unknown' }; // guard ignores the field
    return { kind: 'string' };
  }
  if (typeof original === 'number') {
    if (!probe(guard, seed, path, original + 1)) return { kind: 'literal', value: original };
    if (probe(guard, seed, path, 'not-a-number')) return { kind: 'unknown' };
    return { kind: 'number' };
  }
  if (typeof original === 'boolean') {
    if (!probe(guard, seed, path, !original)) return { kind: 'literal', value: original };
    if (probe(guard, seed, path, 'not-a-boolean')) return { kind: 'unknown' }; // guard ignores the field
    return { kind: 'boolean' };
  }
  return { kind: 'unknown' };
}

/** Derive the shape descriptor for the object the guard accepts, from a valid seed.
 *  @param {(value: unknown) => boolean} guard
 *  @param {object} seed a value the guard accepts
 *  @param {string} name for error messages
 *  @returns {{ kind: 'object', open: boolean, fields: Array<{name:string, required:boolean, kind:unknown}> }} */
export function deriveDescriptor(guard, seed, name) {
  if (typeof guard !== 'function') throw new Error(`[${name}] guard is not a function`);
  if (typeof seed !== 'object' || seed === null) throw new Error(`[${name}] seed is not an object`);
  let accepted;
  try { accepted = guard(seed) === true; } catch (e) { throw new Error(`[${name}] guard threw on seed: ${e.message}`); }
  if (!accepted) throw new Error(`[${name}] seed is not accepted by the guard (stale seed)`);
  return deriveObject(guard, seed, []);
}
