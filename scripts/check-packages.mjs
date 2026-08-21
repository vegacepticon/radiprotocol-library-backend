#!/usr/bin/env node
// check-packages gate (Variant B): validates the packages/ catalog source of truth using
// the exact same loader the generator uses. Run in CI on every PR — a submission PR that
// fails validation shows a red X before a moderator ever looks at it.
// Bundled with esbuild like check-regen-diff.mjs (the loader imports TS wire-types).

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import esbuild from 'esbuild';

const errors = [];
const require = createRequire(import.meta.url);
let bundleDir = '';
try {
  bundleDir = mkdtempSync(path.join(tmpdir(), 'check-packages-'));
  const bundleOut = path.join(bundleDir, 'check-packages.cjs');
  await esbuild.build({
    entryPoints: ['scripts/check-packages-entry.ts'],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'es2022',
    outfile: bundleOut,
    logLevel: 'silent',
    write: true,
  });
  const mod = require(bundleOut);
  const releases = await mod.loadPackagesCatalog('packages');
  const packageIds = [...new Set(releases.map((r) => r.manifest.packageId))];
  console.log(`✅ packages/ catalog valid: ${packageIds.length} package(s), ${releases.length} release(s)`);
  for (const id of packageIds) console.log(`  - ${id}`);
} catch (e) {
  if (e && e.name === 'CatalogValidationError') {
    console.error('❌ packages/ catalog invalid:');
    for (const err of e.errors) console.error(`  - ${err}`);
    process.exit(1);
  }
  console.error(`❌ check-packages error: ${e.message}`);
  process.exit(1);
} finally {
  if (bundleDir) rmSync(bundleDir, { recursive: true, force: true });
}
