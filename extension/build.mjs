// Bundles the emitter into a self-contained extension dir the session runner
// can mount via --extensions-dir (spike 2 finding: never mount into
// ~/.openvscode-server/extensions — root-owned parents break registration).
import { build } from 'esbuild';
import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { manifest } from './manifest.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, 'dist', 'trace-emitter-0.0.1');
mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [path.join(here, 'src', 'extension.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['vscode'],
  outfile: path.join(outDir, 'extension.js'),
});

// The manifest the extension host reads lives in manifest.mjs so its
// load-bearing pieces (untrustedWorkspaces, the editor/title Run button)
// are pinned by manifest.test.ts without running a build.
writeFileSync(path.join(outDir, 'package.json'), JSON.stringify(manifest, null, 2));

console.log('built', outDir);
