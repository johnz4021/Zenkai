/**
 * Feedback card data (design review D1/D2/D3 + judge design 2026-07-30).
 *
 *   assessment + graph view + trace ──► AssessmentCard ──► chrome renders
 *
 * Three DISTINCT states, never collapsed (outside-voice finding: collapsing
 * any pair reads as success):
 *   - assessed:      per-dimension rows
 *   - unassessable:  a per-dimension state WITH its reason on the row
 *   - unassessed:    the judge failed; the card says so and offers rejudge
 *
 * Quotes are pulled by THIS renderer from the trace via the judge's
 * citations — the judge never writes quoted text, so a fabricated quote is
 * structurally impossible. A row whose citations were all stripped renders
 * its verdict labeled as unreceipted.
 *
 * Bug disclosure (tension 2): the judge always KNOWS the bug; the card
 * discusses it freely when solved, and holds it behind a "show me the bug"
 * toggle when not — so a problem you didn't crack stays re-runnable.
 */

import type { TraceEvent, Verdict } from '@interview-prep/shared';
import { isCandidateEvent, type Assessment, type JudgeResult } from './judge.js';
import { eventAtOffset, isPhantomUtterance, sensorDownIntervals } from './timeline.js';
import { PATTERN_MIN_SESSIONS, gapDescription, type GraphView } from './gap-graph.js';

/**
 * Confirm-file semantics shared by BOTH servers (WU-C): the session card and
 * the app history card write the same assessments/<sid>.confirm.json, and
 * promote-fixture depends on this exact Record<string, boolean> shape —
 * never widen it.
 */
export function mergeConfirm(
  existing: Record<string, boolean>,
  dimension: string,
  agree: boolean,
): Record<string, boolean> {
  return { ...existing, [dimension]: agree };
}

export interface Quote {
  clock: string; // +M:SS offset
  text: string;  // verbatim from the trace, never from the judge
}

export interface DimensionRow {
  dimension: string;
  verdict: Verdict;
  analysis: string;
  quotes: Quote[];
  /** Verdict survived but every citation was stripped — render as a claim
   *  without a receipt, visually distinct from evidenced rows. */
  unreceipted?: boolean;
}

export interface AssessmentCard {
  session_id: string;
  state: 'assessed' | 'unassessed';
  /** unassessed only: why, and that the trace is saved for rejudging. */
  reason?: string;
  mode: 'observations' | 'patterns'; // D1
  sessions_until_patterns: number;
  summary?: string;
  solved?: boolean;
  /** Present when a bug exists; the client gates rendering on `solved`. */
  bug?: { description: string };
  rows?: DimensionRow[];
  newly_closed: { key: string; description: string; fired_count: number }[]; // D3 — leads
  focus: { key: string; description: string } | null;
}

const fmtOffset = (seconds: number): string =>
  `+${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, '0')}`;

/** Verbatim text for a cited trace event. */
function quoteFor(
  events: TraceEvent[],
  offsetSeconds: number,
  sttDown: { start: number; end: number }[],
): Quote | null {
  // Same candidate-only, phantom-free resolution as the verifier, so the
  // quote shown is the event the citation was verified against. Without the
  // phantom exclusion, a gate-noise empty 0.1s nearer than the real cited
  // utterance would render "[spoke — transcription unavailable]" as the
  // receipt for words that were actually said.
  const e = eventAtOffset(
    events, offsetSeconds, 2_000,
    (x) => isCandidateEvent(x) && !isPhantomUtterance(x, sttDown),
  );
  if (!e) return null;
  const p = (e.payload ?? {}) as Record<string, unknown>;
  const clock = fmtOffset(offsetSeconds);
  switch (e.type) {
    case 'utterance': {
      const text = String(p.text ?? '').trim();
      return { clock, text: text ? `"${text}"` : '[spoke — transcription unavailable]' };
    }
    case 'edit':
    case 'file_save':
    case 'file_open': {
      const verb = e.type === 'edit' ? 'edited' : e.type === 'file_save' ? 'saved' : 'opened';
      const path = String(p.path ?? '').split('/').slice(-2).join('/');
      return { clock, text: `${verb} ${path}` };
    }
    case 'test_run':
      return { clock, text: p.exit_code === 0 ? 'ran tests — passed' : 'ran tests — failed' };
    case 'command':
      return { clock, text: `terminal: ${String(p.command ?? '')}` };
    case 'session_end':
      return { clock, text: 'ended the session' };
    default:
      return { clock, text: e.type };
  }
}

function graphBits(graph: GraphView) {
  return {
    mode: (graph.session_count < PATTERN_MIN_SESSIONS ? 'observations' : 'patterns') as
      | 'observations'
      | 'patterns',
    sessions_until_patterns: graph.sessions_until_patterns,
    newly_closed: graph.newly_closed.map((key) => ({
      key,
      description: gapDescription(key),
      fired_count:
        graph.active.concat(graph.closed).find((g) => g.key === key)?.fired_count ?? 0,
    })),
    focus: graph.focus ? { key: graph.focus, description: gapDescription(graph.focus) } : null,
  };
}

export function buildAssessmentCard(
  result: JudgeResult,
  graph: GraphView,
  events: TraceEvent[],
  bugDescription?: string,
): AssessmentCard {
  if (result.status === 'unassessed') {
    return {
      session_id: result.session_id,
      state: 'unassessed',
      reason: `Couldn't assess this session (${result.reason}). Your trace is saved — rejudge anytime.`,
      ...graphBits(graph),
    };
  }

  const a: Assessment = result;
  const sttDown = sensorDownIntervals(events, 'stt');
  const rows: DimensionRow[] = a.dimensions.map((d) => ({
    dimension: d.dimension,
    verdict: d.verdict,
    analysis: d.analysis,
    quotes: d.evidence
      .map((offset) => quoteFor(events, offset, sttDown))
      .filter((q): q is Quote => q !== null),
    ...(d.evidence_stripped ? { unreceipted: true } : {}),
  }));

  return {
    session_id: a.session_id,
    state: 'assessed',
    summary: a.summary,
    solved: a.solved,
    ...(bugDescription ? { bug: { description: bugDescription } } : {}),
    rows,
    ...graphBits(graph),
  };
}
