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
} else if (cmd === 'promote-fixture') {
  // Phase 6 golden-set promotion: a REAL session whose card the candidate
  // confirmed becomes a regression fixture. Ground truth = the judge's
  // verdicts where confirmed; disputed dimensions are recorded as
  // disputed (excluded from scoring until hand-resolved). The golden set
  // grows from genuine sessions only — never app-testing runs.
  const { readFileSync, writeFileSync, mkdirSync } = await import('node:fs');
  if (!target) {
    console.error('usage: cli.ts promote-fixture <session-id>');
    process.exit(64);
  }
  const sid = target;
  const events = readFileSync(path.join(repoRoot, 'traces', `${sid}.jsonl`), 'utf8')
    .split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  const assessment = JSON.parse(
    readFileSync(path.join(repoRoot, 'assessments', `${sid}.json`), 'utf8'),
  ) as { status: string; dimensions?: { dimension: string; verdict: string }[] };
  if (assessment.status !== 'assessed') {
    console.error('session was never assessed — nothing to promote');
    process.exit(2);
  }
  let confirms: Record<string, boolean> = {};
  try {
    confirms = JSON.parse(
      readFileSync(path.join(repoRoot, 'assessments', `${sid}.confirm.json`), 'utf8'),
    ) as Record<string, boolean>;
  } catch {
    console.error('no confirmations recorded — confirm dimensions on the card first');
    process.exit(2);
  }
  const expected: Record<string, string[]> = {};
  const disputed: string[] = [];
  for (const d of assessment.dimensions ?? []) {
    if (confirms[d.dimension] === true) expected[d.dimension] = [d.verdict];
    else if (confirms[d.dimension] === false) disputed.push(d.dimension);
  }
  const goldenDir = path.join(repoRoot, 'fixtures', 'judge', 'golden');
  mkdirSync(goldenDir, { recursive: true });
  writeFileSync(
    path.join(goldenDir, `${sid}.json`),
    JSON.stringify({ session_id: sid, promoted_at: new Date().toISOString(), events, expected, disputed }, null, 2),
  );
  console.log(
    `promoted: ${Object.keys(expected).length} confirmed dimension(s), ${disputed.length} disputed (excluded until hand-resolved)`,
  );
} else if (cmd === 'eval-judge') {
  const { runGauntlet, renderScorecard } = await import('./eval/gauntlet.js');
  const scorecard = await runGauntlet({
    repoRoot,
    quick: process.argv.includes('--quick'),
    simulate: process.argv.includes('--simulate'),
    resume: process.argv.includes('--resume'),
  });
  console.log(renderScorecard(scorecard));
  process.exit(scorecard.pass ? 0 : 1);
} else if (cmd === 'rejudge' || cmd === 'judge') {
  // Judging is a pure function of the stored trace, so a failed or stale
  // assessment is never a lost session — re-run it any time, including the
  // whole history after a prompt improvement (assessments are version-
  // stamped for exactly this).
  const { judgeSession } = await import('./judge.js');
  const { renderTimeline } = await import('./timeline.js');
  const { buildAssessmentCard } = await import('./feedback.js');
  const { buildGraphView, loadStore, recordAssessment, saveStore } = await import('./gap-graph.js');
  const { readFileSync, writeFileSync, mkdirSync, readdirSync } = await import('node:fs');
  if (!target) {
    console.error('usage: cli.ts rejudge <session-id> [--record]');
    process.exit(64);
  }
  const sessionId = target.replace(/\.jsonl$/, '').split('/').pop()!;
  const tracePath = path.join(repoRoot, 'traces', `${sessionId}.jsonl`);
  const events = readFileSync(tracePath, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as import('@interview-prep/shared').TraceEvent);

  // Find the problem this session ran (the .used marker names the session).
  let problemDir: string | null = null;
  for (const dir of readdirSync(problemsRoot)) {
    const marker = path.join(problemsRoot, dir, '.used');
    try {
      if (readFileSync(marker, 'utf8').split('\n')[0] === sessionId) {
        problemDir = path.join(problemsRoot, dir);
        break;
      }
    } catch {
      /* unused problem */
    }
  }
  if (!problemDir) {
    console.error(`no problem found for session ${sessionId} (no .used marker names it)`);
    process.exit(2);
  }
  const problem = JSON.parse(readFileSync(path.join(problemDir, 'problem.json'), 'utf8'));

  console.error(`[rejudge] ${sessionId} against ${path.basename(problemDir)}...`);
  console.error(renderTimeline(events).split('\n').slice(0, 3).join('\n') + '\n...');
  const result = await judgeSession({
    sessionId,
    events,
    problem,
    templatePath: path.join(repoRoot, 'prompts', 'judge-session.md'),
  });
  mkdirSync(path.join(repoRoot, 'assessments'), { recursive: true });
  writeFileSync(
    path.join(repoRoot, 'assessments', `${sessionId}.json`),
    JSON.stringify(result, null, 2),
  );

  // --record writes into the gap graph; plain rejudge is a dry look.
  let store = loadStore(path.join(repoRoot, 'gaps'), userId);
  if (process.argv.includes('--record') && result.status === 'assessed') {
    store = recordAssessment(store, result, problem.round_type);
    saveStore(path.join(repoRoot, 'gaps'), store);
    console.error('[rejudge] recorded into the gap graph');
  }
  const card = buildAssessmentCard(
    result,
    buildGraphView(store, sessionId),
    events,
    problem.planted_bug?.description,
  );
  console.log(JSON.stringify(card, null, 2));
  process.exit(result.status === 'assessed' ? 0 : 3);
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
  // Marked only once the session is actually up. Marking first burned a
  // pooled problem every time a start failed (port already held by a live
  // session), and the pool is ~5 minutes of generation per entry.
  await runSession({
    onReady: () => markUsed(problemDir, sessionId),
    repoRoot,
    problemDir,
    sessionId,
    userId,
    port: 3200,
    idePort: 3100,
    autorunTests: process.env.IP_AUTORUN_TESTS !== '0',
    prepareNext: process.env.IP_PREPARE_NEXT !== '0',
    interviewer: process.env.IP_INTERVIEWER === '0' ? null : undefined,
    intentCheck: process.env.IP_INTERVIEWER === '0' ? null : undefined,
    voice: process.env.IP_VOICE !== '0',
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
