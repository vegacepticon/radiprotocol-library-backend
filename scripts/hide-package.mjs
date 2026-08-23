#!/usr/bin/env node
// Moderation helper: hide/unhide a package in the catalog without deleting anything.
//
//   node scripts/hide-package.mjs <packageId> [--unhide]
//
// Sets (or removes) `hidden: true` in packages/<id>/catalog.json, preserving the rest of
// the file byte-for-byte apart from the flag. The generator excludes hidden packages from
// site/, so the next publish hides them from plugin users; removing the flag restores them.
// Run `npm run generate` locally to preview, or just merge — the publish job regenerates.

import fs from 'fs';
import path from 'path';

const [id, ...rest] = process.argv.slice(2);
const unhide = rest.includes('--unhide');

if (!id) {
  console.error('usage: node scripts/hide-package.mjs <packageId> [--unhide]');
  process.exit(2);
}

const catalogPath = path.join('packages', id, 'catalog.json');
if (!fs.existsSync(catalogPath)) {
  console.error(`error: ${catalogPath} not found`);
  process.exit(1);
}

let raw;
try {
  raw = fs.readFileSync(catalogPath, 'utf8');
} catch (e) {
  console.error(`error: cannot read ${catalogPath}: ${e.message}`);
  process.exit(1);
}

let catalog;
try {
  catalog = JSON.parse(raw);
} catch (e) {
  console.error(`error: ${catalogPath} is not valid JSON: ${e.message}`);
  process.exit(1);
}
if (typeof catalog !== 'object' || catalog === null || Array.isArray(catalog)) {
  console.error(`error: ${catalogPath} does not contain a JSON object`);
  process.exit(1);
}

const wasHidden = catalog['hidden'] === true;

if (unhide) {
  if (!wasHidden && !('hidden' in catalog)) {
    console.log(`${id}: already visible (no hidden flag present), nothing to do.`);
    process.exit(0);
  }
  delete catalog['hidden'];
  const out = JSON.stringify(catalog, null, 2) + '\n';
  if (out === raw) {
    console.log(`${id}: already visible, nothing to do.`);
    process.exit(0);
  }
  fs.writeFileSync(catalogPath, out);
  console.log(`${id}: unhidden — it will reappear in site/ after the next generate+publish.`);
} else {
  if (wasHidden) {
    console.log(`${id}: already hidden, nothing to do.`);
    process.exit(0);
  }
  catalog['hidden'] = true;
  const out = JSON.stringify({ ...catalog, hidden: true }, null, 2) + '\n';
  fs.writeFileSync(catalogPath, out);
  console.log(`${id}: hidden — it will disappear from site/ after the next generate+publish.`);
  console.log('Preview locally with: npm run generate');
}
