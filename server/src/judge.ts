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
import { spawn } from 'node:child_process';
import type { DimensionKey, GeneratedProblem, TraceEvent, Verdict } from '@interview-prep/shared';
import { DIMENSIONS, DIMENSION_DEFS, isDimensionKey, isVerdict, resolveExpectations } from '@interview-prep/shared';
import { RENDERER_VERSION, eventAtOffset, renderTimeline } from './timeline.js';

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

export function parseAssessmentOutput(raw: string): {
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
  if (typeof o.solved !== 'boolean') throw new Error('missing/invalid solved');
  if (typeof o.summary !== 'string') throw new Error('missing/invalid summary');
  if (!Array.isArray(o.dimensions)) throw new Error('missing dimensions array');

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
    return { dimension: dim.dimension, verdict: dim.verdict, analysis: dim.analysis.trim(), evidence };
  });
  for (const k of DIMENSIONS) {
    if (!seen.has(k)) throw new Error(`missing dimension: ${k}`);
  }
  return { solved: o.solved, summary: o.summary.trim(), dimensions: dims };
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
      const ev = eventAtOffset(events, offset, 2_000, isCandidateEvent);
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
      solved: { type: 'boolean', description: 'Did the candidate fix the planted bug?' },
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
  problem: Pick<GeneratedProblem, 'round_type' | 'spec' | 'planted_bug' | 'rubric'>;
  templatePath: string;
  /** Injectable; tests and the gauntlet pass fakes/instrumented models. */
  judgeModel?: JudgeModel;
  modelName?: string;
  now?: () => number;
}

export async function judgeSession(opts: JudgeSessionOptions): Promise<JudgeResult> {
  const now = opts.now ?? Date.now;
  const template = readFileSync(opts.templatePath, 'utf8');
  const picked = opts.judgeModel
    ? { model: opts.judgeModel, name: opts.modelName ?? 'injected' }
    : pickJudgeModel();

  const expectations = resolveExpectations(opts.problem.round_type, opts.problem.rubric?.dimensions);
  const bug = opts.problem.planted_bug
    ? `File: ${opts.problem.planted_bug.file} (line ${opts.problem.planted_bug.line})\n` +
      `${opts.problem.planted_bug.description}\n` +
      `It breaks exactly one test: "${opts.problem.planted_bug.failing_test}".`
    : '(no planted bug for this round type)';

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

  let parsed: ReturnType<typeof parseAssessmentOutput>;
  try {
    parsed = parseAssessmentOutput(raw);
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
        parsed = parseAssessmentOutput(retryRaw);
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
