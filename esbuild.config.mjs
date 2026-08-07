// Generic one-shot TS→CJS bundler for the backend's Node scripts (generator).
// Usage: node esbuild.config.mjs <entry.ts> <outfile.cjs>
// (The parity gate in Slice 4 uses esbuild's JS API directly to bundle the plugin's
// guard files; this config is for the generator build only.)
import esbuild from 'esbuild';
import fs from 'fs';
import path from 'path';

const entry = process.argv[2];
const outfile = process.argv[3];
if (!entry || !outfile) {
  console.error('Usage: node esbuild.config.mjs <entry.ts> <outfile.cjs>');
  process.exit(1);
}

fs.mkdirSync(path.dirname(outfile), { recursive: true });
const result = await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'es2022',
  logLevel: 'info',
  outfile,
});
if (result.errors.length > 0) process.exit(1);
