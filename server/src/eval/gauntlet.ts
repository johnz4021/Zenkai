/**
 * THE JUDGE GAUNTLET — "don't stop until robust", made mechanical.
 *
 *   fixtures (ground truth by construction) ──► real judge ──► scorecard
 *
 * Five test formats (CEO plan 2026-07-30):
 *   1. persona suite       — scripted sessions, per-dimension verdict sets
 *   2. contrast pairs      — one behavior differs; target flips, others hold
 *   3. reliability pairs   — sensor-down must flip the target to unassessable
 *   4. simulated candidates— LLM-played personas for realistic mess (cached)
 *   5. self-consistency    — same fixture 5×; modal verdict share
 * Plus citation resolution measured across every run.
 *
 * This runs REAL model calls, so it is a CLI command, never vitest (repo
 * convention: unit tests never call a model). --quick uses haiku and 1
 * consistency run for cheap iteration; the full run gates on sonnet.
 *
 * The loop: run → read the scorecard → inspect stored raw outputs for the
 * failures → adjust judge-session.md / anchors / timeline rendering → rerun.
 * Prompt changes bump prompt_hash so runs stay comparable.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import type { DimensionKey, TraceEvent, Verdict } from '@interview-prep/shared';
import { DIMENSIONS } from '@interview-prep/shared';
import {
  apiJudgeModel,
  claudePJudgeModel,
  judgeSession,
  promptHash,
  type Assessment,
  type JudgeModel,
} from '../judge.js';
import {
  contrastPairs,
  personaFixtures,
  reliabilityPairs,
  FIXTURE_DEBUGGING_PROBLEM,
  FIXTURE_DSA_PROBLEM,
  type PersonaFixture,
} from './personas.js';

export interface GauntletOptions {
  repoRoot: string;
  quick?: boolean;
  /** Regenerate the simulated-candidate cache (costs generator calls). */
  simulate?: boolean;
  /** Reuse stored run outputs whose prompt_hash matches the current prompt
   *  — resume an interrupted run, or re-score cheaply after non-prompt
   *  changes. A prompt change invalidates the cache automatically. */
  resume?: boolean;
  /** Injectable for the gauntlet's own tests. */
  judgeModel?: JudgeModel;
  log?: (line: string) => void;
}

interface MetricResult {
  metric: string;
  score: number;
  threshold: number;
  pass: boolean;
  detail: string[];
}

export interface Scorecard {
  ran_at: string;
  mode: 'quick' | 'full';
  model: string;
  prompt_hash: string | null;
  metrics: MetricResult[];
  citation: { kept: number; total: number };
  pass: boolean;
}

const THRESHOLDS = {
  persona_agreement: 0.85,
  contrast_discrimination: 0.9,
  reliability_sensitivity: 1.0,
  format_adaptation: 0.8,
  simulated_agreement: 0.8,
  self_consistency: 0.8,
  citation_resolution: 0.95,
};

// ---- helpers ----

function verdictOf(a: Assessment, dim: DimensionKey): Verdict {
  return a.dimensions.find((d) => d.dimension === dim)!.verdict;
}

function countCitations(a: Assessment): { kept: number; total: number } {
  let kept = 0;
  let total = 0;
  for (const d of a.dimensions) {
    kept += d.evidence.length;
    total += d.evidence.length + (d.stripped_evidence?.length ?? 0);
  }
  return { kept, total };
}

export async function runGauntlet(opts: GauntletOptions): Promise<Scorecard> {
  const log = opts.log ?? ((l: string) => console.error(l));
  const mode = opts.quick ? 'quick' : 'full';
  const modelName = opts.judgeModel
    ? 'injected'
    : process.env.ANTHROPIC_API_KEY
      ? opts.quick
        ? 'claude-haiku-4-5 (api)'
        : 'claude-sonnet-5 (api)'
      : 'claude -p';
  const judgeModel =
    opts.judgeModel ??
    (process.env.ANTHROPIC_API_KEY
      ? apiJudgeModel(opts.quick ? 'claude-haiku-4-5' : 'claude-sonnet-5')
      : claudePJudgeModel(opts.quick ? 'haiku' : 'sonnet'));

  const templatePath = path.join(opts.repoRoot, 'prompts', 'judge-session.md');
  const outDir = path.join(opts.repoRoot, 'fixtures', 'judge', 'runs');
  mkdirSync(outDir, { recursive: true });

  const citation = { kept: 0, total: 0 };
  let promptHash2: string | null = null;
  let counter = 0;

  const currentHash = promptHash(readFileSync(templatePath, 'utf8'));

  const judge = async (id: string, events: TraceEvent[], problem: PersonaFixture['problem']) => {
    counter += 1;
    const runFile = path.join(outDir, `${id}.json`);
    if (opts.resume && existsSync(runFile)) {
      try {
        const cached = JSON.parse(readFileSync(runFile, 'utf8')) as Assessment | { status: string };
        if (cached.status === 'assessed' && (cached as Assessment).prompt_hash === currentHash) {
          log(`  [${counter}] ${id} (cached)`);
          promptHash2 = (cached as Assessment).prompt_hash;
          const c = countCitations(cached as Assessment);
          citation.kept += c.kept;
          citation.total += c.total;
          return cached as Assessment;
        }
      } catch {
        /* unreadable cache — re-judge */
      }
    }
    log(`  [${counter}] judging ${id}...`);
    const result = await judgeSession({
      sessionId: `gauntlet-${id}`,
      events,
      problem,
      templatePath,
      judgeModel,
      modelName,
    });
    // Store every raw result — failure inspection is the iteration loop.
    writeFileSync(path.join(outDir, `${id}.json`), JSON.stringify(result, null, 2));
    if (result.status === 'assessed') {
      promptHash2 = result.prompt_hash;
      const c = countCitations(result);
      citation.kept += c.kept;
      citation.total += c.total;
    }
    return result;
  };

  const metrics: MetricResult[] = [];

  // ---- 1. persona suite + 4. format adaptation (from behavior classes) ----
  log(`[gauntlet:${mode}] persona suite`);
  const personas = personaFixtures();
  let agree = 0;
  let scored = 0;
  const personaDetail: string[] = [];
  const byBehavior: Record<string, { id: string; ok: boolean }[]> = {};
  for (const p of personas) {
    const r = await judge(p.id, p.events, p.problem);
    if (r.status !== 'assessed') {
      personaDetail.push(`${p.id}: UNASSESSED (${r.reason})`);
      scored += Object.keys(p.expected).length;
      continue;
    }
    let personaOk = true;
    for (const [dim, accepted] of Object.entries(p.expected) as [DimensionKey, Verdict[]][]) {
      scored += 1;
      const got = verdictOf(r, dim);
      if (accepted.includes(got)) agree += 1;
      else {
        personaOk = false;
        personaDetail.push(`${p.id}.${dim}: got ${got}, accepted [${accepted.join('|')}]`);
      }
    }
    if (p.behavior_class) {
      (byBehavior[p.behavior_class] ??= []).push({ id: p.id, ok: personaOk });
    }
  }
  metrics.push({
    metric: 'persona_agreement',
    score: scored ? agree / scored : 0,
    threshold: THRESHOLDS.persona_agreement,
    pass: scored > 0 && agree / scored >= THRESHOLDS.persona_agreement,
    detail: personaDetail,
  });

  // Format adaptation: every behavior-class fixture must be judged correctly
  // under ITS round's bar (same behavior, different expectations).
  const adaptationChecks = Object.values(byBehavior).flat();
  const adaptOk = adaptationChecks.filter((c) => c.ok).length;
  metrics.push({
    metric: 'format_adaptation',
    score: adaptationChecks.length ? adaptOk / adaptationChecks.length : 0,
    threshold: THRESHOLDS.format_adaptation,
    pass: adaptationChecks.length > 0 && adaptOk / adaptationChecks.length >= THRESHOLDS.format_adaptation,
    detail: adaptationChecks.filter((c) => !c.ok).map((c) => `${c.id} missed its round's bar`),
  });

  // ---- 2. contrast pairs ----
  log(`[gauntlet:${mode}] contrast pairs`);
  let pairChecks = 0;
  let pairOk = 0;
  const pairDetail: string[] = [];
  for (const pair of contrastPairs()) {
    const withR = await judge(`${pair.id}-with`, pair.withBehavior, pair.problem);
    const withoutR = await judge(`${pair.id}-without`, pair.withoutBehavior, pair.problem);
    if (withR.status !== 'assessed' || withoutR.status !== 'assessed') {
      pairDetail.push(`${pair.id}: UNASSESSED`);
      pairChecks += 2;
      continue;
    }
    // Target must move as expected...
    pairChecks += 2;
    const gotWith = verdictOf(withR, pair.target);
    const gotWithout = verdictOf(withoutR, pair.target);
    if (pair.expectWith.includes(gotWith)) pairOk += 1;
    else pairDetail.push(`${pair.id}.with.${pair.target}: got ${gotWith}, accepted [${pair.expectWith.join('|')}]`);
    if (pair.expectWithout.includes(gotWithout)) pairOk += 1;
    else pairDetail.push(`${pair.id}.without.${pair.target}: got ${gotWithout}, accepted [${pair.expectWithout.join('|')}]`);
    // ...and the OTHER dimensions must hold (within one verdict step).
    const ladder: Verdict[] = ['weak', 'adequate', 'strong'];
    for (const dim of DIMENSIONS) {
      if (dim === pair.target) continue;
      const a = verdictOf(withR, dim);
      const b = verdictOf(withoutR, dim);
      pairChecks += 1;
      const ia = ladder.indexOf(a);
      const ib = ladder.indexOf(b);
      const held = a === b || (ia >= 0 && ib >= 0 && Math.abs(ia - ib) <= 1);
      if (held) pairOk += 1;
      else pairDetail.push(`${pair.id}.${dim}: moved ${b} -> ${a} but only ${pair.target} differed`);
    }
  }
  metrics.push({
    metric: 'contrast_discrimination',
    score: pairChecks ? pairOk / pairChecks : 0,
    threshold: THRESHOLDS.contrast_discrimination,
    pass: pairChecks > 0 && pairOk / pairChecks >= THRESHOLDS.contrast_discrimination,
    detail: pairDetail,
  });

  // ---- 3. reliability sensitivity ----
  log(`[gauntlet:${mode}] reliability pairs`);
  let relChecks = 0;
  let relOk = 0;
  const relDetail: string[] = [];
  for (const pair of reliabilityPairs()) {
    const healthyR = await judge(`${pair.id}-healthy`, pair.healthy, pair.problem);
    const degradedR = await judge(`${pair.id}-degraded`, pair.degraded, pair.problem);
    relChecks += 1;
    if (degradedR.status === 'assessed' && verdictOf(degradedR, pair.target) === 'unassessable') relOk += 1;
    else relDetail.push(`${pair.id}: degraded ${pair.target} was not unassessable`);
    relChecks += 1;
    if (healthyR.status === 'assessed' && verdictOf(healthyR, pair.target) === 'weak') relOk += 1;
    else relDetail.push(`${pair.id}: healthy silent ${pair.target} was not weak (real silence must still count)`);
  }
  metrics.push({
    metric: 'reliability_sensitivity',
    score: relChecks ? relOk / relChecks : 0,
    threshold: THRESHOLDS.reliability_sensitivity,
    pass: relChecks > 0 && relOk / relChecks >= THRESHOLDS.reliability_sensitivity,
    detail: relDetail,
  });

  // ---- 4. simulated candidates (cached; regenerate with --simulate) ----
  const simDir = path.join(opts.repoRoot, 'fixtures', 'judge', 'simulated');
  const simFixtures = loadOrGenerateSimulated(simDir, opts, log);
  if ((await simFixtures).length > 0) {
    log(`[gauntlet:${mode}] simulated candidates`);
    let simAgree = 0;
    let simScored = 0;
    const simDetail: string[] = [];
    for (const f of await simFixtures) {
      const r = await judge(f.id, f.events, f.problem);
      if (r.status !== 'assessed') {
        simDetail.push(`${f.id}: UNASSESSED`);
        simScored += Object.keys(f.expected).length;
        continue;
      }
      for (const [dim, accepted] of Object.entries(f.expected) as [DimensionKey, Verdict[]][]) {
        simScored += 1;
        const got = verdictOf(r, dim);
        if (accepted.includes(got)) simAgree += 1;
        else simDetail.push(`${f.id}.${dim}: got ${got}, accepted [${accepted.join('|')}]`);
      }
    }
    metrics.push({
      metric: 'simulated_agreement',
      score: simScored ? simAgree / simScored : 0,
      threshold: THRESHOLDS.simulated_agreement,
      pass: simScored > 0 && simAgree / simScored >= THRESHOLDS.simulated_agreement,
      detail: simDetail,
    });
  } else {
    metrics.push({
      metric: 'simulated_agreement',
      score: 0,
      threshold: THRESHOLDS.simulated_agreement,
      pass: false,
      detail: ['no simulated fixtures — run with --simulate once to generate the cache'],
    });
  }

  // ---- 5. self-consistency ----
  const runsEach = opts.quick ? 1 : 5;
  const consistencyIds = ['methodical-debugging', 'location-namer-debugging', 'never-verifier-debugging'];
  const consDetail: string[] = [];
  let consScore = 1;
  if (runsEach > 1) {
    log(`[gauntlet:${mode}] self-consistency (${runsEach} runs x ${consistencyIds.length})`);
    const targets = personaFixtures().filter((p) => consistencyIds.includes(p.id));
    let modalShareSum = 0;
    let modalShareCount = 0;
    for (const p of targets) {
      const verdicts: Record<string, Verdict[]> = {};
      for (let i = 0; i < runsEach; i++) {
        const r = await judge(`${p.id}-consistency-${i}`, p.events, p.problem);
        if (r.status !== 'assessed') continue;
        for (const d of r.dimensions) (verdicts[d.dimension] ??= []).push(d.verdict);
      }
      for (const [dim, vs] of Object.entries(verdicts)) {
        if (vs.length < runsEach) continue;
        const counts = new Map<Verdict, number>();
        for (const v of vs) counts.set(v, (counts.get(v) ?? 0) + 1);
        const modal = Math.max(...counts.values()) / vs.length;
        modalShareSum += modal;
        modalShareCount += 1;
        if (modal < 1) consDetail.push(`${p.id}.${dim}: ${vs.join(',')}`);
      }
    }
    consScore = modalShareCount ? modalShareSum / modalShareCount : 0;
  } else {
    consDetail.push('quick mode: consistency skipped (1 run each)');
  }
  metrics.push({
    metric: 'self_consistency',
    score: consScore,
    threshold: THRESHOLDS.self_consistency,
    pass: consScore >= THRESHOLDS.self_consistency,
    detail: consDetail,
  });

  // ---- 6. intent-check accuracy (from the live deafness incident) ----
  // The first judge-era live session had EVERY utterance — including "Yo,
  // interviewer, can you give me a hand?" — classified narration, while the
  // same check passed in isolation. This metric keeps the check honest under
  // the same conditions the gauntlet runs everything else.
  log(`[gauntlet:${mode}] intent check`);
  const { apiIntentCheck, claudePIntentCheck } = await import('../interviewer.js');
  const intentCheck = process.env.ANTHROPIC_API_KEY ? apiIntentCheck() : claudePIntentCheck();
  const INTENT_CASES: { text: string; addressed: boolean }[] = [
    { text: "But I'm not really sure where this is being set. Can you give me a hint here?", addressed: true },
    { text: 'Yo, interviewer, uh, can you give me a hand here?', addressed: true },
    { text: 'Can you tell me, um, where I can get started here?', addressed: true },
    { text: 'Is the deadline measured from now or from the original deadline?', addressed: true },
    { text: 'Okay. So, I assume this is a debugging task.', addressed: false },
    { text: "Let's try and figure out where the bug is, um, first.", addressed: false },
    { text: 'Um, so the sweep releases the full count, not the remaining...', addressed: false },
    { text: 'Oh, fuck.', addressed: false },
    { text: "Yeah, that's probably why.", addressed: false },
    { text: 'Hey, there. Um, how are you doing?', addressed: false }, // background speaker
  ];
  let intentOk = 0;
  const intentDetail: string[] = [];
  for (const c of INTENT_CASES) {
    const got = await intentCheck(c.text, FIXTURE_DEBUGGING_PROBLEM.spec);
    if (got === c.addressed) intentOk += 1;
    else intentDetail.push(`"${c.text.slice(0, 50)}": got ${got ? 'addressed' : 'narration'}, expected ${c.addressed ? 'addressed' : 'narration'}`);
  }
  metrics.push({
    metric: 'intent_accuracy',
    score: intentOk / INTENT_CASES.length,
    threshold: 0.9,
    pass: intentOk / INTENT_CASES.length >= 0.9,
    detail: intentDetail,
  });

  // ---- citations, across everything above ----
  const citationScore = citation.total ? citation.kept / citation.total : 1;
  metrics.push({
    metric: 'citation_resolution',
    score: citationScore,
    threshold: THRESHOLDS.citation_resolution,
    pass: citationScore >= THRESHOLDS.citation_resolution,
    detail: [`${citation.kept}/${citation.total} citations resolved to candidate events`],
  });

  const scorecard: Scorecard = {
    ran_at: new Date().toISOString(),
    mode,
    model: modelName,
    prompt_hash: promptHash2,
    metrics,
    citation,
    pass: metrics.every((m) => m.pass),
  };
  writeFileSync(
    path.join(opts.repoRoot, 'fixtures', 'judge', `scorecard-${mode}.json`),
    JSON.stringify(scorecard, null, 2),
  );
  return scorecard;
}

// ---- simulated candidates: LLM-played personas, cached to disk ----

interface SimulatedFixture {
  id: string;
  brief: string;
  problem: PersonaFixture['problem'];
  events: TraceEvent[];
  expected: Partial<Record<DimensionKey, Verdict[]>>;
}

const SIM_BRIEFS: {
  id: string;
  round: 'debugging' | 'dsa';
  brief: string;
  expected: Partial<Record<DimensionKey, Verdict[]>>;
}[] = [
  {
    id: 'sim-anchorer-debugging',
    round: 'debugging',
    brief:
      'You are nervous and think out loud in fragments with disfluencies (um, wait, hmm). You immediately assume the bug is in the hold-creation code because you once saw a similar bug there, and you spend most of the session editing that file WITHOUT reading the failing test diff. You never state a mechanism — only "it feels like the holds are wrong". Late in the session you ask the interviewer one genuine question about whether partial shipments should reduce the released units. You never re-run the tests after your edits.',
    expected: {
      clarify: ['weak', 'adequate'],
      approach: ['weak'],
      verify: ['weak'],
    },
  },
  {
    id: 'sim-recoverer-dsa',
    round: 'dsa',
    brief:
      'You start by diving into code without stating an approach, write a messy nested loop, then CATCH YOURSELF around the middle of the session: you stop, say "wait, this is O(n squared), the large test will blow up", explicitly state the hashmap approach and its O(n) complexity, rewrite, dry-run an example with duplicates out loud, and re-run the suite to green. Your speech is realistic: fragments, self-corrections, mumbling.',
    expected: {
      approach: ['adequate', 'strong'],
      verify: ['strong', 'adequate'],
      communicate: ['strong', 'adequate'],
    },
  },
];

const SIM_EVENT_SCHEMA = `Reply with ONLY a JSON array of events, each:
{"offset_s": <number, seconds from start, increasing>, "action": "say"|"edit"|"open"|"save"|"run_tests_fail"|"run_tests_pass", "text": "<for say: the words, realistic and fragmented>", "path": "<for edit/open/save: a plausible repo path>"}
Rules: 12-30 events; session 4-9 minutes; first event is run_tests_fail near offset 6; end naturally.`;

async function loadOrGenerateSimulated(
  simDir: string,
  opts: GauntletOptions,
  log: (l: string) => void,
): Promise<SimulatedFixture[]> {
  mkdirSync(simDir, { recursive: true });
  const out: SimulatedFixture[] = [];
  for (const brief of SIM_BRIEFS) {
    const file = path.join(simDir, `${brief.id}.json`);
    const problem = (brief.round === 'debugging' ? FIXTURE_DEBUGGING_PROBLEM : FIXTURE_DSA_PROBLEM) as PersonaFixture['problem'];
    if (existsSync(file) && !opts.simulate) {
      const cached = JSON.parse(readFileSync(file, 'utf8')) as { events: TraceEvent[] };
      out.push({ id: brief.id, brief: brief.brief, problem, events: cached.events, expected: brief.expected });
      continue;
    }
    if (!opts.simulate) continue; // no cache and not asked to generate
    log(`[gauntlet] simulating ${brief.id}...`);
    const model = opts.judgeModel ?? (process.env.ANTHROPIC_API_KEY ? apiJudgeModel('claude-sonnet-5') : claudePJudgeModel('sonnet'));
    const prompt = [
      'You are SIMULATING a mock-interview candidate to create test data. Produce a realistic session timeline.',
      `THE PROBLEM THEY ARE WORKING ON:\n${problem.spec}`,
      `THE CANDIDATE YOU ARE PLAYING:\n${brief.brief}`,
      SIM_EVENT_SCHEMA,
    ].join('\n\n');
    const raw = await model(prompt);
    const match = raw.match(/\[[\s\S]*\]/);
    if (!match) {
      log(`[gauntlet] simulation for ${brief.id} produced no JSON — skipped`);
      continue;
    }
    const script = JSON.parse(match[0]) as { offset_s: number; action: string; text?: string; path?: string }[];
    const b = new (await import('./personas.js')).TraceBuilder().start();
    for (const e of script) {
      const at = e.offset_s;
      if (e.action === 'say') b.say(at, e.text ?? '');
      else if (e.action === 'edit') b.edit(at, e.path ?? '/p/src/x.ts');
      else if (e.action === 'open') b.open(at, e.path ?? '/p/src/x.ts');
      else if (e.action === 'save') b.save(at, e.path ?? '/p/src/x.ts');
      else if (e.action === 'run_tests_fail') b.failRun(at);
      else if (e.action === 'run_tests_pass') b.passRun(at);
    }
    const last = script[script.length - 1];
    b.end((last?.offset_s ?? 300) + 10);
    const events = b.build();
    writeFileSync(file, JSON.stringify({ brief: brief.brief, events }, null, 2));
    out.push({ id: brief.id, brief: brief.brief, problem, events, expected: brief.expected });
  }
  return out;
}

// ---- report rendering ----

export function renderScorecard(s: Scorecard): string {
  const lines = [
    `JUDGE GAUNTLET — ${s.mode} — ${s.model} — prompt ${s.prompt_hash ?? '?'}`,
    ''.padEnd(72, '='),
  ];
  for (const m of s.metrics) {
    lines.push(
      `${m.pass ? 'PASS' : 'FAIL'}  ${m.metric.padEnd(26)} ${(m.score * 100).toFixed(1).padStart(6)}%  (need ${(m.threshold * 100).toFixed(0)}%)`,
    );
    for (const d of m.detail.slice(0, 8)) lines.push(`        - ${d}`);
    if (m.detail.length > 8) lines.push(`        ... and ${m.detail.length - 8} more`);
  }
  lines.push(''.padEnd(72, '='));
  lines.push(s.pass ? 'GAUNTLET: PASS' : 'GAUNTLET: FAIL — iterate on the judge prompt and rerun');
  return lines.join('\n');
}
