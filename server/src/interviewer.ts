/**
 * Interviewer agent — reactive + pressure (accepted posture).
 *
 *   candidate utterance ──► interviewer ──► `interviewer` trace event
 *   pressure timer ───────►             (nudge flag rides on the payload)
 *
 * It answers questions about the SPEC, applies time and scope pressure, and
 * never hints at the bug. It is given the planted bug on purpose: an agent
 * that does not know the answer cannot reliably avoid stumbling into it, and
 * it needs to recognize when a question is fishing for the location.
 *
 * Two independent defenses on the never-reveal rule:
 *   1. The prompt (prompts/interviewer.md) — handles judgment.
 *   2. leaksBugLocation() below — mechanical, unit-tested, no model in the
 *      loop. A reply naming the buggy file never reaches the candidate no
 *      matter what the model decided to say.
 *
 * Injectable end to end so tests never spawn a model.
 */

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { GeneratedProblem, TraceEvent } from '@interview-prep/shared';

export type InterviewerKind = 'answer' | 'pressure' | 'probe' | 'decline' | 'silent';

export interface InterviewerTurn {
  say: string;
  kind: InterviewerKind;
  nudge: boolean;
  /** Set when the leak guard replaced the model's message. */
  redacted?: boolean;
  /** Model-stated reason for a deliberate silence. LOG ONLY — never traced.
   *  Exists because a silent turn used to be indistinguishable from a
   *  crashed one (sess-1785962737985: three dropped asks, zero evidence). */
  reason?: string;
}

/** Has the candidate themselves touched the bug file? Drives the guard
 *  relaxation: found territory may be discussed. */
export function candidateVisitedBugFile(events: TraceEvent[], bugFile: string): boolean {
  if (!bugFile) return false;
  const base = bugFile.split('/').pop() ?? bugFile;
  return events.some((e) => {
    if (e.type !== 'edit' && e.type !== 'file_open' && e.type !== 'file_save') return false;
    const p = String((e.payload as { path?: string })?.path ?? '');
    return p.endsWith(`/${base}`) || p === base || p.endsWith(`/${bugFile}`) || p === bugFile;
  });
}

export interface InterviewerContext {
  spec: string;
  /** Ground truth about the planted bug. Never leaves this process. */
  bug: string;
  /** Path of the file holding the bug — used by the leak guard. */
  bugFile: string;
  /**
   * How the candidate runs the suite in THIS round (affordance + command).
   * Without it the model guesses: observed live, an interviewer told a
   * candidate to use `pytest` in a container where pytest was not
   * installed, on a round whose suite runs under unittest.
   */
  howToRun?: string;
  /**
   * buildTargetNote() output — the candidate's gap history as generator/
   * interviewer emphasis. Shapes WHERE pressure lands; must never be
   * mentioned (the prompt enforces it, guardGapLeak backstops it).
   */
  targetNote?: string;
  elapsedMs: number;
  remainingMs: number;
  recentActivity: string;
  transcript: { who: 'candidate' | 'interviewer'; text: string }[];
  /** null = unprompted pressure beat rather than a reply. */
  candidateMessage: string | null;
  /**
   * Set when the stuck detector fired: the ALIASED observation ("3
   * edit-and-run cycles … in the same file"). Its presence flips the turn
   * into scaffolding mode and arms the vocabulary guard. Never contains a
   * path — describeStuck speaks in identity, not names.
   */
  stuckObservation?: string | null;
  /**
   * Vocabulary the stuck guard treats as safe beyond the spec and the
   * candidate's own words — in practice the failing test's name, which is
   * on their screen even though it also appears inside `bug`.
   */
  allowedExtra?: string;
  /** renderWorkspaceView() output: real diffs of recently-edited files +
   *  the latest test output. PER-TURN (below the cache marker). */
  workspaceView?: string;
  /** True once the candidate has themselves touched the bug file —
   *  relaxes the location guard for found territory. */
  bugFileVisited?: boolean;
  /** The problem's six rubric dimension expectations, rendered as a list.
   *  Per-session constant (stable half, cacheable). The judge always had
   *  these; the interviewer probing blind to them was the rubric-blind
   *  finding — one dimension literally graded a question "to the
   *  interviewer" it never knew to expect. */
  rubric?: string;
  /** The blueprint's "## Interviewer engagement" section (or a per-check
   *  default): how led this round is, what to reward. Stable half. */
  engagement?: string;
  /** Set when a moment trigger fired ('opening' or a moments.ts detection):
   *  the observation text for the per-turn half. */
  momentObservation?: string | null;
}

export type Interviewer = (ctx: InterviewerContext) => Promise<InterviewerTurn>;

/**
 * Is this utterance ADDRESSED to the interviewer, or narration?
 *
 * Runs OUTSIDE the interviewer busy-lock, on every utterance the moment it
 * lands (eng review issue 1): classification is per-utterance and cheap;
 * replying is serialized and expensive. Narration therefore never contends
 * for the reply lock and never delays a real question behind it.
 *
 * Bias: default NOT addressed. A missed question costs a rephrase; a false
 * reply interrupts the candidate mid-thought, which is the one thing worse
 * than any latency number.
 */
export type IntentCheck = (
  text: string,
  spec: string,
  /** The last few turns, oldest first — a question split across breaths
   *  ("So I'm thinking... / ...can you tell me if that's right?") is
   *  unreadable as a lone fragment. */
  recent?: { who: 'candidate' | 'interviewer'; text: string }[],
) => Promise<boolean>;

/**
 * Addressed turns waiting for the interviewer. FIFO, small cap.
 *
 * NOT a single supersede slot: real candidates stack a follow-up before the
 * first question is answered, and dropping the older one makes the
 * interviewer look broken (outside-voice finding). When the cap is hit the
 * OLDEST drops — the newest question is the one the candidate is waiting on.
 */
export class TurnQueue {
  private items: string[] = [];
  constructor(private readonly cap = 2) {}
  push(text: string): void {
    this.items.push(text);
    if (this.items.length > this.cap) this.items.shift();
  }
  /** Everything queued, joined as one turn — the way a human interviewer
   *  answers two stacked questions in one breath. Empties the queue. */
  drain(): string | null {
    if (this.items.length === 0) return null;
    const text = this.items.join('\n');
    this.items = [];
    return text;
  }
  get size(): number {
    return this.items.length;
  }
}

/** What the candidate hears when the leak guard fires. */
export const REDACTED_REPLY =
  "I'm not going to point you anywhere. Talk me through what you've ruled out so far.";

const SILENT: InterviewerTurn = { say: '', kind: 'silent', nudge: false };

/**
 * Mechanical never-reveal check.
 *
 * Deliberately narrow: only the buggy file's path/basename/stem. Broadening
 * this to identifiers pulled from the bug description would block legitimate
 * spec answers — debugging-001's bug description contains "extend()", and
 * "extend" is domain vocabulary the spec itself uses. A guard that muzzles
 * correct answers gets switched off, so it stays surgical.
 */
export function leaksBugLocation(text: string, bugFile: string): boolean {
  if (!bugFile) return false;
  const base = bugFile.split('/').pop() ?? bugFile;
  const stem = base.replace(/\.[^.]+$/, '');
  const hay = text.toLowerCase();
  if (hay.includes(bugFile.toLowerCase())) return true;
  if (hay.includes(base.toLowerCase())) return true;
  // Word-boundary on the stem so "service" inside "serviceable" is not a hit,
  // and camelCase stems match however the model cased them.
  return stem.length > 3 && new RegExp(`\\b${escapeRe(stem)}\\b`, 'i').test(text);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Parse the model's JSON reply; anything unparseable becomes silence. */
export function parseTurn(raw: string): InterviewerTurn {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return SILENT;
  try {
    const o = JSON.parse(match[0]) as Partial<InterviewerTurn>;
    const say = String(o.say ?? '').trim();
    if (!say) {
      const reason = String(o.reason ?? '').trim();
      return reason ? { ...SILENT, reason } : SILENT;
    }
    return {
      say,
      kind: (['answer', 'pressure', 'probe', 'decline', 'silent'] as const).includes(
        o.kind as InterviewerKind,
      )
        ? (o.kind as InterviewerKind)
        : 'answer',
      // Absent/garbage nudge flag defaults to TRUE. An uncounted-but-honest
      // label beats a counted-but-prompted one.
      nudge: o.nudge === false ? false : true,
    };
  } catch {
    return SILENT;
  }
}

/**
 * Never-mention backstop for the gap targeting note (eng review T15).
 *
 * The prompt already forbids mentioning the candidate's history; this is the
 * mechanical layer underneath it, same two-defense structure as the bug
 * leak guard. Deliberately phrase-based and narrow: it matches the
 * DISTINCTIVE wording of the gap descriptions and meta-talk about history,
 * not ordinary interviewer vocabulary — "talk me through it" must survive,
 * or the guard muzzles exactly the probing the note is meant to shape.
 */
const GAP_TELL_PHRASES = [
  // meta-talk about measurement/history
  /last (?:time|session)/i,
  /previous session/i,
  /your (?:history|pattern|record|habit|tendency)/i,
  /being (?:measured|tracked|recorded)/i,
  /you (?:tend|usually|always|often) /i,
  // distinctive wording of GAP_DESCRIPTIONS
  /editing before reading/i,
  /before reading the failure/i,
  /goes? quiet when something breaks/i,
  /instead of narrating/i,
];

export function leaksGapNote(text: string): boolean {
  return GAP_TELL_PHRASES.some((re) => re.test(text));
}

/**
 * Vocabulary guard for STUCK turns (the one-step scaffolding move).
 *
 * The rule the whole feature hangs on: a hint may use only words the
 * candidate already has — the spec, the failing test's name, their own
 * utterances. Words that exist only in the private bug knowledge are the
 * mechanism ("re-registers", "expiry index", "stale"), and the mechanism is
 * the one thing a step must not hand over. The filename guard cannot catch
 * "something about ordering"; this can, because "ordering" isn't in the
 * spec unless the spec put it there.
 *
 * Only armed on stuck turns. On a normal turn the same check would muzzle
 * legitimate spec answers — exactly the over-broadening leaksBugLocation's
 * comment warns about — but a stuck turn is not answering a question, so
 * there is nothing legitimate for it to muzzle.
 */
const STEM_STOP = new Set([
  'that', 'this', 'with', 'without', 'from', 'into', 'onto', 'over', 'under',
  'when', 'then', 'than', 'them', 'they', 'their', 'there', 'here', 'have',
  'been', 'because', 'still', 'only', 'also', 'does', 'will', 'would',
  'should', 'could', 'about', 'after', 'before', 'next', 'previous', 'first',
  'last', 'same', 'other', 'which', 'what', 'where', 'while', 'your', 'more',
]);

function stems(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 4 || STEM_STOP.has(raw)) continue;
    let s = raw;
    for (const suffix of ['ing', 'ies', 'ed', 'es', 's']) {
      if (s.length - suffix.length >= 4 && s.endsWith(suffix)) {
        s = s.slice(0, -suffix.length);
        break;
      }
    }
    out.add(s);
  }
  return out;
}

/**
 * Session-frame vocabulary that can never be a leak: it names the MEDIUM
 * (files, tests, code), not the mechanism. The bug text inevitably contains
 * "File:" and "…one test:", and without this baseline every observation
 * ("the test fails the same way") would redact itself.
 */
const FRAME_VOCAB = new Set([
  'file', 'test', 'suite', 'code', 'line', 'fail', 'failure', 'error',
  'chang', 'edit', 'editor', 'minut', 'break',
]);

export function leaksImplementationVocabulary(
  text: string,
  forbiddenSource: string,
  allowed: string,
): boolean {
  const forbidden = stems(forbiddenSource);
  const safe = stems(allowed);
  for (const t of stems(text)) {
    if (FRAME_VOCAB.has(t)) continue;
    if (forbidden.has(t) && !safe.has(t)) return true;
  }
  return false;
}

/**
 * Apply the leak guard to whatever the model produced.
 *
 * `prompted` matters: the canned decline only reads as a decline when it
 * answers something. Redacting an unprompted pressure beat into "I'm not
 * going to point you anywhere" would be a non-sequitur — and, worse, a tell
 * that the agent nearly said something about where to look. Unprompted turns
 * redact to silence.
 */
export function guard(
  turn: InterviewerTurn,
  bugFile: string,
  prompted = true,
  hasTargetNote = false,
  /** Present only on stuck turns: arms the vocabulary check. */
  stuckVocab?: { forbidden: string; allowed: string },
  /** True once the candidate has edited/opened/saved the bug file
   *  THEMSELVES. Mentioning territory they already found is not a leak —
   *  discussing their own changes there is the whole point of the
   *  interviewer having eyes. Unvisited stays redacted exactly as before. */
  bugFileVisited = false,
): InterviewerTurn {
  if (!turn.say) return turn;
  const bugLeak = !bugFileVisited && leaksBugLocation(turn.say, bugFile);
  // The gap-note guard only arms when a note was actually injected —
  // otherwise a turn like "you tend to..." is just conversation.
  const gapLeak = hasTargetNote && leaksGapNote(turn.say);
  const vocabLeak =
    Boolean(stuckVocab) &&
    leaksImplementationVocabulary(turn.say, stuckVocab!.forbidden, stuckVocab!.allowed);
  if (!bugLeak && !gapLeak && !vocabLeak) {
    // A surviving stuck turn narrows by design (eliminate + redirect), so
    // the record must say so whatever the model claimed.
    return stuckVocab ? { ...turn, nudge: true } : turn;
  }
  // A stuck turn is always unprompted; its redaction is silence, and the
  // caller retries with a different composition on a later tick.
  return prompted && !stuckVocab
    ? { say: REDACTED_REPLY, kind: 'decline', nudge: false, redacted: true }
    : { say: '', kind: 'silent', nudge: false, redacted: true };
}

/**
 * Compact activity summary for the prompt: what they have been doing.
 *
 * REAL paths now (the aliasing era is over): every path here is a file the
 * candidate themselves touched, and the relaxed guard still redacts
 * bug-file mentions until the candidate has visited it — so the parroting
 * incident that created aliasing ("file A"/"file B") cannot recur through
 * this feed. What changed: the interviewer has workspace eyes, and an
 * interviewer that can see engine.py's diff but must call it "file A" in
 * conversation is incoherent.
 */
export function renderActivity(events: TraceEvent[], nowMs: number, limit = 10): string {
  const recent = events
    .filter((e) => e.type !== 'utterance' && e.type !== 'interviewer')
    .slice(-limit);
  if (recent.length === 0) return '(no editor activity yet)';
  const basename = (p: string) => (p ? (p.split('/').pop() ?? p) : 'a file');
  return recent
    .map((e) => {
      const ago = Math.round((nowMs - e.ts) / 1000);
      const p = e.payload as Record<string, unknown> | null;
      let what: string = e.type;
      if (e.type === 'test_run') {
        const s = String(p?.summary ?? '');
        what = `test run ${p?.exit_code === 0 ? 'PASSED' : 'FAILED'}${s ? ` (${s})` : ''}`;
      } else if (e.type === 'edit' || e.type === 'file_save' || e.type === 'file_open') {
        what = `${e.type} ${basename(String(p?.path ?? ''))}`;
      } else if (e.type === 'pause') {
        what = 'went silent';
      }
      return `  -${ago}s  ${what}`;
    })
    .join('\n');
}

/**
 * Fill the prompt template.
 *
 * Substitution is GLOBAL per token. It was not, once: `String.replace` with a
 * string pattern only replaces the first occurrence, so a variable named
 * anywhere earlier in the file consumed the value and the real slot stayed
 * literal. Live symptom was the interviewer telling a candidate one minute
 * into a 45-minute round that they had "about a minute left".
 */
export function render(template: string, ctx: InterviewerContext): string {
  const transcript =
    ctx.transcript.length === 0
      ? '(nothing said yet)'
      : ctx.transcript.map((t) => `${t.who}: ${t.text}`).join('\n');
  const values: Record<string, string> = {
    SPEC: ctx.spec,
    BUG: ctx.bug,
    HOW_TO_RUN: ctx.howToRun ?? 'Not known for this round — say you are not sure if asked.',
    TARGET_NOTE: ctx.targetNote ?? '(no history yet — first sessions)',
    RUBRIC: ctx.rubric ?? '(no rubric available for this round)',
    ENGAGEMENT: ctx.engagement ?? 'Balanced: probe at the flagged moments, otherwise let them work.',
    WORKSPACE_VIEW: ctx.workspaceView ?? '(no edits yet this session)',
    MOMENT: ctx.momentObservation
      ? `MOMENT — ${ctx.momentObservation} Follow the moment rules above: one focused probe about it, then release.`
      : 'no',
    ELAPSED_MIN: String(Math.round(ctx.elapsedMs / 60_000)),
    REMAINING_MIN: String(Math.max(0, Math.round(ctx.remainingMs / 60_000))),
    RECENT_ACTIVITY: ctx.recentActivity,
    STUCK: ctx.stuckObservation
      ? `STUCK — ${ctx.stuckObservation} Follow the stuck rules above: one move, their vocabulary only, nudge true.`
      : 'no',
    TRANSCRIPT: transcript,
    CANDIDATE_MESSAGE:
      ctx.candidateMessage ??
      '(nothing — this is an unprompted turn. Apply pressure or probe their ' +
        'reasoning, or stay silent with an empty `say` if there is genuinely ' +
        'nothing worth saying.)',
  };
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (whole, key: string) =>
    key in values ? (values[key] as string) : whole,
  );
}

/** The guard inputs for a stuck turn, or undefined on ordinary turns.
 *  Forbidden = the private bug knowledge; allowed = everything the candidate
 *  already has (spec, the failing test's name via allowedExtra, their own
 *  words). Exported so tests exercise the exact composition the runtime uses. */
export function stuckVocabOf(
  ctx: InterviewerContext,
): { forbidden: string; allowed: string } | undefined {
  if (!ctx.stuckObservation) return undefined;
  const candidateWords = ctx.transcript
    .filter((t) => t.who === 'candidate')
    .map((t) => t.text)
    .join('\n');
  return {
    forbidden: `${ctx.bug}\n${ctx.bugFile}`,
    allowed: `${ctx.spec}\n${ctx.allowedExtra ?? ''}\n${candidateWords}`,
  };
}

/** Marker splitting the session-stable prompt half from the per-turn half. */
const SESSION_STATE_MARKER = '<!-- SESSION STATE';

/**
 * Split render for the streaming path: the stable half (spec, bug, rules,
 * target note — identical every turn) becomes a CACHED system block; only
 * the per-turn half rides in the user message. Without the split, one
 * changing variable anywhere in the prompt defeats caching for all of it.
 */
export function renderSplit(
  template: string,
  ctx: InterviewerContext,
): { system: string; turn: string } {
  const whole = render(template, ctx);
  const idx = whole.indexOf(SESSION_STATE_MARKER);
  if (idx === -1) return { system: whole, turn: '(see system prompt)' };
  return { system: whole.slice(0, idx), turn: whole.slice(idx) };
}

function runClaudeP(prompt: string, model: string, timeoutMs: number): Promise<string> {
  return new Promise<string>((resolve) => {
    const child = spawn('claude', ['-p', prompt, '--output-format', 'text', '--model', model], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.on('data', (d) => (stdout += d));
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.on('close', () => {
      clearTimeout(timer);
      resolve(stdout);
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve('');
    });
  });
}

export function claudeInterviewer(templatePath: string, model = 'sonnet'): Interviewer {
  const template = readFileSync(templatePath, 'utf8');
  return async (ctx) => {
    const raw = await runClaudeP(render(template, ctx), model, 45_000);
    return guard(parseTurn(raw), ctx.bugFile, ctx.candidateMessage !== null, Boolean(ctx.targetNote), stuckVocabOf(ctx), ctx.bugFileVisited ?? false);
  };
}

/**
 * Streaming interviewer via the Anthropic API — the voice path.
 *
 * `claude -p` measured 3-11s per turn (fresh process, full prompt re-read,
 * no caching). Fine in a chat panel; dead air in a conversation. This path
 * streams with the stable prompt half as a CACHED system block, landing a
 * complete short turn in ~1-1.5s. NOTE: the turn is still guarded WHOLE
 * before anything is emitted or spoken — streaming shortens generation, it
 * never lets unguarded text out (see voice.ts tts()).
 *
 * Requires ANTHROPIC_API_KEY. pickInterviewer() falls back to claude -p
 * without it, so text-only sessions keep the subscription-auth story.
 */
export function streamingInterviewer(templatePath: string, model = 'claude-sonnet-5'): Interviewer {
  const template = readFileSync(templatePath, 'utf8');
  return async (ctx) => {
    const { system, turn } = renderSplit(template, ctx);
    try {
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      // Bounded, always: the SDK default is a 10-MINUTE timeout with two
      // silent retries — the structural source of the unbounded reply tail
      // (a real ask once waited 49s with nothing to show why).
      const client = new Anthropic({ timeout: 20_000, maxRetries: 1 });
      const t0 = Date.now();
      const stream = client.messages.stream({
        model,
        max_tokens: 400,
        // Sonnet 5 runs ADAPTIVE THINKING by default (documented change from
        // 4.6) and max_tokens caps thinking + text combined — thinking could
        // eat the whole 400 and truncate the JSON into an invisible silent
        // turn. A conversational beat does not need extended thinking.
        thinking: { type: 'disabled' },
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: turn }],
      });
      const msg = await stream.finalMessage();
      const raw = msg.content
        .filter((b) => b.type === 'text')
        .map((b) => (b as { text: string }).text)
        .join('');
      console.log(`[latency] interviewer=${Date.now() - t0}ms`);
      if (msg.stop_reason === 'max_tokens') {
        // A truncated turn parses to SILENT and vanishes — say so loudly.
        console.warn(`[interviewer] turn TRUNCATED at max_tokens — raw tail: …${raw.slice(-120)}`);
      }
      return guard(parseTurn(raw), ctx.bugFile, ctx.candidateMessage !== null, Boolean(ctx.targetNote), stuckVocabOf(ctx), ctx.bugFileVisited ?? false);
    } catch (e) {
      console.warn('[interviewer] streaming failed, this turn is silent:', String(e).slice(0, 200));
      return { say: '', kind: 'silent', nudge: false };
    }
  };
}

/** Streaming when a key is present, claude -p otherwise. */
export function pickInterviewer(templatePath: string): Interviewer {
  return process.env.ANTHROPIC_API_KEY
    ? streamingInterviewer(templatePath)
    : claudeInterviewer(templatePath);
}

const INTENT_PROMPT = (
  text: string,
  spec: string,
  recent: { who: 'candidate' | 'interviewer'; text: string }[] = [],
) =>
  [
    'A candidate is working through a technical interview problem out loud.',
    'Decide whether their LATEST utterance is addressed to the interviewer.',
    '',
    'Problem context: ' + spec.slice(0, 1200),
    '',
    recent.length > 0
      ? 'What was said just before (oldest first):\n' +
        recent.map((r) => `${r.who}: ${r.text}`).join('\n')
      : '(nothing said before this)',
    '',
    'LATEST utterance from the candidate:',
    '---',
    text,
    '---',
    '',
    'ADDRESSED (answer yes) — they want a response from the interviewer:',
    '- asks the interviewer for information, a hint, or confirmation',
    '- addresses them directly ("hey", "so", "can you", using their role)',
    '- a fragment that COMPLETES a question begun in the lines above',
    '- checks a shared assumption ("we are meant to fix only src, right?")',
    '',
    'NOT ADDRESSED (answer no) — thinking out loud:',
    '- a RHETORICAL SELF-QUESTION they are working through themselves',
    '  ("why is this null?", "wait, did I miss something?", "is this even',
    '  the right file?") — interrogative form, but they are reasoning, not',
    '  asking. This is the most common case; do not mistake it for an ask.',
    '- narrating what they read, suspect, or are about to try',
    '- filler, false starts, swearing, or asides to no one',
    '',
    'OVERRIDE, before the deciding test: an EXPLICIT REQUEST is always',
    'addressed — asking for help, a hint, a hand, confirmation, or directions',
    'is a request even when it is about the code in front of them ("how do I',
    'pair these results?", "can you give me a hand?", "why is it wrong?").',
    'The rhetorical carve-out applies ONLY to questions the candidate',
    'immediately proceeds to answer themselves.',
    '',
    'THE DECIDING TEST when a question could be either — who can answer it?',
    '- About INTENDED BEHAVIOR, requirements, or the rules of the exercise?',
    '  Only the interviewer knows. That is an ask. ("Should a partially',
    '  shipped hold release only unshipped units?")',
    '- About THE CODE IN FRONT OF THEM — what a variable holds, which branch',
    '  ran, what a function does? They can answer it by reading. That is',
    '  thinking aloud, even in question form. ("Why is this null?", "Did I',
    '  miss something in the test setup?")',
    '',
    'Otherwise the test is INTENT, not punctuation: would a human interviewer',
    'sitting there feel it was their turn to speak? If the candidate is',
    'mid-thought and would keep going regardless, answer no.',
    '',
    'Reply with ONLY the word "yes" or "no".',
  ].join('\n');

/** Intent check via the API (haiku, fast path). */
export function apiIntentCheck(): IntentCheck {
  return async (text, spec, recent) => {
    try {
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      // Same bounding rule as the interviewer: never the SDK's 10-minute
      // default on a gate that sits in series before every reply.
      const client = new Anthropic({ timeout: 5_000, maxRetries: 1 });
      const t0 = Date.now();
      const msg = await client.messages.create({
        model: 'claude-haiku-4-5',
        max_tokens: 5,
        messages: [{ role: 'user', content: INTENT_PROMPT(text, spec, recent) }],
      });
      console.log(`[latency] intent=${Date.now() - t0}ms`);
      const out = msg.content
        .filter((b) => b.type === 'text')
        .map((b) => (b as { text: string }).text)
        .join('')
        .toLowerCase();
      return out.includes('yes');
    } catch (e) {
      // Fail toward silence, never toward interruption — but NEVER silently.
      // First judge-era live session: every utterance (including "Yo,
      // interviewer, can you give me a hand?") came back narration, and this
      // catch ate whatever went wrong, leaving nothing to diagnose. The
      // all-false fallback pathology banned in the judge was alive here.
      console.warn('[intent] API check ERRORED (treating as narration):', String(e).slice(0, 200));
      return false;
    }
  };
}

/** Intent check via headless claude (no API key; slower, text-mode OK). */
export function claudePIntentCheck(): IntentCheck {
  return async (text, spec, recent) => {
    const out = await runClaudeP(INTENT_PROMPT(text, spec, recent), 'haiku', 20_000);
    if (out.trim().length === 0) {
      console.warn('[intent] claude -p returned EMPTY (treating as narration)');
    }
    return out.toLowerCase().includes('yes');
  };
}

export function pickIntentCheck(): IntentCheck {
  return process.env.ANTHROPIC_API_KEY ? apiIntentCheck() : claudePIntentCheck();
}

/** Build the guarded context fields from a problem manifest. */
export function bugContext(problem: GeneratedProblem): { bug: string; bugFile: string } {
  const b = problem.planted_bug;
  if (!b) return { bug: '(no planted bug for this round type)', bugFile: '' };
  return {
    bug: `File: ${b.file} (line ${b.line})\n${b.description}\nIt breaks exactly one test: "${b.failing_test}".`,
    bugFile: b.file,
  };
}
