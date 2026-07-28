// Bundles the emitter into a self-contained extension dir the session runner
// can mount via --extensions-dir (spike 2 finding: never mount into
// ~/.openvscode-server/extensions — root-owned parents break registration).
import { build } from 'esbuild';
import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

// The manifest the extension host reads. capabilities.untrustedWorkspaces is
// LOAD-BEARING: without it, Workspace Trust silently disables the extension
// the moment a folder is open (spike 3 — zero events, zero logs).
writeFileSync(
  path.join(outDir, 'package.json'),
  JSON.stringify(
    {
      name: 'trace-emitter',
      publisher: 'interview-prep',
      version: '0.0.1',
      engines: { vscode: '^1.80.0' },
      main: './extension.js',
      activationEvents: ['onStartupFinished'],
      extensionKind: ['workspace'],
      capabilities: {
        untrustedWorkspaces: {
          supported: true,
          description: 'Observes editor events only; does not evaluate workspace code.',
        },
      },
      contributes: {
        commands: [
          { command: 'interviewPrep.runTests', title: 'Interview Prep: Run Tests' },
        ],
      },
    },
    null,
    2,
  ),
);

console.log('built', outDir);
