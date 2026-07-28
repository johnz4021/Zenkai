/**
 * CLI.
 *
 *   generate [dir]   one-off problem generation (neutral, untargeted)
 *   prepare          generate the NEXT problem, targeted at the user's gap graph
 *   validate <dir>   mechanical check on a generated problem
 *   session [dir]    run a live session; picks from the pool when dir is omitted
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateProblem } from './generate.js';
import { validateProblem } from './validate.js';
import { buildGraphView, buildTargetNote, loadStore } from './gap-graph.js';
import { listReady, markUsed, pickProblem } from './pool.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const problemsRoot = path.join(repoRoot, 'problems');
const templatePath = path.join(repoRoot, 'prompts', 'generate-debugging-problem.md');
const THEME =
  'an inventory reservation module for a small e-commerce backend: stock levels, time-limited holds placed by checkouts, hold expiry, and conversion of holds into shipments';

const [cmd, target] = process.argv.slice(2);
const userId = process.env.IP_USER_ID ?? 'u1';

async function generateInto(targetDir: string, targetNote?: string): Promise<number> {
  const result = await generateProblem({
    targetDir,
    theme: THEME,
    targetNote,
    templatePath,
    model: 'opus',
  });
  console.log(
    JSON.stringify(
      { ok: result.ok, exitCode: result.exitCode, durationMs: result.durationMs, targeted: Boolean(targetNote) },
      null,
      2,
    ),
  );
  if (!result.ok) {
    console.error('--- stderr ---\n' + result.stderr.slice(0, 2000));
    return 1;
  }
  const report = validateProblem(targetDir);
  console.log(JSON.stringify({ ok: report.ok, failures: report.failures }, null, 2));
  return report.ok ? 0 : 2;
}

if (cmd === 'generate') {
  const dir = path.resolve(target ?? path.join(problemsRoot, `debugging-${Date.now()}`));
  process.exit(await generateInto(dir));
} else if (cmd === 'prepare') {
  // Targeting note comes either from the env (set by the session that just
  // ended) or is derived here from the stored gap graph.
  let note = process.env.IP_TARGET_NOTE || undefined;
  if (note === undefined) {
    const store = loadStore(path.join(repoRoot, 'gaps'), userId);
    note = buildTargetNote(buildGraphView(store));
  }
  const dir = path.join(problemsRoot, `debugging-${Date.now()}`);
  console.log(`[prepare] ${dir}${note ? ' (targeted at current focus gap)' : ' (neutral — nothing learned yet)'}`);
  process.exit(await generateInto(dir, note));
} else if (cmd === 'validate') {
  const report = validateProblem(path.resolve(target ?? '.'));
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 2);
} else if (cmd === 'pool') {
  const ready = listReady(problemsRoot);
  console.log(
    JSON.stringify(
      { ready: ready.length, problems: ready.map((p) => ({ dir: path.basename(p.dir), round: p.problem.round_type })) },
      null,
      2,
    ),
  );
} else if (cmd === 'session') {
  const { runSession } = await import('./session.js');
  const sessionId = process.env.IP_SESSION_ID ?? `sess-${Date.now()}`;

  let problemDir: string;
  if (target) {
    problemDir = path.resolve(target);
  } else {
    const picked = pickProblem(problemsRoot);
    if (!picked) {
      console.error(
        'No unused problem in the pool. Run:  npx tsx server/src/cli.ts prepare\n' +
          '(takes ~5 min; it targets your current focus gap)',
      );
      process.exit(3);
    }
    problemDir = picked.dir;
    console.log(`[session] problem: ${path.basename(problemDir)} (from pool)`);
  }
  markUsed(problemDir, sessionId);

  await runSession({
    repoRoot,
    problemDir,
    sessionId,
    userId,
    port: 3200,
    idePort: 3100,
    autorunTests: process.env.IP_AUTORUN_TESTS !== '0',
    prepareNext: process.env.IP_PREPARE_NEXT !== '0',
    interviewer: process.env.IP_INTERVIEWER === '0' ? null : undefined,
  });
} else {
  console.error(
    'usage:\n' +
      '  cli.ts generate [dir]    one-off, untargeted\n' +
      '  cli.ts prepare           generate next problem targeted at your gap graph\n' +
      '  cli.ts validate <dir>\n' +
      '  cli.ts pool              list unused problems\n' +
      '  cli.ts session [dir]     run a session (picks from pool if dir omitted)',
  );
  process.exit(64);
}
