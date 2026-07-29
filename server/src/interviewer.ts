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
}

export interface InterviewerContext {
  spec: string;
  /** Ground truth about the planted bug. Never leaves this process. */
  bug: string;
  /** Path of the file holding the bug — used by the leak guard. */
  bugFile: string;
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
export type IntentCheck = (text: string, spec: string) => Promise<boolean>;

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
    if (!say) return SILENT;
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
): InterviewerTurn {
  if (!turn.say) return turn;
  const bugLeak = leaksBugLocation(turn.say, bugFile);
  // The gap-note guard only arms when a note was actually injected —
  // otherwise a turn like "you tend to..." is just conversation.
  const gapLeak = hasTargetNote && leaksGapNote(turn.say);
  if (!bugLeak && !gapLeak) return turn;
  return prompted
    ? { say: REDACTED_REPLY, kind: 'decline', nudge: false, redacted: true }
    : { say: '', kind: 'silent', nudge: false, redacted: true };
}

/**
 * Compact activity summary for the prompt: what they have been doing.
 *
 * File paths are ALIASED ("file A", "file B"). Measured with the real agent:
 * given raw paths, an unprompted pressure beat parroted the buggy file's name
 * straight back out of the activity feed. The interviewer never needs the
 * name — it needs identity ("still in the same file after 8 minutes"), which
 * an alias carries just as well while removing the easiest accidental leak.
 */
export function renderActivity(events: TraceEvent[], nowMs: number, limit = 10): string {
  const recent = events
    .filter((e) => e.type !== 'utterance' && e.type !== 'interviewer')
    .slice(-limit);
  if (recent.length === 0) return '(no editor activity yet)';
  const aliases = new Map<string, string>();
  const alias = (p: string) => {
    if (!p) return 'a file';
    if (!aliases.has(p)) aliases.set(p, `file ${String.fromCharCode(65 + aliases.size)}`);
    return aliases.get(p) as string;
  };
  return recent
    .map((e) => {
      const ago = Math.round((nowMs - e.ts) / 1000);
      const p = e.payload as Record<string, unknown> | null;
      let what: string = e.type;
      if (e.type === 'test_run') {
        what = p?.exit_code === 0 ? 'test run PASSED' : 'test run FAILED';
      } else if (e.type === 'edit' || e.type === 'file_save' || e.type === 'file_open') {
        what = `${e.type} ${alias(String(p?.path ?? ''))}`;
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
    TARGET_NOTE: ctx.targetNote ?? '(no history yet — first sessions)',
    ELAPSED_MIN: String(Math.round(ctx.elapsedMs / 60_000)),
    REMAINING_MIN: String(Math.max(0, Math.round(ctx.remainingMs / 60_000))),
    RECENT_ACTIVITY: ctx.recentActivity,
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
    return guard(parseTurn(raw), ctx.bugFile, ctx.candidateMessage !== null, Boolean(ctx.targetNote));
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
      const client = new Anthropic();
      const stream = client.messages.stream({
        model,
        max_tokens: 400,
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: turn }],
      });
      const msg = await stream.finalMessage();
      const raw = msg.content
        .filter((b) => b.type === 'text')
        .map((b) => (b as { text: string }).text)
        .join('');
      return guard(parseTurn(raw), ctx.bugFile, ctx.candidateMessage !== null, Boolean(ctx.targetNote));
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

const INTENT_PROMPT = (text: string, spec: string) =>
  [
    'A candidate in a technical interview said the following while working:',
    '---',
    text,
    '---',
    'The problem spec (context): ' + spec.slice(0, 1500),
    '',
    'Was this ADDRESSED TO THE INTERVIEWER (a question or statement expecting a',
    'reply), as opposed to thinking aloud / narrating / muttering to themselves?',
    'When in doubt say no — interrupting someone mid-thought is worse than',
    'missing a question they will rephrase.',
    'Reply with ONLY the word "yes" or "no".',
  ].join('\n');

/** Intent check via the API (haiku, fast path). */
export function apiIntentCheck(): IntentCheck {
  return async (text, spec) => {
    try {
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      const client = new Anthropic();
      const msg = await client.messages.create({
        model: 'claude-haiku-4-5',
        max_tokens: 5,
        messages: [{ role: 'user', content: INTENT_PROMPT(text, spec) }],
      });
      const out = msg.content
        .filter((b) => b.type === 'text')
        .map((b) => (b as { text: string }).text)
        .join('')
        .toLowerCase();
      return out.includes('yes');
    } catch {
      return false; // fail toward silence, never toward interruption
    }
  };
}

/** Intent check via headless claude (no API key; slower, text-mode OK). */
export function claudePIntentCheck(): IntentCheck {
  return async (text, spec) => {
    const out = await runClaudeP(INTENT_PROMPT(text, spec), 'haiku', 20_000);
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
