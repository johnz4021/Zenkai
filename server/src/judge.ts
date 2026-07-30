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
 *  context, never evidence of candidate behavior; sensor/session events are
 *  bookkeeping. */
const CANDIDATE_EVENT_TYPES = new Set(['utterance', 'edit', 'file_save', 'file_open', 'command', 'test_run']);

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

export function apiJudgeModel(model = 'claude-sonnet-5'): JudgeModel {
  return async (prompt) => {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({ timeout: JUDGE_TIMEOUT_MS });
    const msg = await client.messages.create({
      model,
      // Live smoke finding: 2000 intermittently truncated the JSON mid-object
      // (six analyses plus summary), and a truncated object parses as "no
      // JSON" → UNASSESSED. 4000 leaves generous headroom.
      max_tokens: 4_000,
      messages: [{ role: 'user', content: prompt }],
    });
    if (msg.stop_reason === 'max_tokens') {
      throw new Error('judge output truncated at max_tokens');
    }
    return msg.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as { text: string }).text)
      .join('');
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

  const unassessed = (reason: string): Unassessed => ({
    session_id: opts.sessionId,
    status: 'unassessed',
    judged_at: now(),
    reason,
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
    return unassessed(`judge output invalid (not retried — schema mismatch repeats): ${String(e).slice(0, 200)}`);
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
