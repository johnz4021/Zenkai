/**
 * Intake reasoner — the step between the description and the spec confirm.
 *
 * This module is ONE reasoning call (not an agent — no loop, no tools):
 * it reads the description and the pasted context, and returns
 *
 *   questions[]   0-3 structured clarifications, options + recommendation
 *   drafts[]      1+ round specs — one description MAY be several rounds
 *                 (an OA and a live onsite are two specs, one queue)
 *
 * Discipline rules, enforced by gate + prompt:
 *   - ZERO questions is the common case. Ask only when the answer changes
 *     the specs; rich, consistent input goes straight to confirm.
 *   - Always emit best-guess drafts, even while asking.
 *   - One answer round-trip maximum: with answers present, finalize.
 *   - Every draft passes the same vocabulary gate as single-spec inference
 *     (draftToSpec → validateRoundSpec, tags derived in code).
 */

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { draftToSpec, type DraftToolOutput, type SpecDraft } from './intake.js';

export interface ClarifyQuestion {
  id: string;
  question: string;
  options: { label: string; detail?: string }[];
  /** Label of the recommended option, when the model has one. */
  recommended?: string;
  /** One sentence: why this changes the plan. */
  why: string;
}

export interface ClarifyResult {
  questions: ClarifyQuestion[];
  drafts: SpecDraft[];
}

export type IntakeClarifier = (input: {
  description: string;
  context: string;
  answers?: { question: string; answer: string }[];
}) => Promise<ClarifyResult>;

/** Shared with the adapt reasoner — one vocabulary, two prompts. */
export const ROUND_FIELDS = {
  id: { type: 'string' },
  label: { type: 'string' },
  interviewer: { type: 'boolean' },
  can_run_tests: { type: 'boolean' },
  time_limit_minutes: { type: ['number', 'null'] },
  starts_from: { type: 'string', enum: ['repo', 'blank', 'diff'] },
  submit: { type: 'string', enum: ['iterate', 'one_shot'] },
  surface: { type: 'string', enum: ['ide', 'panes'] },
  check_kind: { type: 'string', enum: ['one_failing_test', 'all_failing', 'all_passing', 'diff_present'] },
  emphasis: { type: 'string' },
  rationale: { type: 'string' },
  unsupported: { type: 'string' },
};

const CLARIFY_TOOL = {
  name: 'clarify_intake',
  description: 'Return clarifying questions (0-3) and best-guess round drafts (1+).',
  input_schema: {
    type: 'object' as const,
    properties: {
      questions: {
        type: 'array',
        description: 'AT MOST 3. Empty when the input is rich and consistent — the common case.',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'kebab-case slug' },
            question: { type: 'string', description: 'One sentence, concrete.' },
            options: {
              type: 'array',
              items: {
                type: 'object',
                properties: { label: { type: 'string' }, detail: { type: 'string' } },
                required: ['label'],
              },
            },
            recommended: { type: 'string', description: 'Label of the recommended option, or empty.' },
            why: { type: 'string', description: 'One sentence: what changes based on the answer.' },
          },
          required: ['id', 'question', 'options', 'why'],
        },
      },
      rounds: {
        type: 'array',
        description: 'AT LEAST 1 — best-guess drafts even while questions are open. One entry PER DISTINCT ROUND the candidate faces.',
        items: {
          type: 'object',
          properties: ROUND_FIELDS,
          required: ['id', 'label', 'interviewer', 'can_run_tests', 'time_limit_minutes', 'starts_from', 'submit', 'check_kind', 'rationale', 'unsupported'],
        },
      },
    },
    required: ['questions', 'rounds'],
  },
};

/** Nested-array normalization (the judge's stringified-field lesson: the
 *  API validates only the top level of a tool schema). */
export function coerceArray(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') {
    const m = v.match(/\[[\s\S]*\]/);
    if (m) return JSON.parse(m[0]) as unknown[];
  }
  throw new Error('clarify: expected an array');
}

/**
 * Mechanical gate. Throws with the reason; the caller falls back to the
 * plain single-spec path rather than showing broken questions.
 */
export function gateClarify(raw: unknown): ClarifyResult {
  const o = raw as { questions?: unknown; rounds?: unknown };
  const questions = coerceArray(o.questions ?? []).map((q) => {
    const x = q as Partial<ClarifyQuestion>;
    if (!x.question?.trim()) throw new Error('clarify: empty question');
    const options = coerceArray(x.options ?? []).map((op) => {
      const y = op as { label?: string; detail?: string };
      if (!y.label?.trim()) throw new Error('clarify: option without label');
      return { label: y.label.trim(), ...(y.detail?.trim() ? { detail: y.detail.trim() } : {}) };
    });
    if (options.length < 2 || options.length > 4) {
      throw new Error(`clarify: "${x.question}" has ${options.length} options (need 2-4)`);
    }
    if (!x.why?.trim()) throw new Error('clarify: question without a why');
    return {
      id: (x.id ?? '').trim() || x.question.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 32),
      question: x.question.trim(),
      options,
      ...(x.recommended?.trim() ? { recommended: x.recommended.trim() } : {}),
      why: x.why.trim(),
    };
  });
  if (questions.length > 3) throw new Error(`clarify: ${questions.length} questions (max 3)`);

  const rounds = coerceArray(o.rounds ?? []);
  if (rounds.length === 0) throw new Error('clarify: no rounds — best-guess drafts are mandatory');
  if (rounds.length > 4) throw new Error(`clarify: ${rounds.length} rounds (max 4)`);
  // Each draft passes the same vocabulary gate as single-spec inference —
  // but one incoherent draft must not sink its coherent siblings. A live
  // learning-round intake emitted [good draft, can_run_tests=false +
  // all_passing], the whole result was discarded, and the flow fell back
  // to single-spec inference, losing the questions AND the good draft.
  const drafts: SpecDraft[] = [];
  const dropped: string[] = [];
  for (const r of rounds) {
    try {
      drafts.push(draftToSpec(r as DraftToolOutput));
    } catch (e) {
      dropped.push(String(e).slice(0, 120));
    }
  }
  if (drafts.length === 0) {
    throw new Error(`clarify: every draft failed the gate: ${dropped.join(' | ')}`);
  }
  if (dropped.length > 0) console.warn(`[clarify] dropped ${dropped.length} incoherent draft(s): ${dropped.join(' | ')}`);
  // Distinct ids — round-robin scheduling keys on spec id.
  const ids = new Set(drafts.map((d) => d.spec.id));
  if (ids.size !== drafts.length) throw new Error('clarify: duplicate round ids');
  return { questions, drafts };
}

function buildPrompt(
  templatePath: string,
  input: Parameters<IntakeClarifier>[0],
): string {
  const answers = (input.answers ?? [])
    .map((a) => `Q: ${a.question}\nA: ${a.answer}`)
    .join('\n\n');
  return readFileSync(templatePath, 'utf8')
    .replace(/\{\{DESCRIPTION\}\}/g, input.description)
    .replace(/\{\{CONTEXT\}\}/g, input.context || '(none provided)')
    .replace(/\{\{ANSWERS\}\}/g, answers || '(none yet)');
}

export function apiClarifier(templatePath: string, model = 'claude-sonnet-5'): IntakeClarifier {
  return async (input) => {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({ timeout: 90_000 });
    const msg = await client.messages.create({
      model,
      max_tokens: 3_000,
      messages: [{ role: 'user', content: buildPrompt(templatePath, input) }],
      tools: [CLARIFY_TOOL],
      tool_choice: { type: 'tool', name: CLARIFY_TOOL.name },
    });
    const call = msg.content.find(
      (b): b is Extract<typeof b, { type: 'tool_use' }> => b.type === 'tool_use',
    );
    if (!call) throw new Error('clarify: no tool call');
    return gateClarify(call.input);
  };
}

export function claudePClarifier(templatePath: string, model = 'sonnet'): IntakeClarifier {
  return (input) =>
    new Promise<ClarifyResult>((resolve, reject) => {
      const prompt =
        buildPrompt(templatePath, input) +
        '\n\nReply with ONLY a JSON object: {"questions": [{id, question, options: [{label, detail}], recommended, why}], "rounds": [{id, label, interviewer, can_run_tests, time_limit_minutes, starts_from, submit, check_kind, emphasis, rationale, unsupported}]}';
      const child = spawn('claude', ['-p', prompt, '--output-format', 'text', '--model', model], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      child.stdout.on('data', (d) => (stdout += d));
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error('clarify: timed out'));
      }, 150_000);
      child.on('close', () => {
        clearTimeout(timer);
        try {
          const match = stdout.match(/\{[\s\S]*\}/);
          if (!match) throw new Error('clarify: no JSON in output');
          resolve(gateClarify(JSON.parse(match[0])));
        } catch (e) {
          reject(e);
        }
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
}

export function pickClarifier(templatePath: string): IntakeClarifier {
  return process.env.ANTHROPIC_API_KEY ? apiClarifier(templatePath) : claudePClarifier(templatePath);
}
