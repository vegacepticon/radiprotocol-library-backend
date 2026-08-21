#!/usr/bin/env node
// Cross-repo wire-type parity gate (D5 — probe-based; D9 — backend CI, plugin pinned).
// Reads plugin-pin.txt, verifies the plugin checkout (PLUGIN_REPO_PATH, default ../RadiProtocol)
// is at that rev, esbuild-bundles the plugin's guard files + the backend's guard files + the
// backend's seed, derives a shape descriptor from each served guard's BEHAVIOR on BOTH sides,
// and diffs. Fails on any drift (missing guards or differing descriptors — sentinels,
// requiredness, array-element shapes, openness). Reuses the errors/fail()/exit skeleton from
// check-consistency.mjs. The plugin repo is untouched (read-only checkout).

import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import esbuild from 'esbuild';
import { deriveDescriptor } from './lib/probe-descriptor.mjs';
import { hashingParityError, probeIntegrity, canonicalProtocolJson } from './lib/hashing-parity.mjs';

const errors = [];
function fail(message) { errors.push(`❌ ${message}`); }
function info(message) { console.log(`  ${message}`); }

// Served wire-type guards the gate compares. Client-only guards (isCatalogSnapshot,
// isInstalledRecord) are intentionally excluded — not served on the wire.
const GUARD_NAMES = ['isCatalogResponse', 'isReleaseResponse', 'isPackageManifest', 'isCatalogEntry', 'isProtocolDocumentV1'];

const require = createRequire(import.meta.url);

const pluginPin = readFileSync('plugin-pin.txt', 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))[0];
if (!pluginPin) { console.error('plugin-pin.txt is empty'); process.exit(1); }

const pluginRepoPath = process.env.PLUGIN_REPO_PATH ?? '../RadiProtocol';
if (!existsSync(path.join(pluginRepoPath, 'package.json'))) {
  fail(`plugin repo not found at ${pluginRepoPath} (set PLUGIN_REPO_PATH)`);
}

try {
  const pluginHead = execFileSync('git', ['-C', pluginRepoPath, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const pinnedHead = execFileSync('git', ['-C', pluginRepoPath, 'rev-parse', pluginPin], { encoding: 'utf8' }).trim();
  if (pluginHead !== pinnedHead) fail(`plugin checkout is at ${pluginHead} but plugin-pin.txt is ${pluginPin} (→ ${pinnedHead}); check out the pinned rev`);
  else info(`OK: plugin checkout at pinned rev ${pluginPin} (${pluginHead})`);
} catch (e) {
  fail(`could not verify plugin rev: ${e.message}`);
}

const tmps = [];
async function bundleModule(entryPath) {
  const tmp = mkdtempSync(path.join(tmpdir(), 'parity-'));
  const outfile = path.join(tmp, 'bundle.cjs');
  await esbuild.build({ entryPoints: [entryPath], bundle: true, format: 'cjs', platform: 'node', target: 'es2022', outfile, logLevel: 'silent', write: true });
  tmps.push(tmp);
  return require(outfile);
}

async function loadGuards(guardFiles) {
  const guards = {};
  for (const f of guardFiles) {
    if (!existsSync(f)) { fail(`guard file not found: ${f}`); continue; }
    const mod = await bundleModule(f);
    for (const [k, v] of Object.entries(mod)) if (typeof v === 'function') guards[k] = v;
  }
  return guards;
}

try {
  console.log('\n▸ Bundling plugin + backend guards + seed…');
  const pluginGuards = await loadGuards([
    path.join(pluginRepoPath, 'src/library/registry-model.ts'),
    path.join(pluginRepoPath, 'src/library/library-model.ts'),
    path.join(pluginRepoPath, 'src/protocol/protocol-document.ts'),
  ]);
  const backendGuards = await loadGuards([
    'src/wire-types/registry-model.ts',
    'src/wire-types/library-model.ts',
    'src/wire-types/protocol-document.ts',
  ]);
  const seedMod = await bundleModule('src/seed/seed.ts');
  const releases = await seedMod.buildSeedReleases();
  const SEED_SERVER_TIME = seedMod.SEED_SERVER_TIME;
  const r0 = releases[0];
  // Probe seeds include optional declared fields (CatalogEntry.summary; ProtocolDocumentV1's
  // selfCheckEnabled/selfCheckItems/viewport) so the harness probes them — the guard ignores
  // them, so they derive as { required:false, kind:'unknown' } on both sides → match, AND a
  // future enforcement drift would change the descriptor → caught.
  const seeds = {
    isCatalogResponse: { entries: releases.map((r) => r.catalogEntry), serverTime: SEED_SERVER_TIME },
    isReleaseResponse: { manifest: r0.manifest, snippetContents: r0.snippetContents },
    isPackageManifest: r0.manifest,
    isCatalogEntry: { ...r0.catalogEntry, summary: 'A summary.' },
    isProtocolDocumentV1: {
      ...r0.manifest.protocolDoc,
      selfCheckEnabled: true,
      selfCheckItems: ['Confirm completion'],
      viewport: { x: 0, y: 0, zoom: 1 },
    },
  };

  console.log('\n▸ Deriving descriptors (plugin vs backend)…');
  function deriveAll(guards) {
    const out = {};
    for (const name of GUARD_NAMES) {
      const guard = guards[name];
      if (typeof guard !== 'function') { fail(`${name} not exported on this side`); continue; }
      try { out[name] = deriveDescriptor(guard, seeds[name], name); }
      catch (e) { fail(e.message); }
    }
    return out;
  }
  const pluginDescs = deriveAll(pluginGuards);
  const backendDescs = deriveAll(backendGuards);

  console.log('\n▸ Diffing descriptors…');
  for (const name of GUARD_NAMES) {
    if (!pluginDescs[name] || !backendDescs[name]) continue;
    const a = JSON.stringify(pluginDescs[name]);
    const b = JSON.stringify(backendDescs[name]);
    if (a !== b) fail(`guard "${name}" descriptors differ:\n    plugin:  ${a}\n    backend: ${b}`);
    else info(`OK: ${name} descriptors match`);
  }

  console.log('\n▸ Probing hashing behavior (integrity.ts parity)…');
  // D6 integrity parity: both copies must produce byte-identical SHA-256 hex digests and
  // identical verifyIntegrity semantics (match → true; uppercase expected → true; mismatch →
  // false, never throws). Bundled with the same loadGuards pattern as the descriptor guards,
  // so the shared tmp cleanup in finally covers these bundles too. Runs unconditionally —
  // even when the pin gate is red — since drift here is independent of the pinned rev: a
  // probe against the wrong rev cannot pass silently (the pin gate still fails overall, and
  // CI always checks out the pinned rev). The plugin's sha256Bytes export is deliberately
  // excluded from parity — nothing wire-served or install-verified uses it; the absolute
  // KAT/hex anchors in scripts/lib/hashing-parity.mjs guard against lockstep drift (both
  // copies switching hash algorithm in one commit).
  const pluginMod = await loadGuards([path.join(pluginRepoPath, 'src/library/integrity.ts')]);
  const backendMod = await loadGuards(['src/wire-types/integrity.ts']);
  const extraCases = [
    // The exact byte stream the wire hash covers (seed.ts hashes JSON.stringify(doc, null, 2) + '\n').
    { name: 'canonical protocolDoc (2-space pretty + \\n)', content: canonicalProtocolJson(r0.manifest.protocolDoc) },
    // The raw snippet content string, as seeded (SHA-256 over the UTF-8 bytes, not the JSON).
    { name: 'seed snippet content', content: r0.snippetContents[0].content },
  ];
  const pluginProbe = await probeIntegrity(pluginMod, extraCases);
  const backendProbe = await probeIntegrity(backendMod, extraCases);
  const hashingError = hashingParityError(pluginProbe, backendProbe);
  if (hashingError) fail(hashingError);
  else info('OK: integrity.ts hashing behavior matches (sha256String + verifyIntegrity)');
} catch (e) {
  fail(`parity gate error: ${e.message}`);
} finally {
  for (const t of tmps) rmSync(t, { recursive: true, force: true });
}

console.log('\n═══════════════════════════════════════════════');
if (errors.length > 0) {
  console.log(`❌ FAILED: ${errors.length} error(s)`);
  errors.forEach((e) => console.log(`  ${e}`));
  process.exit(1);
}
console.log('✅ wire-type parity holds (plugin ↔ backend)');
