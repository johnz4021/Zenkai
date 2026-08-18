/**
 * Session judge — the feedback system (CEO review 2026-07-30).
 *
 *   timeline + dimensions + expectations + planted bug
 *        │
 *        ▼
 *   judge (injectable; API sonnet or claude -p fallback)
 *        │  per-dimension { verdict, analysis, evidence offsets }
 *        ▼
 *   validate schema ──► verify citations ──► versioned Assessment
 *
 * Postures locked in review:
 *  - The judge is BLIND to the gap graph. Showing it prior gaps would make
 *    the graph self-confirming — a judge told "he goes quiet" finds him
 *    going quiet.
 *  - The judge KNOWS the planted bug (secrecy governs the live round only);
 *    whether the CARD discloses it is a separate rendering decision.
 *  - The judge never writes quotes; the renderer pulls verbatim text from
 *    the trace via citations. Citations are verified: the cited moment must
 *    EXIST (±2s) and be CANDIDATE-attributable — in a transcript holding
 *    both speakers, the likely failure is attribution, not fabrication.
 *  - Failure is never a verdict. Timeout → one retry → UNASSESSED. Parse
 *    failure → UNASSESSED immediately (schema mismatch repeats; retrying
 *    wastes money). Nothing is written to the gap graph. The forbidden
 *    fallback: anything that renders a network blip as "failed every
 *    dimension".
 *  - Every assessment is version-stamped (prompt hash, schema, model,
 *    renderer) so `rejudge` keeps history comparable.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { DimensionKey, GeneratedProblem, TraceEvent, Verdict } from '@interview-prep/shared';
import {
  DIMENSIONS,
  DIMENSION_DEFS,
  isDimensionKey,
  isVerdict,
  resolveExpectations,
  resolveRoundSpec,
} from '@interview-prep/shared';
import { RENDERER_VERSION, eventAtOffset, isPhantomUtterance, renderTimeline, sensorDownIntervals } from './timeline.js';

export const SCHEMA_VERSION = 1;

// ---- output shapes ----

export interface DimensionAssessment {
  dimension: DimensionKey;
  verdict: Verdict;
  analysis: string;
  /** Offsets (seconds from session start) into the timeline. */
  evidence: number[];
  /** Citations removed by the verifier (did not resolve / wrong speaker). */
  stripped_evidence?: number[];
  /** True when every citation was stripped — verdict stands but renders
   *  differently (a claim without a receipt is labeled as such). */
  evidence_stripped?: boolean;
}

export interface Assessment {
  session_id: string;
  status: 'assessed';
  judged_at: number;
  model: string;
  prompt_hash: string;
  schema_version: number;
  renderer_version: number;
  /** The expectations the judge actually applied (resolved, not the manifest). */
  expectations_used: Record<DimensionKey, string>;
  solved: boolean;
  summary: string;
  dimensions: DimensionAssessment[];
}

export interface Unassessed {
  session_id: string;
  status: 'unassessed';
  judged_at: number;
  reason: string;
  /** What the judge actually said, when it said something we could not use.
   *  Present only on parse/schema failures — the evidence needed to fix the
   *  prompt or the schema without re-running a session that already ended. */
  raw_output?: string;
}

export type JudgeResult = Assessment | Unassessed;

/** Talk-dimension honesty on solo rounds (owner decision 2026-08-15): with no
 *  interviewer and zero utterances in the trace, communicate and reflect have
 *  no evidence class at all — narration is the only thing they measure, and
 *  solo rounds have no wrap-up. A verdict there is fabrication by
 *  construction, and a fabricated 'weak' would write a gap the round could
 *  not exhibit, steering future generation at a phantom. Mechanical, runs in
 *  finalize BEFORE any write — same "no model output reaches state ungated"
 *  rule as every other gate. clarify/approach stay judge-graded: they have
 *  non-verbal evidence (which files were read before the first edit). */
const VERBAL_ONLY_DIMENSIONS: readonly DimensionKey[] = ['communicate', 'reflect'];
/** Panes-solo adds these: with no interviewer AND no IDE, the only "evidence"
 *  for clarify/approach is tab-switching — grading them is fabrication with
 *  extra steps, and a fabricated 'weak' pollutes the memory that targets
 *  future generation (owner decision 2026-08-16: the judge's reach equals
 *  the trace's evidence). Solo IDE rounds keep them: file navigation and
 *  terminal activity are real signal. */
const PANES_BLIND_DIMENSIONS: readonly DimensionKey[] = ['clarify', 'approach'];
export function clampSilentDimensions(
  result: JudgeResult,
  opts: { hasInterviewer: boolean; utteranceCount: number; surface?: 'ide' | 'panes' },
): JudgeResult {
  if (result.status !== 'assessed') return result;
  if (opts.hasInterviewer || opts.utteranceCount > 0) return result;
  const clamped: readonly DimensionKey[] =
    opts.surface === 'panes'
      ? [...VERBAL_ONLY_DIMENSIONS, ...PANES_BLIND_DIMENSIONS]
      : VERBAL_ONLY_DIMENSIONS;
  return {
    ...result,
    dimensions: result.dimensions.map((d) =>
      clamped.includes(d.dimension) && d.verdict !== 'unassessable'
        ? {
            ...d,
            verdict: 'unassessable',
            analysis: 'Not observable on a solo round — nobody was listening.',
            evidence: [],
          }
        : d,
    ),
  };
}

// ---- injectable judge ----

export interface JudgeInput {
  timeline: string;
  spec: string;
  bug: string;
  expectations: Record<DimensionKey, string>;
}

/** Raw model call: returns the model's text or throws JudgeCallError. */
export type JudgeModel = (prompt: string) => Promise<string>;

export class JudgeTimeoutError extends Error {}

// ---- prompt assembly ----

function dimensionAnchorsText(): string {
  return DIMENSIONS.map((k) => {
    const d = DIMENSION_DEFS[k];
    return [
      `### ${k} — ${d.question}`,
      `strong: ${d.strong}`,
      `weak: ${d.weak}`,
      `unassessable when: ${d.unassessable_when}`,
    ].join('\n');
  }).join('\n\n');
}

export function buildJudgePrompt(template: string, input: JudgeInput): string {
  const expectations = DIMENSIONS.map((k) => `- ${k}: ${input.expectations[k]}`).join('\n');
  const values: Record<string, string> = {
    SPEC: input.spec,
    BUG: input.bug,
    DIMENSION_ANCHORS: dimensionAnchorsText(),
    EXPECTATIONS: expectations,
    TIMELINE: input.timeline,
  };
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (whole, key: string) =>
    key in values ? (values[key] as string) : whole,
  );
}

export function promptHash(template: string): string {
  // Anchors are part of the effective prompt; hash them together so a
  // dimensions.ts anchor change also invalidates comparability.
  return createHash('sha256').update(template).update(dimensionAnchorsText()).digest('hex').slice(0, 12);
}

// ---- output parsing + validation ----

/** Parse and validate the model's reply. Throws on any schema violation —
 *  the caller maps that to UNASSESSED (never a fabricated verdict). */
/** First balanced JSON array in a string, string-literal aware — the
 *  greedy-regex approach breaks the moment trailing junk contains a `]`. */
function firstBalancedArray(s: string): string | null {
  const start = s.indexOf('[');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '[') depth++;
    else if (c === ']' && --depth === 0) return s.slice(start, i + 1);
  }
  return null;
}

/** The trace's own verdict on `solved`, when a run exists to carry one —
 *  the graded submit run when present, else the last run of any kind.
 *  Counts win when parseRunCounts landed them on the payload (untyped
 *  spread — same cast as groundTruth and the timeline); a bare clean exit
 *  is the fallback. `undefined` when nothing ever ran (review/no-run
 *  rounds — nothing mechanical to stand on). */
export function runSolvedFromTrace(events: TraceEvent[]): boolean | undefined {
  const runs = events.filter((e) => e.type === 'test_run');
  const last =
    [...runs].reverse().find((e) => (e.payload as { via?: string })?.via === 'submit') ??
    runs.at(-1);
  if (!last) return undefined;
  const p = last.payload as { passed?: number; total?: number; exit_code?: number | null };
  if (typeof p.passed === 'number' && typeof p.total === 'number') {
    return p.total > 0 && p.passed === p.total;
  }
  return p.exit_code === 0;
}

export function parseAssessmentOutput(
  raw: string,
  /** Evidence-scoped solved (owner decision 2026-08-16, TODOS #-984 class):
   *  `fallback` fills a missing/invalid model field from the trace —
   *  sess-1786901438316's judge wrote full analysis but dodged `solved` on a
   *  partial 12/36 multi-part result, and the schema-strict throw turned a
   *  machine-known score into an unassessed card. `override` (one-shot
   *  rounds) makes the graded run authoritative regardless of what the
   *  model said: the run IS the bar, and a model opinion on a machine-known
   *  fact is a fabrication surface. */
  solvedOpts?: { fallback?: boolean; override?: boolean },
): {
  solved: boolean;
  summary: string;
  dimensions: { dimension: DimensionKey; verdict: Verdict; analysis: string; evidence: number[] }[];
} {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('no JSON object in judge output');
  const o = JSON.parse(match[0]) as {
    solved?: unknown;
    summary?: unknown;
    dimensions?: unknown;
  };
  // Serialization drift, seen live TWICE through a forced tool call — the
  // API guides but does not hard-enforce the input schema:
  //   1. dimensions arrived as a stringified array with a stray `}` after it;
  //   2. the ENTIRE assessment arrived inside the dimensions string —
  //      `"dimensions": "[...],\"solved\":true,\"summary\":\"...\""` with the
  //      top level otherwise empty (sess-1785962737985: a complete, correct
  //      assessment destroyed by shape alone).
  // Normalize before validating: pull the balanced array out of the string,
  // then recover solved/summary from the string's remainder when the top
  // level lacks them.
  if (typeof o.dimensions === 'string') {
    const packed = o.dimensions;
    const arr = firstBalancedArray(packed);
    if (!arr) throw new Error('dimensions is a string with no array inside');
    o.dimensions = JSON.parse(arr) as unknown;
    const rest = packed.slice(packed.indexOf(arr) + arr.length);
    if (typeof o.solved !== 'boolean') {
      const solved = rest.match(/"solved"\s*:\s*(true|false)/);
      if (solved) o.solved = solved[1] === 'true';
    }
    if (typeof o.summary !== 'string') {
      const summary = rest.match(/"summary"\s*:\s*("(?:[^"\\]|\\.)*")/);
      if (summary) o.summary = JSON.parse(summary[1]!) as string;
    }
  }
  if (solvedOpts?.override !== undefined) o.solved = solvedOpts.override;
  else if (typeof o.solved !== 'boolean' && solvedOpts?.fallback !== undefined) o.solved = solvedOpts.fallback;
  if (typeof o.solved !== 'boolean') throw new Error('missing/invalid solved');
  if (typeof o.summary !== 'string') throw new Error('missing/invalid summary');
  if (!Array.isArray(o.dimensions)) throw new Error('missing dimensions array');

  // The claude -p transport sometimes glues tool-call scaffolding onto the
  // end of string fields — QA 2026-08-14 found "</summary>\n</invoke>"
  // persisted verbatim across six stored assessments and into the rendered
  // feedback card. Prose never legitimately ends with a closing tag.
  const stripScaffolding = (s: string) => s.replace(/(\s*<\/[a-z_]+>\s*)+$/gi, '').trim();

  const seen = new Set<string>();
  const dims = o.dimensions.map((d) => {
    const dim = d as { dimension?: unknown; verdict?: unknown; analysis?: unknown; evidence?: unknown };
    if (typeof dim.dimension !== 'string' || !isDimensionKey(dim.dimension))
      throw new Error(`unknown dimension: ${String(dim.dimension)}`);
    if (typeof dim.verdict !== 'string' || !isVerdict(dim.verdict))
      throw new Error(`unknown verdict for ${dim.dimension}: ${String(dim.verdict)}`);
    if (typeof dim.analysis !== 'string' || dim.analysis.trim().length === 0)
      throw new Error(`empty analysis for ${dim.dimension}`);
    const evidence = Array.isArray(dim.evidence)
      ? dim.evidence.filter((e): e is number => typeof e === 'number' && Number.isFinite(e))
      : [];
    seen.add(dim.dimension);
    return { dimension: dim.dimension, verdict: dim.verdict, analysis: stripScaffolding(dim.analysis), evidence };
  });
  for (const k of DIMENSIONS) {
    if (!seen.has(k)) throw new Error(`missing dimension: ${k}`);
  }
  return { solved: o.solved, summary: stripScaffolding(o.summary), dimensions: dims };
}

// ---- citation verification ----

/** Event types that are the CANDIDATE acting. An interviewer turn is
 *  context, never evidence of candidate behavior; sensors and session_start
 *  are bookkeeping. session_end IS a candidate act (they clicked End
 *  Session) — the gauntlet showed judges legitimately cite it as evidence
 *  of absence: "ended without ever re-running the tests". */
const CANDIDATE_EVENT_TYPES = new Set(['utterance', 'edit', 'file_save', 'file_open', 'command', 'test_run', 'session_end']);

export function isCandidateEvent(e: TraceEvent): boolean {
  return CANDIDATE_EVENT_TYPES.has(e.type);
}

/**
 * Verify every citation: resolves within ±2s AND lands on a candidate
 * event. Stripped citations are kept in stripped_evidence for the
 * observability counter; a dimension left with zero surviving citations
 * keeps its verdict but is flagged (rendered as claim-without-receipt).
 * Unassessable verdicts need no evidence by definition.
 */
export function verifyCitations(
  dims: { dimension: DimensionKey; verdict: Verdict; analysis: string; evidence: number[] }[],
  events: TraceEvent[],
): DimensionAssessment[] {
  // Phantom empties are excluded from resolution for the same reason sensor
  // events are: the judge never saw them (renderTimeline drops them), so one
  // sitting 0.1s nearer than the cited real utterance must not absorb — or
  // strip — the citation.
  const sttDown = sensorDownIntervals(events, 'stt');
  const citable = (e: TraceEvent) => isCandidateEvent(e) && !isPhantomUtterance(e, sttDown);
  return dims.map((d) => {
    if (d.verdict === 'unassessable') {
      return { ...d, evidence: [] };
    }
    const kept: number[] = [];
    const stripped: number[] = [];
    for (const offset of d.evidence) {
      // Resolve against candidate events ONLY: a bookkeeping event landing
      // nearer must not disqualify an honest citation, and an interviewer
      // line must never satisfy one.
      const ev = eventAtOffset(events, offset, 2_000, citable);
      if (ev) kept.push(offset);
      else stripped.push(offset);
    }
    const out: DimensionAssessment = { ...d, evidence: kept };
    if (stripped.length > 0) out.stripped_evidence = stripped;
    if (kept.length === 0) out.evidence_stripped = true;
    return out;
  });
}

// ---- model implementations (same auth pattern as interviewer.ts) ----

const JUDGE_TIMEOUT_MS = 120_000;

function runClaudeP(prompt: string, model: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn('claude', ['-p', prompt, '--output-format', 'text', '--model', model], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.on('data', (d) => (stdout += d));
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new JudgeTimeoutError('claude -p judge timed out'));
    }, JUDGE_TIMEOUT_MS);
    child.on('close', () => {
      clearTimeout(timer);
      resolve(stdout);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

export function claudePJudgeModel(model = 'sonnet'): JudgeModel {
  return (prompt) => runClaudeP(prompt, model);
}

/**
 * A well-formed assessment is ~1300 tokens: six analyses of 2-4 sentences,
 * a summary, and short evidence arrays. The ceiling only binds when the judge
 * goes off-script — which it does when the inputs contradict each other (a
 * mis-wired session once handed it a Python timeline and a TypeScript spec,
 * and it spent the whole budget narrating the mismatch).
 *
 * 8000 is ~6x a normal answer. The retry exists because truncation costs an
 * entire session's feedback, which is far more expensive than one extra call:
 * a second attempt at triple the ceiling either lands or proves the input is
 * genuinely pathological.
 */
const JUDGE_MAX_TOKENS = 8_000;

/**
 * The assessment schema, expressed as a tool the judge must call.
 *
 * Asking prose-mode for "ONLY a JSON object" cost two real sessions: one to a
 * truncated object, one to a syntax error 430 characters in. Both are the same
 * defect — hand-serialized JSON is the model's problem to get right, and a
 * single stray quote inside an analysis sentence destroys a whole round of
 * feedback. Forcing a tool call moves serialization into the API, so malformed
 * JSON stops being a failure mode we can experience at all.
 *
 * parseAssessmentOutput still runs on the result: this guarantees SHAPE, not
 * that every dimension is present and every verdict is legal.
 */
const ASSESSMENT_TOOL = {
  name: 'record_assessment',
  description: 'Record the assessment of this interview session.',
  input_schema: {
    type: 'object' as const,
    properties: {
      solved: { type: 'boolean', description: 'Did the candidate solve the round — bug rounds: fixed the planted bug; build rounds: the final graded run passed. Multi-part sets: every part green = true, anything partial = false. Always emit; a partial result is false, never an omission.' },
      summary: { type: 'string', description: "2-3 sentences: the session's shape in plain language." },
      dimensions: {
        type: 'array',
        description: 'Exactly one entry per dimension, in order.',
        items: {
          type: 'object',
          properties: {
            dimension: { type: 'string', enum: [...DIMENSIONS] },
            verdict: { type: 'string', enum: ['strong', 'adequate', 'weak', 'unassessable'] },
            analysis: { type: 'string', description: '2-4 sentences, specific to what THEY did, in your words. For unassessable: why.' },
            evidence: { type: 'array', items: { type: 'number' }, description: 'Offsets in seconds from session start.' },
          },
          required: ['dimension', 'verdict', 'analysis', 'evidence'],
        },
      },
    },
    required: ['solved', 'summary', 'dimensions'],
  },
};

export function apiJudgeModel(model = 'claude-sonnet-5'): JudgeModel {
  return async (prompt) => {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({ timeout: JUDGE_TIMEOUT_MS });
    const call = async (maxTokens: number) => {
      const msg = await client.messages.create({
        model,
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: prompt }],
        tools: [ASSESSMENT_TOOL],
        tool_choice: { type: 'tool', name: ASSESSMENT_TOOL.name },
      });
      const call = msg.content.find(
        (b): b is Extract<typeof b, { type: 'tool_use' }> => b.type === 'tool_use',
      );
      return {
        truncated: msg.stop_reason === 'max_tokens',
        // Re-serializing an object the API already validated cannot produce
        // malformed JSON; parseAssessmentOutput then checks the semantics.
        text: call ? JSON.stringify(call.input) : '',
      };
    };
    let res = await call(JUDGE_MAX_TOKENS);
    if (res.truncated) {
      console.warn(
        `[judge] output truncated at ${JUDGE_MAX_TOKENS} tokens — retrying at ${JUDGE_MAX_TOKENS * 3}`,
      );
      res = await call(JUDGE_MAX_TOKENS * 3);
    }
    if (res.truncated) {
      throw new Error(`judge output truncated at ${JUDGE_MAX_TOKENS * 3} max_tokens`);
    }
    // A degenerate emission ({"params":{}}, {}) is a stochastic scaffolding
    // failure, not the deterministic schema mismatch the no-retry rule was
    // written for — QA 2026-08-14 saw it void a whole round with no
    // recovery. One retry, same precedent as truncation.
    const degenerate = (t: string) => {
      try {
        const o = JSON.parse(t) as Record<string, unknown> | null;
        return !o || typeof o !== 'object' || !('dimensions' in o);
      } catch {
        return true;
      }
    };
    if (res.text && degenerate(res.text)) {
      console.warn('[judge] degenerate tool input (no dimensions) — one retry');
      res = await call(JUDGE_MAX_TOKENS);
    }
    if (!res.text) throw new Error('judge returned no tool call');
    return res.text;
  };
}

export function pickJudgeModel(): { model: JudgeModel; name: string } {
  return process.env.ANTHROPIC_API_KEY
    ? { model: apiJudgeModel(), name: 'claude-sonnet-5 (api)' }
    : { model: claudePJudgeModel(), name: 'sonnet (claude -p)' };
}

// ---- the full judging pipeline ----

export interface JudgeSessionOptions {
  sessionId: string;
  events: TraceEvent[];
  problem: Pick<GeneratedProblem, 'round_type' | 'spec' | 'planted_bug' | 'rubric'> &
    Partial<Pick<GeneratedProblem, 'round_spec'>>;
  templatePath: string;
  /** Host path of the round's problem dir. When set, review-shaped rounds
   *  (check.kind 'diff_present' / can_run_tests false — or any round where
   *  nothing was graded) get their written deliverable read from here and
   *  appended to the ground truth — see deliverableText. */
  problemDir?: string;
  /** Injectable; tests and the gauntlet pass fakes/instrumented models. */
  judgeModel?: JudgeModel;
  modelName?: string;
  now?: () => number;
}

/**
 * The written deliverable of a round that has nothing runnable to grade —
 * review_diff rounds, whose entire graded artifact is the candidate's
 * write-up (the generated round's own copy: "It is the entire artifact that
 * gets read"). QA 2026-08-14 (sess-1786722081844): a correct, correctly-
 * ranked review was graded weak on every dimension because the judge only
 * ever saw the timeline — the write-up itself was invisible to grading.
 * REVIEW.md is the generation convention; any .md the candidate saved
 * during the session is included as well in case a round names it
 * differently. Exported for tests.
 */
export function deliverableText(problemDir: string, events: TraceEvent[]): string {
  const candidates = new Set<string>(['REVIEW.md']);
  for (const e of events) {
    if (e.type === 'file_save' || e.type === 'edit') {
      const p = String((e.payload as { path?: unknown })?.path ?? '');
      if (p.toLowerCase().endsWith('.md')) candidates.add(p.replace(/^\/+/, ''));
    }
  }
  const parts: string[] = [];
  for (const rel of candidates) {
    try {
      const txt = readFileSync(path.join(problemDir, rel), 'utf8').trim();
      if (txt) parts.push(`--- ${rel} ---\n${txt.slice(0, 12_000)}`);
    } catch {
      /* file not present — nothing submitted under that name */
    }
  }
  return parts.join('\n\n');
}

/**
 * The {{BUG}} slot's content — the round's ground truth, per shape. Pure;
 * exported for tests. A debugging round's truth is the planted bug; a build
 * round's truth is the final graded run, WITH counts when the emitter
 * parsed them (renderer v3) — before this, build rounds got a bare "(no
 * planted bug)" sentinel and the judge was asked whether a nonexistent bug
 * was fixed.
 */
export function groundTruth(
  problem: Pick<GeneratedProblem, 'planted_bug'>,
  events: TraceEvent[],
): string {
  if (problem.planted_bug) {
    return (
      `File: ${problem.planted_bug.file} (line ${problem.planted_bug.line})\n` +
      `${problem.planted_bug.description}\n` +
      `It breaks exactly one test: "${problem.planted_bug.failing_test}".`
    );
  }
  const runs = events.filter((e) => e.type === 'test_run');
  const last = [...runs].reverse().find((e) => (e.payload as { via?: string })?.via === 'submit') ?? runs.at(-1);
  if (!last) return '(no planted bug — build round) No test run occurred; the work was never graded.';
  const p = (last.payload ?? {}) as { exit_code?: unknown; passed?: unknown; total?: unknown; via?: unknown };
  const counts = typeof p.passed === 'number' && typeof p.total === 'number' ? ` ${p.passed}/${p.total} tests passed;` : '';
  const verb = p.via === 'submit' ? 'Final graded run (at submit)' : 'Last test run';
  return `(no planted bug — build round) ${verb}:${counts} exit code ${String(p.exit_code)}${p.exit_code === 0 ? ' (suite green)' : ' (suite NOT green)'}.`;
}

export async function judgeSession(opts: JudgeSessionOptions): Promise<JudgeResult> {
  const now = opts.now ?? Date.now;
  const template = readFileSync(opts.templatePath, 'utf8');
  const picked = opts.judgeModel
    ? { model: opts.judgeModel, name: opts.modelName ?? 'injected' }
    : pickJudgeModel();

  const expectations = resolveExpectations(opts.problem.round_type, opts.problem.rubric?.dimensions);
  let bug = groundTruth(opts.problem, opts.events);
  // Review-shaped rounds: the written deliverable IS the ground truth's
  // other half. Dispatch on the CLOSED vocabulary (check.kind), never on
  // trace shape — QA 2026-08-14 verification caught the first cut of this
  // gate ("no planted bug and no test_run") never firing on a single real
  // review round: the generator DOES plant bugs in the diff under review
  // (rep-mst39p35 carries planted_bug api.py:77 alongside
  // check.kind:'diff_present'), so the round it was written for excluded
  // itself. RoundSpec is the ruler the judge dispatches on; a round that
  // cannot run tests has nothing else to be graded on.
  const spec = (() => {
    try {
      return resolveRoundSpec(opts.problem);
    } catch {
      return null; // legacy manifest — fall back to the trace-shape test below
    }
  })();
  const reviewShaped =
    spec?.check.kind === 'diff_present' || spec?.capabilities.can_run_tests === false;
  const nothingGraded =
    !opts.problem.planted_bug && !opts.events.some((e) => e.type === 'test_run');
  if (opts.problemDir && (reviewShaped || nothingGraded)) {
    const deliverable = deliverableText(opts.problemDir, opts.events);
    if (deliverable) {
      bug += `\n\nThe candidate's submitted written deliverable, verbatim:\n${deliverable}`;
    }
  }

  const prompt = buildJudgePrompt(template, {
    timeline: renderTimeline(opts.events),
    spec: opts.problem.spec,
    bug,
    expectations,
  });

  // The raw output goes into the record on failure. Without it, diagnosing a
  // malformed assessment means reproducing a nondeterministic model call
  // against a session that already ended — we lost two rounds that way.
  const unassessed = (reason: string, raw?: string): Unassessed => ({
    session_id: opts.sessionId,
    status: 'unassessed',
    judged_at: now(),
    reason,
    ...(raw ? { raw_output: raw.slice(0, 20_000) } : {}),
  });

  let raw: string;
  try {
    raw = await picked.model(prompt);
  } catch (e) {
    if (e instanceof JudgeTimeoutError) {
      // Timeouts are transient — one retry. Parse failures never retry
      // (schema mismatch repeats identically at full cost).
      try {
        raw = await picked.model(prompt);
      } catch (e2) {
        return unassessed(`judge timed out twice: ${String(e2).slice(0, 200)}`);
      }
    } else {
      return unassessed(`judge call failed: ${String(e).slice(0, 200)}`);
    }
  }

  // The authority ladder for `solved` (evidence-scoped judging, 2026-08-16):
  // on one-shot rounds the graded submit run IS the bar, so the trace
  // overrides whatever the model says; everywhere else the trace only fills
  // an omitted field. No run at all → the strict schema contract stands.
  const runSolved = runSolvedFromTrace(opts.events);
  const solvedOpts =
    runSolved === undefined
      ? undefined
      : spec?.capabilities.submit === 'one_shot'
        ? { override: runSolved }
        : { fallback: runSolved };

  let parsed: ReturnType<typeof parseAssessmentOutput>;
  try {
    parsed = parseAssessmentOutput(raw, solvedOpts);
  } catch (e) {
    // Two different failures hide here (learned from the gauntlet):
    //  - JSON SYNTAX slop (an unescaped quote) is STOCHASTIC — a rerun at
    //    temperature usually formats fine. Retry once.
    //  - SCHEMA violations (missing dimension, unknown verdict) are prompt
    //    bugs and repeat identically. Never retry those.
    if (e instanceof SyntaxError) {
      let retryRaw = '';
      try {
        retryRaw = await picked.model(prompt);
        parsed = parseAssessmentOutput(retryRaw, solvedOpts);
      } catch (e2) {
        return unassessed(`judge output unparseable twice: ${String(e2).slice(0, 200)}`, retryRaw || raw);
      }
    } else {
      return unassessed(
        `judge output invalid (not retried — schema mismatch repeats): ${String(e).slice(0, 200)}`,
        raw,
      );
    }
  }

  return {
    session_id: opts.sessionId,
    status: 'assessed',
    judged_at: now(),
    model: picked.name,
    prompt_hash: promptHash(template),
    schema_version: SCHEMA_VERSION,
    renderer_version: RENDERER_VERSION,
    expectations_used: expectations,
    solved: parsed.solved,
    summary: parsed.summary,
    dimensions: verifyCitations(parsed.dimensions, opts.events),
  };
}
