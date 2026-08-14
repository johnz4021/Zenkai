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
import { appendRun, backfillRunFromUsed, dirRanSession, makePristineArchive, readRuns } from './artifact.js';

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

/** Validated port env read: unset/empty/garbage falls back — Number('') is 0,
 *  which listen() would treat as "any port" and quietly break the contract. */
function portEnv(v: string | undefined, fallback: number): number {
  const n = Number(v?.trim());
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : fallback;
}

/** Dataset-sourced build context, resolved by resolveSourceBinding().
 *  One part = a single problem (the historical shape); N parts = a
 *  multi-part OA set, escalation order already applied by the binder. */
interface SourcedBuild {
  parts: import('./lc-convert.js').SourcedPart[];
  mode: import('./lc-convert.js').SourceMode;
}

/**
 * "--source lc:<slug>" (or a rep/queue binding) → the full sourced-build
 * context, or a hard exit. An explicitly bound slug that cannot resolve
 * must FAIL the build, never silently substitute an invented problem —
 * the binding is a commitment the user can see.
 */
async function resolveSourceBinding(
  sourceRef: string,
  modeFlag: string | undefined,
  spec?: import('@interview-prep/shared').RoundSpec,
): Promise<SourcedBuild> {
  const lc = await import('./lc-source.js');
  const cv = await import('./lc-convert.js');
  const mode = modeFlag ?? 'skinned';
  if (mode !== 'skinned' && mode !== 'verbatim') {
    console.error(`--source-mode out of vocabulary: ${mode} (skinned|verbatim)`);
    process.exit(64);
  }
  // "lc:a,b,c" = a multi-part set, in part order. Every slug runs the one
  // ladder (lc-source.ts); ANY failure exits 2 — an explicit binding is a
  // commitment, and a silently smaller set is a silently different round.
  const slugs = sourceRef.replace(/^lc:/, '').split(',').map((x) => x.trim()).filter(Boolean);
  if (slugs.length === 0 || slugs.length > 4) {
    console.error(`[source] expected 1-4 slugs, got ${slugs.length}`);
    process.exit(2);
  }
  const parts: import('./lc-convert.js').SourcedPart[] = [];
  for (const slug of slugs) {
    const verdict = lc.sourceBindingVerdict(repoRoot, slug);
    if (!verdict.ok) {
      console.error(`[source] ${verdict.reason}`);
      process.exit(2);
    }
    const problem = lc.loadLcProblem(repoRoot, slug);
    if (!problem) {
      console.error(`[source] index lists "${slug}" but its problem file is missing — rerun lc fetch`);
      process.exit(2);
    }
    // Per-part budget ~12 keeps a set's combined suite readable; the
    // min_tests floor is whole-round and only binds single-part rounds.
    const cases = slugs.length > 1
      ? cv.selectCases(problem.cases, undefined, 12)
      : cv.selectCases(problem.cases, spec?.check.min_tests);
    parts.push({ problem, cases });
  }
  return { parts, mode };
}

async function generateInto(
  targetDir: string,
  targetNote?: string,
  brief: string = THEME,
  spec?: import('@interview-prep/shared').RoundSpec,
  sourced?: SourcedBuild,
  /** The plan's frozen concept vocabulary — when present, the generator's
   *  topics_exercised declaration is subset-filtered against it below. */
  allowedTopics?: import('./concept-topics.js').ConceptTopic[],
): Promise<number> {
  let sourceBlock: string | undefined;
  if (sourced) {
    const cv = await import('./lc-convert.js');
    // The grading contract goes on disk BEFORE the agent runs — the agent
    // reads it, never authors it.
    const emitted = cv.writeSourcedTests(targetDir, sourced.parts, sourced.mode);
    sourceBlock = cv.sourceRequirements(sourced.parts, sourced.mode);
    for (const part of sourced.parts) {
      console.log(`[source] ${part.problem.slug} (${sourced.mode}): ${part.cases.length} cases emitted`);
    }
    if (sourced.parts.length > 1) console.log(`[source] set of ${sourced.parts.length} parts (${emitted.count} cases total, ${emitted.large} large)`);
  }
  const result = await generateProblem({
    targetDir,
    brief,
    spec,
    targetNote,
    sourceBlock,
    templatePath,
    // Sourced builds are a transform, not invention — they run tighter.
    model: sourced ? 'sonnet' : 'opus',
    ...(sourced ? { timeoutMs: 5 * 60_000, maxTurns: 40 } : {}),
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
    // The claude -p json payload carries the real failure (subtype,
    // is_error, num_turns) — stderr alone diagnosed nothing when a sourced
    // build died silently on 2026-08-12.
    console.error('--- result payload (head) ---\n' + result.stdout.slice(0, 1500));
    console.error('--- stderr ---\n' + result.stderr.slice(0, 2000));
    // NOT fatal on its own. A timeout SIGTERM lands wherever the agent
    // happened to be, which is often AFTER the round is finished and the
    // suite has run — rep-msql2oxf was killed at 480.7s holding three
    // parts, three passing suites and a manifest that validated cleanly,
    // and the non-zero exit threw all of it away ($1.64). The artifact
    // decides whether a build succeeded, never the exit code; fall through
    // to the validator and let it rule.
    console.error('[generate] run did not exit cleanly — validating the artifact anyway');
  }
  if (sourced) {
    // Tamper-proof re-emit: whatever the agent did to the grading contract,
    // the validated artifact carries the deterministic one. And the manifest
    // source stamp is patched from the DATASET record, never trusted from
    // the generator — the topic ledger records truth.
    const cv = await import('./lc-convert.js');
    const { writeFileSync: wf, readFileSync: rf } = await import('node:fs');
    cv.writeSourcedTests(targetDir, sourced.parts, sourced.mode);
    try {
      const manifestPath = path.join(targetDir, 'problem.json');
      const manifest = JSON.parse(rf(manifestPath, 'utf8')) as Record<string, unknown>;
      const primary = sourced.parts[0]!.problem;
      manifest.source = {
        kind: 'leetcode',
        slug: primary.slug,
        title: primary.title,
        difficulty: primary.difficulty,
        tags: primary.tags,
        mode: sourced.mode,
        ...(sourced.parts.length > 1
          ? {
              parts: sourced.parts.map((part) => ({
                slug: part.problem.slug,
                title: part.problem.title,
                difficulty: part.problem.difficulty,
                tags: part.problem.tags,
              })),
            }
          : {}),
      };
      wf(manifestPath, JSON.stringify(manifest, null, 2));
    } catch {
      // Missing/unparseable manifest — the validator reports it properly below.
    }
  }
  // Plan-topic subset filter — same doctrine as the source stamp above: the
  // manifest field is never trusted from the generator. With a frozen list,
  // the declaration is filtered to it (drops logged); without one there is
  // no vocabulary to validate against, so any declaration is stripped
  // entirely. Runs on every build, sourced or invented.
  try {
    const { filterExercised } = await import('./concept-topics.js');
    const { writeFileSync: wf, readFileSync: rf } = await import('node:fs');
    const manifestPath = path.join(targetDir, 'problem.json');
    const manifest = JSON.parse(rf(manifestPath, 'utf8')) as Record<string, unknown>;
    if (manifest.topics_exercised !== undefined || allowedTopics?.length) {
      const { kept, dropped } = filterExercised(manifest.topics_exercised, allowedTopics ?? []);
      if (dropped.length) console.warn(`[topics] dropped out-of-plan declaration(s): ${dropped.join(', ')}`);
      if (kept.length) manifest.topics_exercised = kept;
      else delete manifest.topics_exercised;
      wf(manifestPath, JSON.stringify(manifest, null, 2));
    }
  } catch {
    // Missing/unparseable manifest — the validator reports it properly below.
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
    // Pristine copy taken here, after the second sweep and before any session
    // can bind-mount and mutate the tree (TODOS #48). Never fatal: a failed
    // archive must not fail a build that already spent real money.
    const arch = makePristineArchive(targetDir);
    if (!arch.ok) console.warn(`[artifact] pristine archive skipped: ${arch.skipped}`);
    if (!result.ok) console.log('[generate] the killed run had already finished — kept');
  }
  // 2 = ran clean but the artifact is not a valid round; 1 = died AND left
  // nothing usable. Both are non-zero, so the app still marks .failed.
  return report.ok ? 0 : result.ok ? 2 : 1;
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
          const { plannerSummary } = await import('./planner.js');
          const summary = plannerSummary(repoRoot, t.id);
          const md = await bp.pickBlueprintDrafter(path.join(repoRoot, 'prompts', 'draft-blueprint.md'))({
            spec: draft.spec,
            description: t.description ?? '',
            context: [t.context ?? '', summary].filter(Boolean).join('\n\n'),
            skeleton,
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
    topics: t.topics,
  });
  const { targetDir: tDir } = await import('./intake.js');
  // --into pins the output dir (queue items know their dir up front, so
  // status can be derived from disk); default keeps the ad-hoc behavior.
  const dir = flags.into
    ? path.resolve(flags.into)
    : path.join(tDir(repoRoot, t.id), 'problems', `${spec.id}-${Date.now().toString(36)}`);
  console.log(`[generate-for] ${t.id} / ${spec.id} → ${dir}`);
  // Dataset-sourced item: the queue binding arrives as --source lc:<slug>
  // (spawnGeneration pushes it exactly like --title).
  const sourced = flags.source
    ? await resolveSourceBinding(flags.source, flags['source-mode'], spec)
    : undefined;
  // Gap-graph emphasis travels into queue-driven generation the same way
  // prepare's does — via the target note.
  const store = loadStore(path.join(repoRoot, 'gaps'), userId);
  const note = buildTargetNote(buildGraphView(store), store);
  process.exit(await generateInto(dir, note, brief, spec, sourced, t.topics));
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
    // Planner-settled facts (when a conversation planned this target) ride
    // along as context — the blueprint is where they reach generation.
    const { plannerSummary } = await import('./planner.js');
    const summary = plannerSummary(repoRoot, t.id);
    const draft = pickBlueprintDrafter(path.join(repoRoot, 'prompts', 'draft-blueprint.md'));
    const markdown = gateBlueprint(
      await draft({
        spec,
        description: t.description ?? '',
        context: [t.context ?? '', summary].filter(Boolean).join('\n\n'),
        skeleton,
      }),
    );
    writeBlueprintWithBackup(repoRoot, t.id, spec.id, markdown);
    console.log(`[blueprint] wrote ${path.relative(repoRoot, file)} (${markdown.length} chars)`);
  } catch (e) {
    console.error(`[blueprint] draft failed for ${t.id}/${spec.id}: ${String(e)}`);
    process.exit(1);
  } finally {
    rmf(marker, { force: true });
  }
} else if (cmd === 'rep-build') {
  // The practice door's build: draft the blueprint, then generate — ONE
  // detached child for both phases, so the .generating marker written at
  // request time carries a single honest pid across drafting AND building
  // (sweepVerdict stays correct if the app restarts during either).
  const { loadReps, repBlueprintPath, repProblemDir, REP_ID_RE, DRAFT_FAILURE_PREFIX } =
    await import('./reps.js');
  const bp = await import('./blueprint.js');
  const { clearGeneratingMarker } = await import('./generation-state.js');
  const { writeFileSync: wf, mkdirSync: mkd } = await import('node:fs');
  if (!target || !REP_ID_RE.test(target)) {
    console.error('usage: cli.ts rep-build <rep-id>');
    process.exit(64);
  }
  const rep = loadReps(repoRoot).items.find((r) => r.id === target);
  if (!rep) {
    console.error(`no rep "${target}" in reps.json`);
    process.exit(2);
  }
  const problemDir = repProblemDir(repoRoot, rep.id);
  const bpFile = repBlueprintPath(repoRoot, rep.id);
  // Draft, idempotent: an existing blueprint is the terminal state, so a
  // retry after a GENERATION failure skips the ~30s redraft for free.
  if (!existsSync(bpFile)) {
    try {
      const skeleton = readFileSync(
        // The stored hypothesis (confirmed on the rail) routes the skeleton;
        // pre-taxonomy reps have none and fall back to capability facts.
        path.join(repoRoot, 'prompts', 'blueprints', bp.pickSkeletonFile(
          rep.spec,
          (bp.ROUND_TASKS as readonly string[]).includes(rep.task ?? '') ? rep.task as import('./blueprint.js').RoundTask : undefined,
        )),
        'utf8',
      );
      const markdown = bp.gateBlueprint(
        await bp.pickBlueprintDrafter(path.join(repoRoot, 'prompts', 'draft-blueprint.md'))({
          spec: rep.spec,
          description: rep.description,
          context: rep.context ?? '',
          skeleton,
        }),
      );
      wf(bpFile, markdown);
      console.log(`[rep-build] blueprint drafted (${markdown.length} chars)`);
    } catch (e) {
      // The "draft: " prefix IS the draft_failed encoding — stored statuses
      // never leave the QueueItem union; derivePhase reads this prefix.
      mkd(problemDir, { recursive: true });
      clearGeneratingMarker(problemDir);
      wf(path.join(problemDir, '.failed'), `${DRAFT_FAILURE_PREFIX}${String(e).slice(0, 500)}\n`);
      console.error(`[rep-build] blueprint draft failed for ${rep.id}: ${String(e)}`);
      process.exit(1);
    }
  }
  const brief = (await import('./blueprint.js')).composeRoundBrief({
    spec: rep.spec,
    blueprint: readFileSync(bpFile, 'utf8'),
    description: rep.description,
    context: rep.context,
  });
  // A rep's source binding lives on the rep record itself (reps.json),
  // not a flag — rep-build re-reads it like it re-reads everything else.
  const sourced = rep.source?.kind === 'leetcode'
    ? await resolveSourceBinding(
        (rep.source.parts ?? [rep.source]).map((part) => part.slug).join(','),
        process.env.IP_LC_MODE,
        rep.spec,
      )
    : undefined;
  // Gap-graph emphasis travels in exactly like generate-for's.
  const store = loadStore(path.join(repoRoot, 'gaps'), userId);
  const note = buildTargetNote(buildGraphView(store), store);
  console.log(`[rep-build] ${rep.id} → ${problemDir}`);
  process.exit(await generateInto(problemDir, note, brief, rep.spec, sourced));
} else if (cmd === 'app') {
  const { runApp } = await import('./app.js');
  const { resolvePublicConfig } = await import('./public-config.js');
  runApp({ port: 3300, sessionPort: 3200, userId, pub: resolvePublicConfig(process.env) });
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

  // Find the problem this session ran. ALL THREE universes: the generic
  // pool, every target's problems dir, and reps/<id>/problem — the lookup
  // predated targets, which silently made every targeted session
  // un-rejudgeable ("no .used marker names it" on a marker that existed),
  // and the same regression recurred for rep-based rounds when the practice
  // door landed (QA 2026-08-14: sess-qa814-lcset4 was named by
  // reps/rep-set67388/problem/.used and still exited 2). The match is
  // dirRanSession, not the .used first line: .used names only the LATEST
  // run, so on a repeated dir every earlier session would be a fourth way to
  // lose this lookup — the append-only .runs.jsonl ledger covers them.
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
  try {
    for (const r of readdirSync(path.join(repoRoot, 'reps'))) {
      candidateDirs.push(path.join(repoRoot, 'reps', r, 'problem'));
    }
  } catch { /* no reps */ }
  let problemDir: string | null = null;
  for (const dir of candidateDirs) {
    try {
      if (dirRanSession(dir, sessionId)) {
        problemDir = dir;
        break;
      }
    } catch {
      /* unused problem */
    }
  }
  if (!problemDir) {
    console.error(`no problem found for session ${sessionId} (no .used marker or run ledger names it)`);
    process.exit(2);
  }
  const problem = JSON.parse(readFileSync(path.join(problemDir, 'problem.json'), 'utf8'));

  console.error(`[rejudge] ${sessionId} against ${path.basename(problemDir)}...`);
  console.error(renderTimeline(events).split('\n').slice(0, 3).join('\n') + '\n...');
  const result = await judgeSession({
    sessionId,
    events,
    problem,
    problemDir,
    templatePath: path.join(repoRoot, 'prompts', 'judge-session.md'),
  });
  mkdirSync(path.join(repoRoot, 'assessments'), { recursive: true });
  // A failed judge call must never replace an assessed record with a stub —
  // the same invariant session.ts holds for the gap graph ("a judge failure
  // must not become history"). Forced by QA 2026-08-14: a rotated API key
  // made every rejudge 401, and the unconditional write shredded a good
  // assessment (summary, six verdicts, citations, version stamps) into a
  // 4-field unassessed stub.
  const assessPath = path.join(repoRoot, 'assessments', `${sessionId}.json`);
  let priorAssessed = false;
  try {
    priorAssessed =
      (JSON.parse(readFileSync(assessPath, 'utf8')) as { status?: string }).status === 'assessed';
  } catch { /* no prior record */ }
  if (result.status !== 'assessed' && priorAssessed) {
    console.error('[rejudge] judge failed — keeping the existing assessed record untouched');
  } else {
    writeFileSync(assessPath, JSON.stringify(result, null, 2));
  }

  // Deposits belong to whoever RAN the round, not whoever is at the terminal.
  // The dir was just resolved through the run ledger, which records the owner,
  // so read it back: an operator rejudging a beta user's crashed round (the
  // documented recovery) would otherwise bank the result in their own gap
  // graph and topic ledger, leaving the user's memory blind to their own
  // session. Falls back to IP_USER_ID for pre-ledger runs.
  const owner =
    readRuns(problemDir).find((r) => r.session_id === sessionId && r.user_id !== 'unknown')?.user_id ?? userId;
  if (owner !== userId) console.error(`[rejudge] depositing as ${owner} (the user who ran it)`);

  // --record writes into the gap graph; plain rejudge is a dry look.
  // QA sessions never deposit — the mint-shape boundary finalize enforces
  // (see isMemorableSessionId for the two pollution incidents behind it).
  let store = loadStore(path.join(repoRoot, 'gaps'), owner);
  const { isMemorableSessionId } = await import('./gap-graph.js');
  if (process.argv.includes('--record') && result.status === 'assessed' && isMemorableSessionId(sessionId)) {
    const { resolveRoundSpec } = await import('@interview-prep/shared');
    const spec = resolveRoundSpec(problem);
    // The owning plan, when the .used-marker dir sits under a target — the
    // same derivation session launch uses.
    const rejudgeTargetId = /^targets\/([^/]+)\/problems\//.exec(path.relative(repoRoot, problemDir))?.[1];
    store = recordAssessment(store, result, spec.label, spec.memory_tags, rejudgeTargetId);
    saveStore(path.join(repoRoot, 'gaps'), store);
    console.error('[rejudge] recorded into the gap graph');
    // Topic ledger: rejudge REPLACES the session's row (upsert by
    // session_id) — corrective, never inflationary, unlike #34.
    try {
      const tg = await import('./topic-graph.js');
      const attempts = tg.attemptsFromSession({ assessment: result, problem, spec, events, origin: 'rejudge' });
      if (attempts.length) {
        tg.recordTopicAttempts(repoRoot, owner, attempts);
        console.error(`[rejudge] topic ledger updated (${attempts.length} row${attempts.length === 1 ? '' : 's'})`);
      }
    } catch (e) {
      console.warn(`[rejudge] topic record skipped: ${String(e)}`);
    }
    // Plan topic-log: same corrective upsert, same never-fatal posture.
    if (rejudgeTargetId && Array.isArray(problem.topics_exercised) && problem.topics_exercised.length) {
      try {
        const { recordTopicLogRow } = await import('./topic-log.js');
        recordTopicLogRow(repoRoot, rejudgeTargetId, {
          session_id: sessionId,
          ts: result.judged_at,
          topics: problem.topics_exercised,
          solved: result.solved ?? null,
        });
        console.error('[rejudge] plan topic-log updated');
      } catch (e) {
        console.warn(`[rejudge] plan-topic record skipped: ${String(e)}`);
      }
    }
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
} else if (cmd === 'purge-qa') {
  // Memory hygiene: remove QA-harness sessions from the gap store and the
  // LC topic ledger. Harness runs deposited as real history twice — qa-lc-*
  // (2026-08-13), then sess-qa813/qa814-* which beat the prefix guard
  // (found 2026-08-14: 12 of 22 store sessions, 100% of the ledger). The
  // predicate is the shared mint-shape boundary (isMemorableSessionId);
  // the recording guard stops NEW pollution, this removes existing rows.
  // Backup-first (gaps/ SIBLING, never gaps/archive/ — the memory reader
  // treats archive files as excluded eras), atomic writes, and --dry-run
  // prints the focus-ranking diff: dropping sessions shifts sessionsAgo,
  // so the 0.5^(n/5) weights feeding buildTargetNote — live generation and
  // the interviewer — move too. That diff must be seen before it applies.
  const dryRun = process.argv.includes('--dry-run');
  const { mkdirSync, renameSync, writeFileSync } = await import('node:fs');
  const { isMemorableSessionId } = await import('./gap-graph.js');
  const gapsDir = path.join(repoRoot, 'gaps');
  const store = loadStore(gapsDir, userId);
  const qaIds = new Set(store.sessions.map((s) => s.session_id).filter((id) => !isMemorableSessionId(id)));

  const tg = await import('./topic-graph.js');
  let topicStore: import('./topic-graph.js').TopicStore | null = null;
  try {
    topicStore = tg.loadTopicStore(tg.topicsDir(repoRoot), userId);
  } catch (e) {
    console.warn(`[purge-qa] topic ledger unreadable, skipping it: ${String(e).slice(0, 120)}`);
  }
  const qaAttempts = topicStore?.attempts.filter((a) => !isMemorableSessionId(a.session_id)) ?? [];

  if (qaIds.size === 0 && qaAttempts.length === 0) {
    console.log('[purge-qa] nothing to purge — both stores are clean');
    process.exit(0);
  }

  const next = {
    ...store,
    sessions: store.sessions.filter((s) => !qaIds.has(s.session_id)),
    gaps: Object.fromEntries(
      Object.entries(store.gaps).map(([k, g]) => [
        k,
        { ...g, instances: g.instances.filter((i) => !qaIds.has(i.session_id)) },
      ]),
    ),
  };

  const rank = (s: typeof store) =>
    buildGraphView(s).active.map((g) => `${g.key}:${g.weight}`).join('  ');
  console.log(`[purge-qa] gap-store sessions to remove (${qaIds.size}): ${[...qaIds].join(', ') || '—'}`);
  console.log(`[purge-qa] topic-ledger rows to remove (${qaAttempts.length}): ${qaAttempts.map((a) => `${a.session_id}(${a.slug})`).join(', ') || '—'}`);
  console.log(`[purge-qa] focus ranking before: ${rank(store)}`);
  console.log(`[purge-qa] focus ranking after:  ${rank(next)}`);
  if (dryRun) {
    console.log('[purge-qa] dry run — nothing written');
    process.exit(0);
  }

  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  if (qaIds.size > 0) {
    // Backup is a SIBLING file, deliberately NOT gaps/archive/: the memory
    // reader treats every file there as an excluded ERA, and this backup is
    // a full store snapshot — putting it in archive/ blacklists every live
    // session it contains (caught by the 2026-08-14 smoke test: the Gaps
    // band collapsed from 10 sessions to 2). loadStore reads exactly
    // `${userId}.json`, so the suffixed sibling is inert.
    mkdirSync(gapsDir, { recursive: true });
    writeFileSync(path.join(gapsDir, `${userId}-pre-qa-purge-${stamp}.backup.json`), JSON.stringify(store, null, 2));
    // saveStore is a plain write (#17); the store this command exists to
    // protect gets the atomic path.
    const file = path.join(gapsDir, `${userId}.json`);
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(next, null, 2));
    renameSync(tmp, file);
    console.log(`[purge-qa] gap store written; backup at gaps/${userId}-pre-qa-purge-${stamp}.backup.json`);
  }
  if (topicStore && qaAttempts.length > 0) {
    writeFileSync(
      path.join(tg.topicsDir(repoRoot), `${userId}-pre-qa-purge-${stamp}.json`),
      JSON.stringify(topicStore, null, 2),
    );
    tg.saveTopicStore(tg.topicsDir(repoRoot), {
      ...topicStore,
      attempts: topicStore.attempts.filter((a) => isMemorableSessionId(a.session_id)),
    });
    console.log(`[purge-qa] topic ledger written; archive at topics/${userId}-pre-qa-purge-${stamp}.json`);
  }
  process.exit(0);
} else if (cmd === 'validate') {
  const dir = path.resolve(target ?? '.');
  const report = validateProblem(dir);
  // Match the generate path's post-validate hygiene (QA 2026-08-14):
  // running the suite leaves __pycache__ inside a dir the candidate will
  // see, and a passing validate that wrote no marker left the pool and the
  // queue unable to tell a validated problem from an unchecked one — the
  // pipeline diagram's ".validated" step simply never happened on this
  // path.
  // This sweep runs AFTER validateProblem's own suite run, so the tree the
  // pristine archive below captures is the one the candidate will see.
  const { removePythonArtifacts } = await import('./generation-state.js');
  removePythonArtifacts(dir);
  if (report.ok) {
    const { writeFileSync: wf } = await import('node:fs');
    wf(path.join(dir, '.validated'), new Date().toISOString());
    // Same pristine copy the generate path takes (TODOS #48). Refuses on its
    // own when this command is pointed at a consumed dir or one that already
    // has an archive — never fatal, the report below is what validate means.
    const arch = makePristineArchive(dir);
    if (!arch.ok) console.warn(`[artifact] pristine archive skipped: ${arch.skipped}`);
  }
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
  // Session-side auth config (beta WU3): built from raw env, NOT
  // resolvePublicConfig — a spawned session deliberately receives no service
  // key (WU8), so the all-or-nothing supabase check would refuse to boot.
  // JWKS is public; the internal token arrives pre-derived from the app, or
  // is derived here when this is a direct `cli.ts session` run with a .env.
  const { deriveInternalToken } = await import('./auth.js');
  const sessionAuth = process.env.IP_SUPABASE_URL
    ? {
        supabaseUrl: process.env.IP_SUPABASE_URL.replace(/\/+$/, ''),
        ...(process.env.IP_SUPABASE_JWT_SECRET
          ? { jwtSecret: process.env.IP_SUPABASE_JWT_SECRET }
          : {}),
        adminEmails: (process.env.IP_AUTH_ADMIN_EMAILS ?? '')
          .split(',')
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean),
        localUserId: userId,
        internalToken:
          process.env.IP_INTERNAL_TOKEN ??
          (process.env.IP_SUPABASE_SERVICE_KEY
            ? deriveInternalToken(process.env.IP_SUPABASE_SERVICE_KEY)
            : null),
      }
    : undefined;
  await runSession({
    onReady: () => {
      // .used stays overwrite-latest (every existing reader depends on that);
      // the ledger beside it is the history a repeated dir needs. Bank the
      // OUTGOING sid first: a dir consumed before the ledger existed keeps its
      // only session binding in .used, and this write is what would erase it.
      backfillRunFromUsed(problemDir);
      markUsed(problemDir, sessionId);
      appendRun(problemDir, { session_id: sessionId, user_id: userId, at: new Date().toISOString() });
    },
    repoRoot,
    problemDir,
    sessionId,
    userId,
    targetId: targetMatch?.[1],
    appUrl: process.env.IP_APP_URL,
    auth: sessionAuth,
    multiSession: process.env.IP_MULTI_SESSION === '1',
    port: portEnv(process.env.IP_SESSION_PORT, 3200),
    idePort: portEnv(process.env.IP_IDE_PORT, 3100),
    autorunTests: process.env.IP_AUTORUN_TESTS !== '0',
    prepareNext: process.env.IP_PREPARE_NEXT !== '0',
    interviewer: process.env.IP_INTERVIEWER === '0' ? null : undefined,
    intentCheck: process.env.IP_INTERVIEWER === '0' ? null : undefined,
    voice: process.env.IP_VOICE !== '0',
  });
} else if (cmd === 'backup') {
  // Off-box backup of the irreplaceable dirs. Runs from cli.ts so the
  // Supabase key arrives via process.loadEnvFile — a shell one-liner
  // mangles it (docs/beta-runbook.md, and this file's own history).
  const { runBackup } = await import('./backup.js');
  const { flags } = parseFlags(process.argv.slice(3));
  const url = process.env.IP_SUPABASE_URL;
  const key = process.env.IP_SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    console.error('[backup] IP_SUPABASE_URL and IP_SUPABASE_SERVICE_KEY are required');
    process.exit(2);
  }
  try {
    console.log(await runBackup(repoRoot, {
      supabaseUrl: url,
      serviceKey: key,
      ...(flags.bucket ? { bucket: flags.bucket } : {}),
      ...(flags.keep ? { keep: Number(flags.keep) } : {}),
    }));
  } catch (e) {
    console.error(`[backup] ${String(e instanceof Error ? e.message : e)}`);
    process.exit(1);
  }
} else if (cmd === 'lc') {
  // Vendored LeetCode dataset ops. fetch is idempotent and pinned — see
  // LC_DATASET_PINS in lc-source.ts for the integrity story.
  const lc = await import('./lc-source.js');
  const sub = target;
  const { positional, flags } = parseFlags(process.argv.slice(4));
  if (sub === 'fetch') {
    try {
      console.log(await lc.fetchLcDataset(repoRoot, {
        ...(flags.from ? { fromDir: path.resolve(flags.from) } : {}),
        ...(flags.force === 'true' ? { force: true } : {}),
      }));
    } catch (e) {
      console.error(`[lc fetch] ${String(e)}`);
      process.exit(1);
    }
  } else if (sub === 'list') {
    const ready = lc.lcReady(repoRoot);
    if (!ready.ok) {
      console.error(ready.reason);
      process.exit(2);
    }
    let entries = lc.loadLcIndex(repoRoot);
    if (flags.eligible === 'true') entries = entries.filter(lc.eligibleForSourcing);
    if (flags.tag) entries = entries.filter((e) => e.tags.includes(flags.tag as never));
    if (flags.difficulty) entries = entries.filter((e) => e.difficulty === flags.difficulty);
    console.log(JSON.stringify({
      total: entries.length,
      problems: entries.slice(0, flags.all === 'true' ? entries.length : 50)
        .map((e) => ({ slug: e.slug, id: e.id, difficulty: e.difficulty, tags: e.tags, cases: e.n_cases })),
    }, null, 2));
  } else if (sub === 'show') {
    const slug = positional[0];
    const p = slug ? lc.loadLcProblem(repoRoot, slug) : null;
    if (!p) {
      console.error(slug ? `no problem "${slug}" in the dataset` : 'usage: cli.ts lc show <slug>');
      process.exit(2);
    }
    const { cases, solution, statement, ...meta } = p;
    console.log(JSON.stringify({ ...meta, n_cases: cases.length, statement_chars: statement.length }, null, 2));
    console.log('\n--- statement ---\n' + statement.slice(0, 1200));
  } else if (sub === 'verify') {
    // The keystone: prove the whole conversion against the oracle with NO
    // model call — raising stub must fail every emitted case, canonical
    // solution must pass every one, both parsed by the validator's own
    // parser. --generate adds the model-dependent leg (full sourced
    // generation + validateProblem), per the repo rule that model-calling
    // checks are CLI commands, never unit tests.
    const cv = await import('./lc-convert.js');
    const { spawnSync } = await import('node:child_process');
    const { mkdtempSync, rmSync: rmrf, writeFileSync: wf } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { parseUnittestOutput } = await import('./validate.js');
    const { childEnv } = await import('./child-env.js');
    const ready = lc.lcReady(repoRoot);
    if (!ready.ok) {
      console.error(ready.reason);
      process.exit(2);
    }
    const mode = (flags.mode ?? 'skinned') as import('./lc-convert.js').SourceMode;
    if (mode !== 'skinned' && mode !== 'verbatim') {
      console.error(`--mode out of vocabulary: ${String(flags.mode)} (skinned|verbatim)`);
      process.exit(64);
    }

    const runPy = (dir: string) => {
      const run = spawnSync('python3', ['-m', 'unittest', 'discover', '-v'], {
        cwd: dir, encoding: 'utf8', timeout: 180_000, env: childEnv('sandbox', process.env),
      });
      return parseUnittestOutput(`${run.stderr ?? ''}\n${run.stdout ?? ''}`);
    };
    const verifySlug = (slug: string): { ok: boolean; reason?: string } => {
      const p = lc.loadLcProblem(repoRoot, slug);
      if (!p) return { ok: false, reason: 'not in dataset' };
      if (!lc.eligibleForSourcing(lc.indexEntryOf(p))) {
        return { ok: false, reason: `ineligible (structures: ${p.structures.join('+')}, stdlib_only: ${p.stdlib_only}, cases: ${p.cases.length})` };
      }
      const cases = cv.selectCases(p.cases);
      const dir = mkdtempSync(path.join(tmpdir(), 'lc-verify-'));
      try {
        cv.writeSourcedTests(dir, [{ problem: p, cases }], mode);
        wf(path.join(dir, 'solution.py'), cv.renderRaisingStub(p, mode));
        const red = runPy(dir);
        if (red.total !== cases.length) return { ok: false, reason: `stub run ran ${red.total} of ${cases.length} (suite did not load?)` };
        if (red.failed.length !== red.total) return { ok: false, reason: `${red.total - red.failed.length} case(s) passed on the raising stub` };
        wf(path.join(dir, 'solution.py'), cv.renderOracleSolution(p, mode));
        const green = runPy(dir);
        if (green.total !== cases.length) return { ok: false, reason: `oracle run ran ${green.total} of ${cases.length}` };
        if (green.failed.length) return { ok: false, reason: `oracle failed ${green.failed.length}/${green.total} (first: ${green.failed[0]})` };
        return { ok: true };
      } finally {
        rmrf(dir, { recursive: true, force: true });
      }
    };

    if (flags['all-eligible'] === 'true') {
      const eligible = lc.loadLcIndex(repoRoot).filter(lc.eligibleForSourcing);
      const sample = flags.sample ? Math.max(1, Number(flags.sample)) : null;
      const step = sample ? Math.max(1, Math.floor(eligible.length / sample)) : 1;
      const picked = eligible.filter((_, i) => i % step === 0);
      const failures: { slug: string; reason: string }[] = [];
      let done = 0;
      for (const e of picked) {
        const v = verifySlug(e.slug);
        if (!v.ok) failures.push({ slug: e.slug, reason: v.reason! });
        done += 1;
        if (done % 50 === 0) console.error(`[lc verify] ${done}/${picked.length} (${failures.length} failing)`);
      }
      const report = {
        mode, checked: picked.length, ok: picked.length - failures.length, failures,
        dataset_revision: ready.version.revision, verified_at: new Date().toISOString(),
      };
      wf(path.join(lc.lcRoot(repoRoot), `verify-report-${mode}.json`), JSON.stringify(report, null, 2));
      // A FULL sweep's failures become the binding blocklist: eligible by
      // metadata but unproven against the oracle = never reaches a build.
      // Sampled sweeps don't write it (a partial list would read as total).
      if (!sample) {
        wf(
          path.join(lc.lcRoot(repoRoot), 'blocklist.json'),
          JSON.stringify({ mode, dataset_revision: ready.version.revision, slugs: failures.map((f) => f.slug).sort() }, null, 2),
        );
        console.error(`[lc verify] blocklist.json written (${failures.length} slugs)`);
      }
      console.log(JSON.stringify({ ...report, failures: failures.slice(0, 30) }, null, 2));
      process.exit(failures.length === 0 ? 0 : 3);
    }

    const slug = positional[0];
    if (!slug) {
      console.error('usage: cli.ts lc verify <slug> [--mode skinned|verbatim] [--generate] | lc verify --all-eligible [--sample N]');
      process.exit(64);
    }
    const mech = verifySlug(slug);
    console.log(JSON.stringify({ slug, mode, mechanical: mech }, null, 2));
    if (!mech.ok) process.exit(3);

    if (flags.generate === 'true') {
      // Model-dependent leg: a real sourced generation under the canonical
      // OA spec, validated like any queue build. Lands in problems/ but is
      // pre-marked .used so the session pool can never pick it up.
      const { deriveMemoryTags } = await import('@interview-prep/shared');
      const caps = {
        interviewer: false, can_run_tests: true, time_limit_ms: 3_600_000,
        starts_from: 'blank' as const, submit: 'one_shot' as const, surface: 'panes' as const,
      };
      const spec = {
        id: 'lc-verify-oa', label: 'LeetCode OA (verify)', capabilities: caps,
        check: { kind: 'all_failing' as const, max_source_files: 1 },
        memory_tags: deriveMemoryTags(caps),
      };
      const brief = readFileSync(path.join(repoRoot, 'prompts', 'blueprints', 'oa-hackerrank-classic.md'), 'utf8');
      const dir = path.join(problemsRoot, `lc-verify-${slug}-${Date.now().toString(36)}`);
      const sourced = await resolveSourceBinding(`lc:${slug}`, mode, spec);
      console.log(`[lc verify] generating into ${dir} ...`);
      const code = await generateInto(dir, undefined, brief, spec, sourced);
      wf(path.join(dir, '.used'), `lc-verify\n${new Date().toISOString()}\n`);
      console.log(code === 0 ? `[lc verify] generation validated — inspect ${dir}` : `[lc verify] generation FAILED (exit ${code}) — see output above`);
      process.exit(code);
    }
  } else {
    console.error('usage: cli.ts lc <fetch [--from <dir>] [--force] | list [--eligible] [--tag <t>] [--difficulty <d>] [--all] | show <slug> | verify <slug>|--all-eligible>');
    process.exit(64);
  }
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
      '  cli.ts rep-build <rep-id>   build a practice rep (draft blueprint + generate)\n' +
      '  cli.ts lc <fetch|list|show> ...   vendored LeetCode dataset ops\n' +
      '  cli.ts backup [--keep N]  tar gaps/topics/traces/feedback/targets → Supabase Storage\n' +
      '  cli.ts app               run the home app (:3300) - targets, queues, launch',
  );
  process.exit(64);
}
