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
import { isCandidateActivity } from '@interview-prep/shared';
import { ANSWERABLE, SURRENDER, roundRules, timeRules } from './round-rules.js';

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

/**
 * Does the problem SPEC itself name the bug file? Then its name is public —
 * the candidate reads it in the statement — and the guard's basename/stem
 * checks would censor the spec's own vocabulary. Found live on a
 * single-file round: the spec opened with "`hydrator.py` is what an
 * analysis session runs…", the bug was in hydrator.py, and every opening
 * turn that framed the task was silently redacted. In a single-file
 * problem the "location" carries zero information anyway.
 */
export function specNamesBugFile(spec: string, bugFile: string): boolean {
  if (!bugFile || !spec) return false;
  const base = bugFile.split('/').pop() ?? bugFile;
  const stem = base.replace(/\.[^.]+$/, '');
  const hay = spec.toLowerCase();
  if (hay.includes(base.toLowerCase())) return true;
  return stem.length > 3 && new RegExp(`\\b${escapeRe(stem)}\\b`, 'i').test(spec);
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
   * The round's mechanics — surface, starts_from, submit mode, part count —
   * stated as facts the model may rely on. The axes existed only in code
   * until QA 2026-08-14 found prompt rules assuming iteration on one-shot
   * rounds and nothing naming the review round's written deliverable.
   * Session-constant → cached half.
   */
  mechanics?: string;
  /**
   * buildTargetNote() output — the candidate's gap history as generator/
   * interviewer emphasis. Shapes WHERE pressure lands; must never be
   * mentioned (the prompt enforces it, guardGapLeak backstops it).
   */
  targetNote?: string;
  elapsedMs: number;
  /** Milliseconds left, or `null` on an UNTIMED round (the DEFAULT_SPEC
   *  shape). Null is not "unknown" and not "zero" — it means there is no
   *  deadline, and render() turns it into a positive statement rather than
   *  a number. Defaulting it to a nominal length is what put "you've got
   *  45 minutes" into an untimed round's opening turn
   *  (sess-qa813-panesint-b). */
  remainingMs: number | null;
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
  /**
   * Whether `bug` is genuine private answer knowledge (a planted defect) or
   * the explicit no-knowledge statement. Arms the vocabulary guard: stemming
   * the no-knowledge text into `forbidden` would ban its own ordinary words
   * from scaffolding turns while guarding nothing (the old sentinel banned
   * "plant", "round" and "type" — QA 2026-08-14). Defaults to true so
   * existing call sites keep today's behavior.
   */
  hasAnswerKnowledge?: boolean;
  /**
   * Never-name locations beyond `bugFile`, with per-file found-territory
   * state — a review round plants defects across several files. Session-
   * derived (files the grading key's description names), per-turn (visited
   * changes as they work).
   */
  protectedExtras?: { file: string; visited: boolean }[];
  /** The problem's six rubric dimension expectations, rendered as a list.
   *  Per-session constant (stable half, cacheable). The judge always had
   *  these; the interviewer probing blind to them was the rubric-blind
   *  finding — one dimension literally graded a question "to the
   *  interviewer" it never knew to expect. */
  rubric?: string;
  /** The blueprint's "## Interviewer engagement" section (or a per-check
   *  default): how led this round is, what to reward. Stable half. */
  engagement?: string;
  /** Set when a moments.ts detection fired: the observation text for the
   *  per-turn half. The opening does NOT ride this slot (its wrapper says
   *  "follow the moment rules" — kind probe/nudge true — contradicting the
   *  OPENING rule's kind answer/nudge false; QA 2026-08-14 audit). */
  momentObservation?: string | null;
  /** Set exactly once, on candidate arrival: the opening instruction. Its
   *  own slot so it renders under the OPENING rule, never the moment
   *  wrapper. */
  openingObservation?: string | null;
  /**
   * describeAdrift() output: they have been reading one region for a long
   * time with nothing moving, and the region is verifiably NOT where the
   * answer lives. Fires the REDIRECT rules (close the dead end). Never both
   * with stuckObservation — the tick picks one.
   */
  adriftObservation?: string | null;
  /**
   * describeWarm() output: same confinement, but the answer is IN the region
   * with them. Its own slot on purpose — it used to ride `adriftObservation`,
   * where the prompt's adrift rules instructed "say plainly that it looks
   * sound — that region is not where the fault is": a direct order to push
   * the candidate off the bug in the one case the detector exists to invert
   * (QA 2026-08-14 audit).
   */
  warmObservation?: string | null;
  /** The round's check kind — selects the per-kind prompt blocks
   *  (round-rules.ts). Absent = one_failing_test, the legacy resolution. */
  checkKind?: string;
  /** codebaseViewOf() output: repo map + the failing test verbatim.
   *  Session-constant by construction (computed once at start) → stable
   *  half. The interviewer had never seen a line of the problem it was
   *  probing; this is the fix, bounded. */
  codebase?: string;
  /** renderAgenda() output: which evaluation dimensions still lack
   *  evidence. PER-TURN (it changes as evidence accumulates) — the running
   *  to-do list that makes unprompted probes purposeful instead of generic. */
  agenda?: string;
  /** renderWrapState() output while the wrap-up phase is active: which
   *  evaluation question is next, or the closing instruction. PER-TURN. */
  wrapState?: string;
  /** Set on an engagement turn: candidateMessage is thinking-aloud the
   *  intent gate flagged as a completed substantive thought, NOT a question
   *  to answer. The ENGAGE prompt rules apply — react briefly to the
   *  content, or stay silent. */
  narrationEngage?: boolean;
  /** questionStreak() at dispatch, when it tripped the governor: the last
   *  N turns all asked. The {{QUESTION_BUDGET}} slot orders this turn to
   *  give, not ask. Never set on wrap turns — their job is questions. */
  questionStreak?: number;
}

export type Interviewer = (ctx: InterviewerContext) => Promise<InterviewerTurn>;

/**
 * Is this utterance ADDRESSED to the interviewer, narration worth ENGAGING
 * with, or narration to let pass?
 *
 * Runs OUTSIDE the interviewer busy-lock, on every utterance the moment it
 * lands (eng review issue 1): classification is per-utterance and cheap;
 * replying is serialized and expensive. Narration therefore never contends
 * for the reply lock and never delays a real question behind it.
 *
 * Bias: default NOT addressed. A missed question costs a rephrase; a false
 * reply interrupts the candidate mid-thought, which is the one thing worse
 * than any latency number.
 *
 * 'engage' exists because the binary verdict made the interviewer deaf to
 * content (sess-1786861469215): the candidate stated a complete hypothesis
 * — "it's a string comparison, whereas commonpath checks actual paths" —
 * and the only response channel for it was a canned "Mm-hm". A real
 * interviewer reacts to a completed thought. The verdict only marks the
 * opportunity; session.ts paces whether it becomes a turn (cooldowns,
 * never mid-reply), and the turn itself may still choose silence.
 */
export type IntentVerdict = 'addressed' | 'engage' | 'silent';

export type IntentCheck = (
  text: string,
  spec: string,
  /** The last few turns, oldest first — a question split across breaths
   *  ("So I'm thinking... / ...can you tell me if that's right?") is
   *  unreadable as a lone fragment. */
  recent?: { who: 'candidate' | 'interviewer'; text: string }[],
) => Promise<IntentVerdict>;

/** Governor trip point: this many consecutive question-ended turns and
 *  the next one is ordered to give, not ask. */
export const QUESTION_STREAK_LIMIT = 2;

/**
 * How many consecutive recent interviewer turns asked a question. The
 * question-density governor's mechanical half (2026-08-17 review): in
 * sess-1786948725100 ten of twelve turns ended in '?', and every one
 * re-armed the pending-answer window — an interrogation loop no prompt
 * rule alone can stop, because one leaked question restarts it. Acks and
 * time announcements neither ask nor break the streak (content-free by
 * design — the addressing.ts precedent). Pure over the trace.
 */
export function questionStreak(events: TraceEvent[]): number {
  let streak = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type !== 'interviewer') continue;
    const p = e.payload as { kind?: string; text?: string } | null;
    if (p?.kind === 'ack' || p?.kind === 'time') continue;
    if (String(p?.text ?? '').includes('?')) streak += 1;
    else break;
  }
  return streak;
}

/** The model replies with one word; anything unrecognized is 'silent' —
 *  the same fail-toward-silence bias as the binary gate. Pure, exported
 *  for tests and for the claude -p path. */
export function parseIntentVerdict(raw: string): IntentVerdict {
  const out = raw.toLowerCase();
  if (out.includes('engage')) return 'engage';
  if (out.includes('yes')) return 'addressed';
  return 'silent';
}

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

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

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
 *
 * DO NOT re-propose arming this (or an allowlist variant) on decline/reply
 * turns without new evidence. Measured against the six real declines in
 * traces/sess-qa814-leak.jsonl (2026-08-14): 1-in-6 precision — it flags
 * "assertion", "eligible", "scenario", "ruled", "mechanism" as leaks, and
 * the whitelist that would save those IS the abstract interviewer register
 * ("boundary", "ordering", "edge case") the check exists to catch. It is
 * also structurally blind to coined synonyms: "boundary minute" appears in
 * neither the bug text nor the spec, so the stem intersection cannot see
 * it. Those leak shapes are prompt rules ("A refusal must not re-frame the
 * question") plus the widened nudge definition, not a mechanical guard.
 * Named trigger to revisit: a leak shape that survives the prompt rules AND
 * is mechanically separable from the interviewer register.
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
 *
 * Related but prompt-enforced only: the quote-only-opened-files rule (the
 * interviewer now sees the repo map and failing test up front, and may
 * discuss content only from files the candidate has opened). No mechanical
 * layer here — quoting unvisited NON-bug files is a taste violation, not a
 * leak, and this guard stays surgical about actual leaks.
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
  /** Additional never-name locations beyond the primary — a review round
   *  plants several defects across several files, and a single-string
   *  `bugFile` could only guard one of them (QA 2026-08-14: rep-mst39p35's
   *  rollup.py held a planted BLOCKER and was unguarded by design). Each
   *  entry carries its own found-territory relaxation. */
  extraProtected: { file: string; visited: boolean }[] = [],
): InterviewerTurn {
  if (!turn.say) return turn;
  const bugLeak =
    (!bugFileVisited && leaksBugLocation(turn.say, bugFile)) ||
    extraProtected.some((p) => !p.visited && leaksBugLocation(turn.say, p.file));
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
  // isCandidateActivity is the filter, at last with a consumer: the old
  // "everything but chat" filter let voice-sensor flips flood the window —
  // measured live, 9 of the 10 lines the interviewer saw were the literal
  // word "sensor" and the candidate's file opens had been evicted (it then
  // asked which file they were in, with the answer sitting in the trace).
  // utterances live in the transcript slot; view_range coalesces into the
  // workspace view's "currently viewing" line — repeating either here would
  // just re-crowd the window.
  const recent = events
    .filter((e) => isCandidateActivity(e) && e.type !== 'utterance' && e.type !== 'view_range')
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
      } else if (e.type === 'edit' || e.type === 'file_save') {
        what = `${e.type} ${basename(String(p?.path ?? ''))}`;
      } else if (e.type === 'file_open') {
        const via = (p as { via?: string } | null)?.via;
        what = `${via === 'focus' ? 'switched to' : 'opened'} ${basename(String(p?.path ?? ''))}`;
      }
      return `  -${ago}s  ${what}`;
    })
    .join('\n');
}

/**
 * The conversation window for the prompt: last `limit` REAL lines.
 *
 * Untranscribed utterances (voice segments STT heard nothing in) used to
 * render as empty `candidate:` lines and consume transcript slots — 3 of 10
 * in one measured session. They are dropped from the window but collapsed
 * into one honest count line, because the opposite failure is worse: speech
 * the interviewer reads as silence.
 */
export function buildTranscript(
  events: TraceEvent[],
  limit = 10,
): { who: 'candidate' | 'interviewer'; text: string }[] {
  const talk = events.filter((e) => e.type === 'utterance' || e.type === 'interviewer');
  const textOf = (e: TraceEvent) => String((e.payload as { text?: string })?.text ?? '').trim();
  const spoken = talk.filter((e) => textOf(e) !== '');
  const kept = spoken.slice(-limit);
  // Count unheard segments inside the rendered window (or all of them when
  // nothing transcribed at all) — older ones are stale, not signal.
  const sinceTs = kept[0]?.ts ?? 0;
  const unheard = talk.filter(
    (e) => e.type === 'utterance' && e.ts >= sinceTs && textOf(e) === '',
  ).length;
  const out = kept.map((e) => ({
    who: e.type === 'utterance' ? ('candidate' as const) : ('interviewer' as const),
    text: textOf(e),
  }));
  if (unheard > 0) {
    out.push({
      who: 'candidate',
      text: `(spoke ${unheard} more time${unheard === 1 ? '' : 's'} in this window, but the words could not be transcribed)`,
    });
  }
  return out;
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
  const rules = roundRules(ctx.checkKind);
  const values: Record<string, string> = {
    SPEC: ctx.spec,
    BUG: ctx.bug,
    ROUND_INTRO: rules.intro,
    ANSWER_RULES: rules.answerRules,
    READING_LIMIT: rules.readingLimit,
    STUCK_FORBIDDEN: rules.stuckForbidden,
    FEEDBACK_RULES: rules.feedbackRules,
    ADRIFT_RULED_OUT: rules.adriftRuledOut,
    ANSWERABLE,
    SURRENDER,
    CODEBASE: ctx.codebase ?? '(no codebase view available for this round)',
    HOW_TO_RUN: ctx.howToRun ?? 'Not known for this round — say you are not sure if asked.',
    ROUND_MECHANICS: ctx.mechanics ?? '(no mechanics notes for this round)',
    TARGET_NOTE: ctx.targetNote ?? '(no history yet — first sessions)',
    RUBRIC: ctx.rubric ?? '(no rubric available for this round)',
    ENGAGEMENT: ctx.engagement ?? 'Balanced: probe at the flagged moments, otherwise let them work.',
    WORKSPACE_VIEW: ctx.workspaceView ?? '(no edits yet this session)',
    MOMENT: ctx.momentObservation
      ? `MOMENT — ${ctx.momentObservation} Follow the moment rules above: one focused probe about it, then release.`
      : 'no',
    OPENING: ctx.openingObservation
      ? `OPENING — ${ctx.openingObservation} Follow the OPENING rule above: kind "answer", nudge false.`
      : 'no',
    ELAPSED_MIN: String(Math.round(ctx.elapsedMs / 60_000)),
    // Timedness is per-SESSION constant (capabilities.time_limit_ms is read
    // once from a frozen spec), so TIME_RULES sits in the CACHED half and the
    // renderSplit byte-identity contract holds as the clock ticks.
    TIME_RULES: timeRules(ctx.remainingMs !== null),
    // One token, one meaning. `REMAINING_MIN` is gone on purpose: a bare
    // number slot can only ever render a number, and on an untimed round
    // every number is a lie — 0 included, which reads as "time is up".
    REMAINING:
      ctx.remainingMs === null
        ? 'Remaining: UNTIMED — this round has no time limit and no deadline. Nothing is counting down.'
        : `Remaining: ${Math.max(0, Math.round(ctx.remainingMs / 60_000))} min.`,
    RECENT_ACTIVITY: ctx.recentActivity,
    ADRIFT: ctx.adriftObservation
      ? `ADRIFT — ${ctx.adriftObservation} Follow the adrift rules above: one move, nudge true.`
      : 'no',
    WARM: ctx.warmObservation
      ? `WARM — ${ctx.warmObservation} Follow the warm rules above: encourage, never redirect, nudge true.`
      : 'no',
    AGENDA:
      ctx.agenda ??
      '(none this turn — this is a reply; answer what was asked. The agenda rides unprompted turns.)',
    WRAPUP: ctx.wrapState ?? 'no — the working phase is still on.',
    ENGAGE: ctx.narrationEngage
      ? 'ENGAGE — the message below was NOT addressed to you; they are thinking aloud and just completed a substantive thought. Follow the engage rules above: one brief reaction to its content, or silence.'
      : 'no',
    QUESTION_BUDGET: ctx.questionStreak
      ? `SPENT — you have ended your last ${ctx.questionStreak} turns with questions. This turn: answer, observe, or confirm — and STOP. Do not ask anything. A run of questions stops being an interview and becomes an interrogation.`
      : 'available.',
    STUCK: ctx.stuckObservation
      ? `STUCK — ${ctx.stuckObservation} Follow the stuck rules above: one move, their vocabulary only, nudge true.`
      : 'no',
    TRANSCRIPT: transcript,
    CANDIDATE_MESSAGE:
      ctx.candidateMessage !== null && ctx.candidateMessage !== undefined
        ? ctx.narrationEngage
          ? `${ctx.candidateMessage}\n(thinking aloud — not addressed to you; see the Engage state above)`
          : ctx.candidateMessage
        : '(nothing — this is an unprompted turn. Apply pressure or probe their ' +
          'reasoning, or stay silent with an empty `say` if there is genuinely ' +
          'nothing worth saying.)',
  };
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (whole, key: string) =>
    key in values ? (values[key] as string) : whole,
  );
}

/** The guard inputs for a SCAFFOLDING turn (stuck or adrift), or undefined on
 *  ordinary turns. Forbidden = the private bug knowledge; allowed = everything
 *  the candidate already has (spec, the failing test's name via allowedExtra,
 *  their own words). The candidate's own words matter most on an adrift turn:
 *  the redirect names their region back to them, so their vocabulary is
 *  exactly what it must be free to use. Exported so tests exercise the exact
 *  composition the runtime uses. */
export function stuckVocabOf(
  ctx: InterviewerContext,
): { forbidden: string; allowed: string } | undefined {
  if (!ctx.stuckObservation && !ctx.adriftObservation && !ctx.warmObservation) return undefined;
  // No answer knowledge → nothing to guard, and stemming the no-knowledge
  // statement into `forbidden` bans its own ordinary words ("plant",
  // "round", "type" under the old sentinel) from the one lane this module
  // exists to serve.
  if (ctx.hasAnswerKnowledge === false) return undefined;
  const candidateWords = ctx.transcript
    .filter((t) => t.who === 'candidate')
    .map((t) => t.text)
    .join('\n');
  return {
    forbidden: `${ctx.bug}\n${ctx.bugFile}`,
    allowed: `${ctx.spec}\n${ctx.allowedExtra ?? ''}\n${candidateWords}`,
  };
}

/** Extra never-name locations with the same publicness relaxations the
 *  primary gets (found territory, spec-named). Shared by both model paths so
 *  the two guard calls cannot drift. */
export function protectionOf(ctx: InterviewerContext): { file: string; visited: boolean }[] {
  return (ctx.protectedExtras ?? []).map((p) => ({
    file: p.file,
    visited: p.visited || specNamesBugFile(ctx.spec, p.file),
  }));
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
    return guard(parseTurn(raw), ctx.bugFile, ctx.candidateMessage !== null, Boolean(ctx.targetNote), stuckVocabOf(ctx), (ctx.bugFileVisited ?? false) || specNamesBugFile(ctx.spec, ctx.bugFile), protectionOf(ctx));
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
      return guard(parseTurn(raw), ctx.bugFile, ctx.candidateMessage !== null, Boolean(ctx.targetNote), stuckVocabOf(ctx), (ctx.bugFileVisited ?? false) || specNamesBugFile(ctx.spec, ctx.bugFile), protectionOf(ctx));
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
    'Decide whether their LATEST utterance is addressed to the interviewer,',
    'is thinking-aloud worth a brief reaction, or should pass in silence.',
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
    '- the interviewer\'s MOST RECENT turn above asked a question or gave a',
    '  directive, and this utterance ANSWERS it — a bare "yes" or "no"',
    '  counts. But a filler or false start alone ("Um...", "Uh, okay...")',
    '  is NOT an answer even right after a question — the answer is coming;',
    '  wait for it. And an utterance that ignores the question and returns',
    '  to working ("okay, so if I loop here...") is thinking aloud again —',
    '  the question does not convert everything said after it.',
    '',
    'NOT ADDRESSED (answer no) — thinking out loud:',
    '- a RHETORICAL SELF-QUESTION they are working through themselves',
    '  ("why is this null?", "wait, did I miss something?", "is this even',
    '  the right file?") — interrogative form, but they are reasoning, not',
    '  asking. This is the most common case; do not mistake it for an ask.',
    '- narrating what they read, suspect, or are about to try',
    '- filler, false starts, swearing, or asides to no one',
    '',
    'ENGAGE (answer engage) — not addressed to the interviewer, but a',
    'COMPLETED substantive thought a human interviewer sitting there would',
    'naturally react to:',
    '- they just stated a theory or conclusion about the cause ("so it must',
    '  be comparing strings, not path segments")',
    '- they made a substantive claim about how something works',
    '- they announced a result or milestone ("all passing", "that fixed it")',
    '- they committed out loud to a direction ("I\'m going to rewrite the',
    '  check to use commonpath")',
    'ONLY when THIS utterance completes the thought. Fragments, false',
    'starts, mid-sentence trailing off, and play-by-play of mechanical',
    'actions ("opening the file", "let me run this") are "no", never',
    '"engage". When torn between engage and no, answer no.',
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
    'Reply with ONLY one word: "yes", "engage", or "no".',
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
        .join('');
      return parseIntentVerdict(out);
    } catch (e) {
      // Fail toward silence, never toward interruption — but NEVER silently.
      // First judge-era live session: every utterance (including "Yo,
      // interviewer, can you give me a hand?") came back narration, and this
      // catch ate whatever went wrong, leaving nothing to diagnose. The
      // all-false fallback pathology banned in the judge was alive here.
      // RETHROWN (not resolved false) since QA 2026-08-14: resolving false
      // made an auth outage indistinguishable from a genuine narration
      // judgment at the routing layer, so the session could never surface
      // interviewer health to the candidate. routeUtterance's catch keeps
      // the fail-toward-silence behavior AND marks the fault for the chip.
      console.warn('[intent] API check ERRORED (utterance stays unrouted):', String(e).slice(0, 200));
      throw e instanceof Error ? e : new Error(String(e));
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
    return parseIntentVerdict(out);
  };
}

export function pickIntentCheck(): IntentCheck {
  return process.env.ANTHROPIC_API_KEY ? apiIntentCheck() : claudePIntentCheck();
}

/** Build the guarded context fields from a problem manifest.
 *  @deprecated interviewerGroundTruth is the per-kind replacement — this
 *  degraded every non-debugging round to a self-contradicting sentinel
 *  ("(no planted bug for this round type)" under a heading asserting
 *  private knowledge) and wrapped review rounds' multi-defect key in a
 *  debugging-shaped "It breaks exactly one test" sentence. Kept only for
 *  its tests until they migrate. */
export function bugContext(problem: GeneratedProblem): { bug: string; bugFile: string } {
  const b = problem.planted_bug;
  if (!b) return { bug: '(no planted bug for this round type)', bugFile: '' };
  return {
    bug: `File: ${b.file} (line ${b.line})\n${b.description}\nIt breaks exactly one test: "${b.failing_test}".`,
    bugFile: b.file,
  };
}

/**
 * Per-kind ground truth for the {{BUG}} slot — the interviewer-side
 * analogue of the judge's groundTruth(), which generalized long ago while
 * this side kept the debugging shape (QA 2026-08-14):
 *
 *  - no planted bug (all_failing, all_passing, and legacy shapes): the old
 *    sentinel rendered "(no planted bug for this round type)" directly under
 *    "## What you know that they do not", followed by answer rules asserting
 *    "You know what the planted defects are". Now the slot says plainly that
 *    there is NO private answer knowledge and not to pretend otherwise.
 *  - diff_present with a planted key (the real generated shape —
 *    rep-mst39p35 carries all four defects, severities, files and lines in
 *    planted_bug.description): the old text wrapped that key in "It breaks
 *    exactly one test: (none — …)". Now it is framed as the review's grading
 *    key, and hasAnswerKnowledge arms the guards for it.
 *  - one_failing_test: byte-identical to the original debugging text.
 *
 * `hasAnswerKnowledge` drives the vocabulary guard: stemming the no-bug
 * sentinel into `forbidden` used to ban the words "plant", "round" and
 * "type" from stuck/adrift turns ("You're 20 minutes into this round" —
 * silenced) while guarding nothing.
 */
export function interviewerGroundTruth(
  problem: Pick<GeneratedProblem, 'planted_bug'>,
  checkKind: string | undefined,
): { bug: string; bugFile: string; hasAnswerKnowledge: boolean } {
  const b = problem.planted_bug;
  if (!b) {
    return {
      bug:
        'You have NO private answer knowledge in this round — there is no planted ' +
        'defect and no hidden solution. Do not imply you know the answer, a ' +
        'location, or an approach. Your only edge over the candidate is the spec, ' +
        'the suite, and visibility into their work.',
      bugFile: '',
      hasAnswerKnowledge: false,
    };
  }
  if (checkKind === 'diff_present') {
    return {
      bug:
        `The diff under review contains planted defects, and you hold the grading ` +
        `key (PRIVATE — the candidate finds and writes these up themselves):\n` +
        `${b.description}\n` +
        `Primary location: ${b.file}${typeof b.line === 'number' ? ` (line ${b.line})` : ''}.`,
      bugFile: b.file,
      hasAnswerKnowledge: true,
    };
  }
  return {
    bug: `File: ${b.file} (line ${b.line})\n${b.description}\nIt breaks exactly one test: "${b.failing_test}".`,
    bugFile: b.file,
    hasAnswerKnowledge: true,
  };
}
