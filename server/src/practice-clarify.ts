/**
 * Practice-door clarifier — the gap-deriving fork of clarify.ts.
 *
 *   paste ──► ONE forced tool call (practice_clarify) ──► gate ──►
 *       { drafts, gaps, brief } ──► the two-column confirm screen
 *                                    rail = settled gaps · column = open gaps
 *
 * Why this exists (design review 2026-08-12, decisions 4A/7A/3A/2B): the door's
 * fixed "Inferred shape" field row asked the same four things regardless of the
 * paste. The fix is NOT letting the model author UI — the mockup proved that
 * failure by inventing closed pills for an open question. Instead the model
 * authors WHICH gaps exist (semantic gaps, classified against the blueprint
 * skeleton's sections) and the CLIENT renders controls deterministically from
 * `closed` + `answer_type`. clarify.ts stays untouched for plan intake — its
 * "zero questions is the common case" discipline is right there and wrong here.
 *
 * Two gap sources, rendered identically:
 *   - Drafter gaps: model-classified per skeleton section, gated against
 *     GAP_SECTIONS (derived from blueprint.ts so the two cannot drift).
 *   - Runtime gaps: code-owned (RUNTIME_GAP_IDS), currently time and language —
 *     the only two fields the CANDIDATE is the sole source of, so the model is
 *     not trusted to remember them. The round draft reports provenance
 *     (`time_evidence`, `language_evidence`) and deriveRuntimeGaps() asks when
 *     it is unknown. Language still takes its OPTIONS from the model
 *     (`language_options`), because "Go, because the JD says Go" beats any
 *     hardcoded list; code owns whether the question exists, not its content.
 *     Provenance lives HERE, never in RoundSpec — the two-artifact rule
 *     forbids widening the closed vocabulary (clarify-only state).
 *
 * The SPOILER RULE (2026-08-12, live use): a gap may describe the round, never
 * the problem. The candidate came to face something unseen, so "which discount
 * rules?" or "which bug class?" hands them the exam — and a model-guessed topic
 * rendered on the rail spoils it just as thoroughly. The recognizability
 * discriminator alone could not catch this: it optimizes for fidelity, and more
 * content-specificity is always more faithful. This is the same instinct as
 * interviewer.ts's leaksBugLocation() — the interviewer KNOWS the bug and is
 * mechanically stopped from saying it.
 *
 * Same module shape as judge.ts et al: pure exported gate that throws,
 * buildPrompt, forced tool call on the API path, claude -p fallback, pickX().
 * Gate errors reuse clarify.ts's message prefixes so clarifyFailureMessage
 * keeps mapping them to actionable copy.
 */

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { deriveMemoryTags, validateRoundSpec } from '@interview-prep/shared';
import { draftToSpec, type DraftToolOutput, type SpecDraft } from './intake.js';
import { ROUND_FIELDS, coerceArray } from './clarify.js';
import { REQUIRED_HEADINGS } from './blueprint.js';

/** The section vocabulary — REQUIRED_HEADINGS plus the optional engagement
 *  section, '## ' stripped. Derived so blueprint.ts and this module cannot
 *  drift; all four skeletons share exactly these eight headings. */
export const GAP_SECTIONS: readonly string[] = [
  ...REQUIRED_HEADINGS.map((h) => h.replace(/^##\s*/, '')),
  'Interviewer engagement',
];

/** The section that names what the problem is ABOUT. Confirm-only, and only
 *  for material the candidate stated — see the spoiler rule in gateGap. */
export const SPOILER_SECTION = 'Topic guidance';

/** Gap ids the CODE owns. The gate rejects model-authored gaps that collide —
 *  a field the drafter never reads, or one the product cannot ship without,
 *  is not the model's to remember.
 *
 *  These two are the ONLY fields that need a floor, and the test is three
 *  parts: the value is silently defaultable (the type cannot tell "unknown"
 *  from a legal value), getting it wrong is unrecoverable five minutes later,
 *  and no sane code-level default exists. `time_limit_ms: null` is legal for
 *  live rounds so unknown is invisible; `language` is not in RoundSpec at all
 *  so the generator simply picks. Everything else in the vocabulary is either
 *  required (the validator cannot miss it), coherence-gated by draftToSpec, or
 *  genuinely derivable — `surface` resolves from `starts_from` and is right.
 *
 *  Language earns a floor because a HackerRank OA can NEVER pin it (the
 *  candidate picks at test time) and a Go shop handed a Python repo has an
 *  unrecognizable round. A live run returned zero open gaps on exactly that
 *  paste and the candidate had to volunteer "python" through the correction
 *  box (2026-08-12). */
export const RUNTIME_GAP_IDS = ['time-limit', 'language'] as const;

export type TimeEvidence = 'stated_timed' | 'stated_untimed' | 'unknown';
export type LanguageEvidence = 'stated' | 'unknown';

export interface PracticeGap {
  id: string;
  /** 2-4 words for the confirm rail ("language", "bug class"). */
  label: string;
  /** Asked in the right column while the gap is open. */
  question: string;
  /** One sentence: what changes based on the answer. */
  why: string;
  status: 'open' | 'settled';
  /** Current value in plain words; '' only when open with no guess. */
  value: string;
  /** Drives the rail's sort: model guesses (inferred) surface first. */
  evidence: 'stated' | 'inferred' | 'answered';
  /** true ONLY for a genuine enum — pills only. false = pills are shortcuts
   *  PLUS a labelled text input (planner.ts ask_user's rule, D4 2026-08-08). */
  closed: boolean;
  answer_type: 'enum' | 'text' | 'minutes' | 'count';
  options: { label: string; detail?: string }[];
  /** REWRITTEN from target by the gate, never trusted: spec.* answers re-infer
   *  (coherence lives in draftToSpec), context answers accumulate client-side. */
  affects: 'shape' | 'flavor';
  /** 'context' | 'spec.<path>' — where the answer lands at Start. */
  target: string;
  /** Which skeleton section this gap feeds; must be in GAP_SECTIONS. */
  section: string;
}

export interface PracticeClarifyResult {
  drafts: SpecDraft[];
  /** ONE list; the client splits by status (rail = settled, column = open). */
  gaps: PracticeGap[];
  /** 3-4 plain sentences; '' when the model's brief failed coercion. */
  brief: string;
}

export type PracticeClarifier = (input: {
  description: string;
  context: string;
  answers?: { id: string; question: string; answer: string }[];
  /** Typed content blocks (images/PDFs), attachmentBlocksFromDecoded's output. */
  attachments?: Record<string, unknown>[];
}) => Promise<PracticeClarifyResult>;

// ---- the forced tool ----

const GAP_FIELDS = {
  id: { type: 'string', description: 'kebab-case, STABLE across re-infers — the same semantic gap keeps the same id.' },
  label: { type: 'string', description: '2-4 words for the confirm rail, e.g. "language".' },
  question: { type: 'string', description: 'One concrete sentence, phrased for this material.' },
  why: { type: 'string', description: 'One sentence: what changes based on the answer.' },
  status: { type: 'string', enum: ['open', 'settled'] },
  value: { type: 'string', description: 'Current value in plain words. Empty only when open with no guess.' },
  evidence: { type: 'string', enum: ['stated', 'inferred', 'answered'] },
  closed: { type: 'boolean', description: 'true ONLY when the options exhaust the legal answers.' },
  answer_type: { type: 'string', enum: ['enum', 'text', 'minutes', 'count'] },
  options: {
    type: 'array',
    description: '2-4 tappable shortcuts, drawn from the material where possible.',
    items: {
      type: 'object',
      properties: { label: { type: 'string' }, detail: { type: 'string' } },
      required: ['label'],
    },
  },
  affects: { type: 'string', enum: ['shape', 'flavor'] },
  target: { type: 'string', description: "'context' for prose that rides into generation; a spec path like 'spec.check.kind' when the answer changes the round shape." },
  section: { type: 'string', enum: [...GAP_SECTIONS] },
};

const PRACTICE_TOOL = {
  name: 'practice_clarify',
  description:
    'Return best-guess round drafts, the semantic gaps between the material and a faithful practice round, and a plain-words brief.',
  input_schema: {
    type: 'object' as const,
    properties: {
      rounds: {
        type: 'array',
        description: 'AT LEAST 1 — best-guess drafts even while gaps are open. One entry PER DISTINCT ROUND.',
        items: {
          type: 'object',
          properties: {
            ...ROUND_FIELDS,
            time_evidence: {
              type: 'string',
              enum: ['stated_timed', 'stated_untimed', 'unknown'],
              description:
                'stated_timed: the material names a limit; stated_untimed: the material says untimed / live-paced; unknown: the material is silent — never guess.',
            },
            language: {
              type: 'string',
              description:
                'The programming language the round runs in, ONLY when the material names or clearly implies it ("a Java service", a Python traceback). Empty string when it does not.',
            },
            language_evidence: {
              type: 'string',
              enum: ['stated', 'unknown'],
              description:
                'stated: the material pins the language; unknown: it does not — never guess. Most OAs are unknown (the candidate picks at test time).',
            },
            language_options: {
              type: 'array',
              description:
                'When language_evidence is unknown: 2-4 languages worth offering, drawn from the material where possible (the stack a JD names, what a sibling round used). Empty when you have nothing to go on.',
              items: { type: 'string' },
            },
          },
          required: ['id', 'label', 'interviewer', 'can_run_tests', 'time_limit_minutes', 'starts_from', 'submit', 'check_kind', 'rationale', 'unsupported', 'time_evidence', 'language', 'language_evidence'],
        },
      },
      gaps: {
        type: 'array',
        description:
          'Semantic gaps per blueprint section, from the discriminator: would the generic fallback produce a round the candidate would not recognize? Include SETTLED entries for load-bearing values you inferred. NEVER emit a time-limit gap — code owns it.',
        items: { type: 'object', properties: GAP_FIELDS, required: ['id', 'label', 'question', 'why', 'status', 'value', 'evidence', 'closed', 'answer_type', 'options', 'affects', 'target', 'section'] },
      },
      brief: {
        type: 'string',
        description: '3-4 plain sentences, second person: what will be built and how the session runs. No vocabulary words.',
      },
    },
    required: ['rounds', 'gaps', 'brief'],
  },
};

// ---- runtime gaps (code-owned) ----

/** The one question the product owns. Options are shortcuts, never a gate
 *  (answer_type 'minutes' still renders a labelled text input — closed:false). */
function timeLimitGap(): PracticeGap {
  return {
    id: 'time-limit',
    label: 'time limit',
    question: 'Is this round timed?',
    why: 'A timed round is paced and graded once; an untimed one lets you iterate.',
    status: 'open',
    value: '',
    evidence: 'inferred',
    closed: false,
    answer_type: 'minutes',
    options: [{ label: 'Untimed' }, { label: '30 min' }, { label: '60 min' }, { label: '90 min' }],
    affects: 'shape',
    target: 'spec.capabilities.time_limit_ms',
    section: 'What this round is',
  };
}

/** Generic shortcuts, used only when the model offered nothing from the
 *  material. Deliberately short: options are shortcuts to typing, never the
 *  menu of legal answers (the gap stays closed:false, so the text input is
 *  always there). */
const FALLBACK_LANGUAGES = ['Python', 'JavaScript/TypeScript', 'Java', 'Go'];

/** The language floor. Code owns WHETHER the question exists; the model still
 *  supplies the OPTIONS, because its suggestions come from the paste ("Go"
 *  because the JD says Go) and a hardcoded list would throw that away. Keyed
 *  on language_evidence, never on gap ids — ids drift between re-inferences,
 *  so id-matching would be unreliable in exactly the case the floor exists
 *  for. */
function languageGap(options: string[]): PracticeGap {
  const opts = (options.length ? options : FALLBACK_LANGUAGES).slice(0, 4);
  return {
    id: 'language',
    label: 'language',
    question: 'Which language should the generated problem use?',
    why: 'The repo, the tests, and the error messages are all written in it.',
    status: 'open',
    value: '',
    evidence: 'inferred',
    closed: false,
    answer_type: 'text',
    options: opts.map((label) => ({ label })),
    affects: 'flavor',
    target: 'context',
    section: 'Environment',
  };
}

/** Deterministic runtime-gap derivation. Pure; unit-tested as a truth table. */
export function deriveRuntimeGaps(input: {
  timeEvidence: TimeEvidence;
  timeLimitMs: number | null;
  languageEvidence: LanguageEvidence;
  language: string;
  languageOptions: string[];
  answeredIds: ReadonlySet<string>;
  answers?: { id: string; answer: string }[];
}): PracticeGap[] {
  const out: PracticeGap[] = [];

  const settledTime = (value: string, evidence: PracticeGap['evidence']): PracticeGap => ({
    ...timeLimitGap(), status: 'settled', value, evidence,
  });
  const asWords = (ms: number | null): string => (ms === null ? 'untimed' : `${Math.round(ms / 60_000)} minutes`);
  if (input.answeredIds.has('time-limit')) out.push(settledTime(asWords(input.timeLimitMs), 'answered'));
  else if (input.timeEvidence === 'stated_timed') out.push(settledTime(asWords(input.timeLimitMs), 'stated'));
  else if (input.timeEvidence === 'stated_untimed') out.push(settledTime('untimed', 'stated'));
  else out.push(timeLimitGap());

  const base = languageGap(input.languageOptions);
  const answered = (input.answers ?? []).find((a) => a.id === 'language');
  if (answered) out.push({ ...base, status: 'settled', value: answered.answer, evidence: 'answered' });
  else if (input.languageEvidence === 'stated' && input.language.trim()) {
    out.push({ ...base, status: 'settled', value: input.language.trim(), evidence: 'stated' });
  } else out.push(base);

  return out;
}

/** The code-owned backstop: parse the time answer and patch every draft's
 *  spec directly — the model's re-emission is advisory only. Re-derives tags
 *  (time_boxed keys on time_limit_ms) and re-proves the spec. Returns the
 *  effective evidence; 'unknown' means the answer was unparseable and the gap
 *  stays open (re-ask beats a silent guess). */
export function applyTimeAnswer(drafts: SpecDraft[], answer: string): TimeEvidence {
  const a = answer.trim().toLowerCase();
  let ms: number | null | undefined;
  if (/^(untimed|no limit|none|no|live|not timed)\b/.test(a)) ms = null;
  else {
    const m = a.match(/(\d+(?:\.\d+)?)\s*(h|hr|hour)?/);
    if (m && Number(m[1]) > 0) {
      const n = Number(m[1]);
      ms = Math.round((m[2] ? n * 60 : n) * 60_000);
    }
  }
  if (ms === undefined) return 'unknown';
  for (const d of drafts) {
    d.spec.capabilities.time_limit_ms = ms;
    d.spec.memory_tags = deriveMemoryTags(d.spec.capabilities);
    if (!d.unsupported) {
      const failures = validateRoundSpec(d.spec);
      if (failures.length > 0) throw new Error(`clarify: time answer broke the spec: ${failures.join('; ')}`);
    }
  }
  return ms === null ? 'stated_untimed' : 'stated_timed';
}

// ---- the gate ----

function text(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function coerceTimeEvidence(raw: unknown, timeLimitMs: number | null): TimeEvidence {
  const t = text(raw);
  // Conservative coercions: a contradiction between evidence and value means
  // the model was confused — resolve toward the value when it carries a
  // number, toward asking when it does not.
  if (t === 'stated_untimed') return timeLimitMs === null ? 'stated_untimed' : 'stated_timed';
  if (t === 'stated_timed') return timeLimitMs === null ? 'unknown' : 'stated_timed';
  return 'unknown';
}

/** One model gap → PracticeGap, or a throw naming the drop reason (caught
 *  per-gap: a bad gap never sinks its siblings). */
function gateGap(raw: unknown): PracticeGap {
  const g = raw as Record<string, unknown>;
  const question = text(g.question);
  const label = text(g.label);
  const why = text(g.why);
  if (!question || !label || !why) throw new Error('gap without label/question/why');
  const id = text(g.id) || question.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
  const target = text(g.target);
  if (target !== 'context' && !/^spec\.[a-z_.]+$/.test(target)) throw new Error(`gap "${id}" has bad target "${target}"`);
  if ((RUNTIME_GAP_IDS as readonly string[]).includes(id) || target === 'spec.capabilities.time_limit_ms') {
    throw new Error(`gap "${id}" collides with a code-owned runtime gap`);
  }
  const section = text(g.section);
  if (!GAP_SECTIONS.includes(section)) throw new Error(`gap "${id}" names unknown section "${section}"`);
  const status = g.status === 'settled' ? 'settled' : g.status === 'open' ? 'open' : null;
  if (!status) throw new Error(`gap "${id}" has bad status`);
  const value = text(g.value);
  if (status === 'settled' && !value) throw new Error(`gap "${id}" settled with no value`);
  const evidences = ['stated', 'inferred', 'answered'] as const;
  const evidence = evidences.includes(g.evidence as never) ? (g.evidence as PracticeGap['evidence']) : 'inferred';
  // THE SPOILER RULE. A gap may describe the round, never the problem: the
  // candidate came to face something they have not seen. `Topic guidance` is
  // the section that says what the problem is ABOUT, so it is confirm-only
  // and only for what the candidate already told us — asking "which discount
  // rules?" or "which bug class?" makes them author their own exam, and a
  // model-GUESSED topic on the rail spoils it just by being readable.
  // Topical intent belongs in spec.emphasis, which reaches the drafter and
  // never renders. Same shape as the runtime-gap rule: the prompt carries the
  // nuance, this catches the blunt case.
  if (section === SPOILER_SECTION && !(status === 'settled' && evidence === 'stated')) {
    throw new Error(`gap "${id}" would hand the candidate the problem (${SPOILER_SECTION} is confirm-only, and only for stated material)`);
  }
  const options = coerceArray(g.options ?? [])
    .map((op) => {
      const o = op as { label?: unknown; detail?: unknown };
      const l = text(o.label);
      const detail = text(o.detail);
      return l ? { label: l, ...(detail ? { detail } : {}) } : null;
    })
    .filter((o): o is { label: string; detail?: string } => o !== null);
  if (options.length > 5) throw new Error(`gap "${id}" has ${options.length} options (max 5)`);
  const closed = g.closed === true;
  const answerTypes = ['enum', 'text', 'minutes', 'count'] as const;
  const answer_type = answerTypes.includes(g.answer_type as never) ? (g.answer_type as PracticeGap['answer_type']) : 'text';
  if ((closed || answer_type === 'enum') && options.length < 2) {
    throw new Error(`gap "${id}" is closed with ${options.length} option(s)`);
  }
  return {
    id,
    label,
    question,
    why,
    status,
    value,
    evidence,
    closed,
    answer_type,
    options,
    // Derived, never trusted: what the answer TOUCHES decides what it costs.
    affects: target === 'context' ? 'flavor' : 'shape',
    target,
    section,
  };
}

const MAX_OPEN_GAPS = 5;

/**
 * Mechanical gate over one practice_clarify output. Per-draft AND per-gap
 * leniency (clarify.ts's live-failure lesson): a bad item is dropped with a
 * warn, never sinks siblings. Throws only when every draft fails — the caller
 * falls down the ladder to single-spec inference.
 */
export function gatePracticeClarify(
  raw: unknown,
  answers?: { id: string; answer: string }[],
): PracticeClarifyResult {
  const o = raw as { rounds?: unknown; gaps?: unknown; brief?: unknown };

  const rounds = coerceArray(o.rounds ?? []);
  if (rounds.length === 0) throw new Error('clarify: no rounds — best-guess drafts are mandatory');
  if (rounds.length > 4) throw new Error(`clarify: ${rounds.length} rounds (max 4)`);
  const drafts: SpecDraft[] = [];
  const rawByDraft: Record<string, unknown>[] = [];
  const droppedDrafts: string[] = [];
  for (const r of rounds) {
    try {
      drafts.push(draftToSpec(r as DraftToolOutput));
      rawByDraft.push(r as Record<string, unknown>);
    } catch (e) {
      droppedDrafts.push(String(e).slice(0, 120));
    }
  }
  if (drafts.length === 0) {
    throw new Error(`clarify: every draft failed the gate: ${droppedDrafts.join(' | ')}`);
  }
  if (droppedDrafts.length > 0) {
    console.warn(`[practice-clarify] dropped ${droppedDrafts.length} incoherent draft(s): ${droppedDrafts.join(' | ')}`);
  }
  const ids = new Set(drafts.map((d) => d.spec.id));
  if (ids.size !== drafts.length) throw new Error('clarify: duplicate round ids');

  // Time: an answered time gap is applied by CODE (the model's re-emission is
  // advisory); otherwise evidence comes from the first surviving draft.
  const answeredIds = new Set((answers ?? []).map((a) => a.id));
  const timeAnswer = (answers ?? []).find((a) => a.id === 'time-limit');
  let timeEvidence: TimeEvidence;
  if (timeAnswer) {
    timeEvidence = applyTimeAnswer(drafts, timeAnswer.answer);
    if (timeEvidence === 'unknown') answeredIds.delete('time-limit'); // unparseable — re-ask
  } else {
    timeEvidence = coerceTimeEvidence(rawByDraft[0]!.time_evidence, drafts[0]!.spec.capabilities.time_limit_ms);
  }

  // Model gaps: per-gap leniency, dedup by id (first wins), open-gap cap.
  const gaps: PracticeGap[] = [];
  const seen = new Set<string>();
  const droppedGaps: string[] = [];
  let open = 0;
  for (const rawGap of coerceArray(o.gaps ?? [])) {
    let gap: PracticeGap;
    try {
      gap = gateGap(rawGap);
    } catch (e) {
      droppedGaps.push(String(e instanceof Error ? e.message : e).slice(0, 120));
      continue;
    }
    if (seen.has(gap.id)) continue;
    seen.add(gap.id);
    // The prompt tells the model to settle answered gaps; patch when it forgot.
    const answered = (answers ?? []).find((a) => a.id === gap.id);
    if (answered && gap.status === 'open') {
      gap = { ...gap, status: 'settled', value: answered.answer, evidence: 'answered' };
    }
    if (gap.status === 'open') {
      if (open >= MAX_OPEN_GAPS) {
        droppedGaps.push(`gap "${gap.id}" over the ${MAX_OPEN_GAPS}-open cap`);
        continue;
      }
      open += 1;
    }
    gaps.push(gap);
  }
  if (droppedGaps.length > 0) {
    console.warn(`[practice-clarify] dropped ${droppedGaps.length} gap(s): ${droppedGaps.join(' | ')}`);
  }

  const first = rawByDraft[0]!;
  gaps.push(
    ...deriveRuntimeGaps({
      timeEvidence,
      timeLimitMs: drafts[0]!.spec.capabilities.time_limit_ms,
      languageEvidence: text(first.language_evidence) === 'stated' ? 'stated' : 'unknown',
      language: text(first.language),
      languageOptions: coerceArray(first.language_options ?? [])
        .map((o) => text(o))
        .filter(Boolean),
      answeredIds,
      answers,
    }),
  );

  // The brief is decoration; drafts are the product. Coerce, never throw.
  let brief = text(o.brief);
  if (brief.length < 40 || brief.length > 700) {
    if (brief) console.warn(`[practice-clarify] brief failed coercion (${brief.length} chars)`);
    brief = '';
  }

  return { drafts, gaps, brief };
}

// ---- prompt + model paths (clarify.ts's shape) ----

function buildPrompt(templatePath: string, input: Parameters<PracticeClarifier>[0]): string {
  const answers = (input.answers ?? [])
    .map((a) => `Q(id=${a.id}): ${a.question}\nA: ${a.answer}`)
    .join('\n\n');
  return readFileSync(templatePath, 'utf8')
    .replace(/\{\{DESCRIPTION\}\}/g, input.description)
    .replace(/\{\{CONTEXT\}\}/g, input.context || '(none provided)')
    .replace(/\{\{ANSWERS\}\}/g, answers || '(none yet)');
}

export function apiPracticeClarifier(templatePath: string, model = 'claude-sonnet-5'): PracticeClarifier {
  return async (input) => {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({ timeout: 90_000 });
    // Attachments lead as typed blocks; stable evidence before varying answers
    // (prompt-cache order, clarify.ts precedent).
    const content = [
      ...(input.attachments ?? []),
      { type: 'text' as const, text: buildPrompt(templatePath, input) },
    ] as unknown as import('@anthropic-ai/sdk/resources/messages').ContentBlockParam[];
    const msg = await client.messages.create({
      model,
      max_tokens: 4_000,
      messages: [{ role: 'user', content }],
      tools: [PRACTICE_TOOL],
      tool_choice: { type: 'tool', name: PRACTICE_TOOL.name },
    });
    const call = msg.content.find(
      (b): b is Extract<typeof b, { type: 'tool_use' }> => b.type === 'tool_use',
    );
    if (!call) throw new Error('clarify: no tool call');
    return gatePracticeClarify(call.input, input.answers);
  };
}

export function claudePPracticeClarifier(templatePath: string, model = 'sonnet'): PracticeClarifier {
  return (input) =>
    new Promise<PracticeClarifyResult>((resolve, reject) => {
      const attachNote = input.attachments?.length
        ? `\n\n(${input.attachments.length} binary attachment(s) exist but are not readable in fallback mode — do not guess their contents.)`
        : '';
      const prompt =
        buildPrompt(templatePath, input) + attachNote +
        '\n\nReply with ONLY a JSON object: {"rounds": [{id, label, interviewer, can_run_tests, time_limit_minutes, time_evidence, language, language_evidence, language_options, starts_from, submit, check_kind, emphasis, rationale, unsupported}], "gaps": [{id, label, question, why, status, value, evidence, closed, answer_type, options: [{label, detail}], affects, target, section}], "brief": "..."}';
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
          resolve(gatePracticeClarify(JSON.parse(match[0]), input.answers));
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

export function pickPracticeClarifier(templatePath: string): PracticeClarifier {
  return process.env.ANTHROPIC_API_KEY
    ? apiPracticeClarifier(templatePath)
    : claudePPracticeClarifier(templatePath);
}
