/** Minimal CLI: `tsx server/src/cli.ts generate <targetDir>` then validate. */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateProblem } from './generate.js';
import { validateProblem } from './validate.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

const [cmd, target] = process.argv.slice(2);

if (cmd === 'generate') {
  const targetDir = path.resolve(target ?? path.join(repoRoot, 'problems', `debugging-${Date.now()}`));
  const result = await generateProblem({
    targetDir,
    theme:
      'an inventory reservation module for a small e-commerce backend: stock levels, time-limited holds placed by checkouts, hold expiry, and conversion of holds into shipments',
    templatePath: path.join(repoRoot, 'prompts', 'generate-debugging-problem.md'),
    model: 'opus',
  });
  console.log(
    JSON.stringify(
      { ok: result.ok, exitCode: result.exitCode, durationMs: result.durationMs },
      null,
      2,
    ),
  );
  if (!result.ok) {
    console.error('--- stderr ---\n' + result.stderr.slice(0, 2000));
    process.exit(1);
  }
  const report = validateProblem(targetDir);
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 2);
} else if (cmd === 'validate') {
  const report = validateProblem(path.resolve(target ?? '.'));
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 2);
} else {
  console.error('usage: cli.ts generate [targetDir] | validate <repoDir>');
  process.exit(64);
}
