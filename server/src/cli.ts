/**
 * CLI.
 *
 *   generate [dir]   one-off problem generation (neutral, untargeted)
 *   prepare          generate the NEXT problem, targeted at the user's gap graph
 *   validate <dir>   mechanical check on a generated problem
 *   session [dir]    run a live session; picks from the pool when dir is omitted
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateProblem } from './generate.js';
import { validateProblem } from './validate.js';
import { buildGraphView, buildTargetNote, loadStore } from './gap-graph.js';
import { listReady, markUsed, pickProblem } from './pool.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

/**
 * Load repo-root `.env` before anything reads process.env.
 *
 * Every entry point comes through this file, and the app passes its own env
 * to the sessions and generators it spawns, so loading once here reaches the
 * whole tree. Native (Node 20.12+) — no dependency for a dozen lines of
 * parsing. A shell export still wins: loadEnvFile does not overwrite
 * variables that are already set.
 *
 * Why this exists: voice silently ran text-only because ELEVENLABS_API_KEY
 * lived in one terminal tab and the app server was started from another.
 */
const envFile = path.join(repoRoot, '.env');
if (existsSync(envFile)) {
  try {
    process.loadEnvFile(envFile);
  } catch (e) {
    console.warn(`[cli] .env present but unreadable: ${String(e).slice(0, 160)}`);
  }
}
const problemsRoot = path.join(repoRoot, 'problems');
const templatePath = path.join(repoRoot, 'prompts', 'generate-round.md');
const THEME =
  'A debugging round: the candidate is dropped into an unfamiliar codebase with one failing test and must find and fix the root cause. Domain: an inventory reservation module for a small e-commerce backend — stock levels, time-limited holds placed by checkouts, hold expiry, and conversion of holds into shipments.';

const [cmd, target] = process.argv.slice(2);
const userId = process.env.IP_USER_ID ?? 'u1';

async function generateInto(
  targetDir: string,
  targetNote?: string,
  brief: string = THEME,
  spec?: import('@interview-prep/shared').RoundSpec,
): Promise<number> {
  const result = await generateProblem({
    targetDir,
    brief,
    spec,
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
  // The generator owns its own marker's lifetime: the app's close handler
  // cannot be relied on (an app restart mid-generation orphans it, leaving
  // a stale .generating next to a finished problem forever).
  const { clearGeneratingMarker, removePythonArtifacts } = await import('./generation-state.js');
  if (!result.ok) {
    clearGeneratingMarker(targetDir);
    console.error('--- stderr ---\n' + result.stderr.slice(0, 2000));
    return 1;
  }
  // Sweep twice: the generator's own suite runs left bytecode, and the
  // validator's run below re-creates it — only the second sweep decides
  // what the candidate's file tree actually shows.
  removePythonArtifacts(targetDir);
  const report = validateProblem(targetDir);
  clearGeneratingMarker(targetDir);
  removePythonArtifacts(targetDir);
  console.log(JSON.stringify({ ok: report.ok, failures: report.failures }, null, 2));
  if (report.ok) {
    // Disk marker the queue derives "ready" from — the app can restart and
    // recover item status without trusting its own memory.
    const { writeFileSync: wf } = await import('node:fs');
    wf(path.join(targetDir, '.validated'), new Date().toISOString());
  }
  return report.ok ? 0 : 2;
}

/** Flag parsing for the target subcommands: --k v pairs after positionals. */
function parseFlags(argv: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      flags[a.slice(2)] = argv[i + 1] && !argv[i + 1]!.startsWith('--') ? argv[++i]! : 'true';
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

if (cmd === 'generate') {
  const dir = path.resolve(target ?? path.join(problemsRoot, `debugging-${Date.now()}`));
  process.exit(await generateInto(dir));
} else if (cmd === 'target') {
  // Season-program intake, CLI-first: the same functions the home app calls.
  const { listTargets, loadTarget, pickSpecInferrer, saveTarget, slugify, targetDir } =
    await import('./intake.js');
  const { readFileSync: rf } = await import('node:fs');
  const sub = target;
  const rest = process.argv.slice(4);
  if (sub === 'add') {
    const { positional, flags } = parseFlags(rest);
    const label = positional.join(' ');
    if (!label) {
      console.error('usage: cli.ts target add "<label>" [--date YYYY-MM-DD] [--desc "..."] [--context-file <path>]');
      process.exit(64);
    }
    const t = {
      id: `${slugify(label)}-${Date.now().toString(36)}`,
      label,
      ...(flags.date ? { interview_date: flags.date } : {}),
      description: flags.desc ?? '',
      ...(flags['context-file'] ? { context: rf(path.resolve(flags['context-file']), 'utf8') } : {}),
      specs: [],
      created: new Date().toISOString(),
    };
    saveTarget(repoRoot, t);
    console.log(JSON.stringify({ id: t.id, label: t.label, interview_date: t.interview_date ?? null }, null, 2));
  } else if (sub === 'list') {
    console.log(
      JSON.stringify(
        listTargets(repoRoot).map((t) => ({
          id: t.id,
          label: t.label,
          interview_date: t.interview_date ?? null,
          specs: t.specs.map((s) => s.id),
        })),
        null,
        2,
      ),
    );
  } else if (sub === 'infer') {
    const { positional, flags } = parseFlags(rest);
    const [id, ...descParts] = positional;
    const t = id ? loadTarget(repoRoot, id) : null;
    if (!t) {
      console.error('usage: cli.ts target infer <target-id> "<round description>" [--accept]');
      process.exit(64);
    }
    const description = descParts.join(' ') || t.description;
    if (!description) {
      console.error('no round description (pass one, or set --desc on the target)');
      process.exit(64);
    }
    const infer = pickSpecInferrer(path.join(repoRoot, 'prompts', 'infer-round-spec.md'));
    const draft = await infer(description, t.context ?? '');
    console.log(JSON.stringify(draft, null, 2));
    if (draft.unsupported) {
      console.error(`\nNOT SUPPORTED: ${draft.unsupported}\nNothing saved.`);
      process.exit(3);
    }
    if (flags.accept === 'true') {
      // The human IS the confirm gate — --accept is that confirmation.
      t.specs = [...t.specs.filter((s) => s.id !== draft.spec.id), draft.spec];
      saveTarget(repoRoot, t);
      console.error(`\naccepted → ${t.id} specs: [${t.specs.map((s) => s.id).join(', ')}]`);
      // Already a CLI context — draft the blueprint inline. Failure warns
      // and continues: accept succeeded, generation falls back to the
      // legacy brief until a blueprint lands.
      try {
        const bp = await import('./blueprint.js');
        if (!existsSync(bp.blueprintPath(repoRoot, t.id, draft.spec.id))) {
          const skeleton = readFileSync(
            path.join(repoRoot, 'prompts', 'blueprints', bp.pickSkeletonFile(draft.spec)),
            'utf8',
          );
          const md = await bp.pickBlueprintDrafter(path.join(repoRoot, 'prompts', 'draft-blueprint.md'))({
            spec: draft.spec, description: t.description ?? '', context: t.context ?? '', skeleton,
          });
          bp.writeBlueprintWithBackup(repoRoot, t.id, draft.spec.id, md);
          console.error(`blueprint drafted → blueprints/${draft.spec.id}.md`);
        }
      } catch (e) {
        console.warn(`blueprint draft failed (generation will use the legacy brief): ${String(e)}`);
      }
    } else {
      console.error('\ndraft only — rerun with --accept to save it to the target');
    }
  } else {
    console.error('usage: cli.ts target <add|list|infer> ...');
    process.exit(64);
  }
} else if (cmd === 'generate-for') {
  // Generate a problem for a target's confirmed spec, into the target's own
  // problems dir (the generic pool stays untouched — queue items reference
  // problem dirs explicitly).
  const { loadTarget } = await import('./intake.js');
  const { positional, flags } = parseFlags(process.argv.slice(3));
  const [targetId, specId] = positional;
  const t = targetId ? loadTarget(repoRoot, targetId) : null;
  if (!t) {
    console.error('usage: cli.ts generate-for <target-id> [spec-id] [--into <dir>]');
    process.exit(64);
  }
  const spec = specId ? t.specs.find((s) => s.id === specId) : t.specs[0];
  if (!spec) {
    console.error(`no confirmed spec ${specId ? `"${specId}" ` : ''}on target ${t.id} — run target infer --accept first`);
    process.exit(2);
  }
  // The blueprint IS the round description when one exists; the legacy
  // five-part brief is the fallback for specs drafted before blueprints.
  // A planned title stays a COMMITMENT either way: the timeline already
  // shows it, so the generated problem must be that system, not a re-roll.
  const { composeRoundBrief, loadBlueprint } = await import('./blueprint.js');
  const bp = loadBlueprint(repoRoot, t.id, spec.id);
  if (bp) console.log(`[generate-for] using blueprint ${spec.id}.md`);
  const brief = composeRoundBrief({
    spec,
    blueprint: bp,
    plannedTitle: flags.title,
    description: t.description,
    context: t.context,
  });
  const { targetDir: tDir } = await import('./intake.js');
  // --into pins the output dir (queue items know their dir up front, so
  // status can be derived from disk); default keeps the ad-hoc behavior.
  const dir = flags.into
    ? path.resolve(flags.into)
    : path.join(tDir(repoRoot, t.id), 'problems', `${spec.id}-${Date.now().toString(36)}`);
  console.log(`[generate-for] ${t.id} / ${spec.id} → ${dir}`);
  // Gap-graph emphasis travels into queue-driven generation the same way
  // prepare's does — via the target note.
  const store = loadStore(path.join(repoRoot, 'gaps'), userId);
  const note = buildTargetNote(buildGraphView(store), store);
  process.exit(await generateInto(dir, note, brief, spec));
} else if (cmd === 'blueprint') {
  // Draft the round blueprint for one spec. Idempotent: an existing file is
  // the terminal state, which is what makes accept-spec's unconditional
  // detached spawns safe. Failure exits non-zero with NOTHING written —
  // generation falls back to the legacy brief until a draft lands.
  const { loadTarget } = await import('./intake.js');
  const {
    blueprintPath, draftingMarkerPath, gateBlueprint, pickBlueprintDrafter,
    pickSkeletonFile, writeBlueprintWithBackup,
  } = await import('./blueprint.js');
  const { existsSync: ex, mkdirSync: mkd, rmSync: rmf, writeFileSync: wf } = await import('node:fs');
  const [targetId, specId] = process.argv.slice(3);
  const t = targetId ? loadTarget(repoRoot, targetId) : null;
  const spec = t?.specs.find((s) => s.id === specId);
  if (!t || !spec) {
    console.error('usage: cli.ts blueprint <target-id> <spec-id>');
    process.exit(t ? 2 : 64);
  }
  const file = blueprintPath(repoRoot, t.id, spec.id);
  if (ex(file)) {
    console.log(`[blueprint] ${spec.id}.md already exists — nothing to do`);
    process.exit(0);
  }
  const marker = draftingMarkerPath(repoRoot, t.id, spec.id);
  mkd(path.dirname(marker), { recursive: true });
  wf(marker, new Date().toISOString());
  try {
    const skeleton = readFileSync(
      path.join(repoRoot, 'prompts', 'blueprints', pickSkeletonFile(spec)),
      'utf8',
    );
    const draft = pickBlueprintDrafter(path.join(repoRoot, 'prompts', 'draft-blueprint.md'));
    const markdown = gateBlueprint(
      await draft({ spec, description: t.description ?? '', context: t.context ?? '', skeleton }),
    );
    writeBlueprintWithBackup(repoRoot, t.id, spec.id, markdown);
    console.log(`[blueprint] wrote ${path.relative(repoRoot, file)} (${markdown.length} chars)`);
  } catch (e) {
    console.error(`[blueprint] draft failed for ${t.id}/${spec.id}: ${String(e)}`);
    process.exit(1);
  } finally {
    rmf(marker, { force: true });
  }
} else if (cmd === 'app') {
  const { runApp } = await import('./app.js');
  runApp({ port: 3300, sessionPort: 3200, userId });
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
  // Both universes: the generic pool AND every target's own problems dir —
  // the lookup predated targets, which silently made every targeted session
  // un-rejudgeable ("no .used marker names it" on a marker that existed).
  const candidateDirs: string[] = [];
  try {
    for (const dir of readdirSync(problemsRoot)) candidateDirs.push(path.join(problemsRoot, dir));
  } catch { /* no pool */ }
  try {
    for (const t of readdirSync(path.join(repoRoot, 'targets'))) {
      const probs = path.join(repoRoot, 'targets', t, 'problems');
      try {
        for (const dir of readdirSync(probs)) candidateDirs.push(path.join(probs, dir));
      } catch { /* target without problems */ }
    }
  } catch { /* no targets */ }
  let problemDir: string | null = null;
  for (const dir of candidateDirs) {
    try {
      if (readFileSync(path.join(dir, '.used'), 'utf8').split('\n')[0] === sessionId) {
        problemDir = dir;
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
    const { resolveRoundSpec } = await import('@interview-prep/shared');
    const spec = resolveRoundSpec(problem);
    store = recordAssessment(store, result, spec.label, spec.memory_tags);
    saveStore(path.join(repoRoot, 'gaps'), store);
    console.error('[rejudge] recorded into the gap graph');
  }
  const card = buildAssessmentCard(
    result,
    buildGraphView(store, sessionId),
    events,
    problem.planted_bug?.description,
  );
  // --record also refreshes the persisted card — the planning page reads
  // feedback/<sid>.json, and a rescued session must show its rescue there,
  // not the stale "unassessed" card finalize wrote. Merge-preserve fields
  // the rejudge context does not have (voice health, page view).
  if (process.argv.includes('--record')) {
    const fbDir = path.join(repoRoot, 'feedback');
    mkdirSync(fbDir, { recursive: true });
    const fbPath = path.join(fbDir, `${sessionId}.json`);
    let existing: Record<string, unknown> = {};
    try {
      existing = JSON.parse(readFileSync(fbPath, 'utf8')) as Record<string, unknown>;
    } catch { /* first card for this session */ }
    writeFileSync(fbPath, JSON.stringify({ ...existing, card }, null, 2));
    console.error('[rejudge] feedback card refreshed');
  }
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
  // targets/<target-id>/problems/<item-id> — the reverse link the session
  // page needs for "← back to plan". Pool problems have no target.
  const targetMatch = path
    .relative(repoRoot, problemDir)
    .match(/^targets\/([^/]+)\/problems\//);
  await runSession({
    onReady: () => markUsed(problemDir, sessionId),
    repoRoot,
    problemDir,
    sessionId,
    userId,
    targetId: targetMatch?.[1],
    appUrl: process.env.IP_APP_URL,
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
      '  cli.ts session [dir]     run a session (picks from pool if dir omitted)\n' +
      '  cli.ts target <add|list|infer> ...   season-program targets\n' +
      '  cli.ts generate-for <target-id> [spec-id]   generate from a confirmed spec\n' +
      '  cli.ts blueprint <target-id> <spec-id>   draft the round blueprint (idempotent)\n' +
      '  cli.ts app               run the home app (:3300) - targets, queues, launch',
  );
  process.exit(64);
}
