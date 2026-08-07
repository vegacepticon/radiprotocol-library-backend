#!/usr/bin/env node
// Regenerate-and-diff gate (D4 — commit-and-gate). Bundles the generator into a SEPARATE temp
// dir + runs it into another temp dir (so the bundle isn't treated as a generated artifact),
// walks the generated tree, and raw-BYTE diffs every generated file against the committed
// site/. The hand-written static config (_redirects / 404.html / _headers from Slice 3) is
// EXCLUDED. Fails on any difference. Reuses the errors/fail()/exit skeleton from check-consistency.mjs.

import { readFileSync, existsSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import esbuild from 'esbuild';

const errors = [];
function fail(message) { errors.push(`❌ ${message}`); }
function info(message) { console.log(`  ${message}`); }
const require = createRequire(import.meta.url);

const SITE_DIR = 'site';
const STATIC_CONFIG = new Set(['_redirects', '_headers', '404.html']);

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

let bundleDir = '';
let genDir = '';
try {
  bundleDir = mkdtempSync(path.join(tmpdir(), 'regen-bundle-'));
  genDir = mkdtempSync(path.join(tmpdir(), 'regen-gen-'));
  const bundleOut = path.join(bundleDir, 'generate.cjs');
  await esbuild.build({ entryPoints: ['src/generator/generate.ts'], bundle: true, format: 'cjs', platform: 'node', target: 'es2022', outfile: bundleOut, logLevel: 'silent', write: true });
  const generateMod = require(bundleOut); // CLI guard fires only for generate.cjs-named argv[1]; call generate() directly.
  await generateMod.generate(genDir);

  const genSet = new Map(walk(genDir).map((f) => [path.relative(genDir, f), f]));
  const committedSet = new Map((existsSync(SITE_DIR) ? walk(SITE_DIR) : []).map((f) => [path.relative(SITE_DIR, f), f]));

  for (const [rel] of genSet) if (!committedSet.has(rel)) fail(`generated file not committed: ${rel}`);
  for (const [rel] of committedSet) {
    if (STATIC_CONFIG.has(rel)) continue; // hand-written site config (Slice 3), not generated
    if (!genSet.has(rel)) fail(`committed file not regenerated (stale?): ${rel}`);
  }
  for (const [rel, genAbs] of genSet) {
    const comAbs = committedSet.get(rel);
    if (comAbs && !readFileSync(genAbs).equals(readFileSync(comAbs))) fail(`file differs from regenerated: ${rel}`);
  }
  if (errors.length === 0) info(`OK: site/ matches regenerated output (${genSet.size} generated files)`);
} catch (e) {
  fail(`regen-diff error: ${e.message}`);
} finally {
  if (bundleDir) rmSync(bundleDir, { recursive: true, force: true });
  if (genDir) rmSync(genDir, { recursive: true, force: true });
}

console.log('\n═══════════════════════════════════════════════');
if (errors.length > 0) {
  console.log(`❌ FAILED: ${errors.length} error(s)`);
  errors.forEach((e) => console.log(`  ${e}`));
  process.exit(1);
}
console.log('✅ site/ is byte-identical to the regenerated output');
