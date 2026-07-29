/**
 * Feedback card data (design review D1/D2/D3).
 *
 *   classification + graph view ──► FeedbackCard JSON ──► chrome renders rows
 *
 * D1: before PATTERN_MIN_SESSIONS, findings are "observations", framed as a
 *     first data point with an explicit sessions-until-patterns count.
 * D2: utility copy only. Every string states what was observed, never mood.
 * D3: remediation leads the card when it happened.
 *
 * Evidence citations are the two-line form the design review locked (borrowed
 * from mockup variant A): trigger line, evidence line, elapsed delta.
 */

import type { Classification } from './classifier.js';
import type { GraphView } from './gap-graph.js';
import { GAP_DESCRIPTIONS } from './gap-graph.js';

export interface CitationLine {
  ts: number;
  clock: string;
  what: string;
}

export interface FeedbackFinding {
  label: string;
  description: string;
  citation: CitationLine[];
  delta_ms: number | null;
  /** Shown, but excluded from the gap graph: the interviewer prompted it. */
  contaminated: boolean;
}

export interface FeedbackCard {
  session_id: string;
  mode: 'observations' | 'patterns'; // D1
  sessions_until_patterns: number;
  newly_closed: { key: string; description: string; fired_count: number }[]; // D3 — leads
  findings: FeedbackFinding[];
  focus: { key: string; description: string } | null;
  trigger_occurred: boolean;
}

const clock = (ts: number): string => {
  const d = new Date(ts);
  const p = (x: number) => String(x).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

export function buildFeedback(
  sessionId: string,
  classification: Classification,
  graph: GraphView,
): FeedbackCard {
  // The candidate's own words at the cited moment. The hardest part of
  // behavior feedback is disbelief — a paraphrase is arguable, a quote of
  // yourself is not (CEO review D3.1). Looked up by (source, seq) in the
  // window; untranscribed segments have no words to quote.
  const quoteFor = (ref: { source: string; seq: number }): string | null => {
    const ev = classification.windowEvents.find(
      (e) => e.type === 'utterance' && e.source === ref.source && e.seq === ref.seq,
    );
    const text = String((ev?.payload as { text?: string } | undefined)?.text ?? '').trim();
    return text ? `"${text}"` : null;
  };

  const findings: FeedbackFinding[] = classification.labels.map((l) => {
    const lines: CitationLine[] = [];
    if (classification.trigger) {
      lines.push({
        ts: classification.trigger.ts,
        clock: clock(classification.trigger.ts),
        what: 'test run failed',
      });
    }
    const first = l.evidence[0];
    if (first) {
      const quote = quoteFor(first);
      lines.push({ ts: first.ts, clock: clock(first.ts), what: quote ?? first.note });
    }
    const delta =
      classification.trigger && first ? first.ts - classification.trigger.ts : null;
    return {
      label: l.label,
      description: GAP_DESCRIPTIONS[l.label] ?? l.label.replace(/_/g, ' '),
      citation: lines,
      delta_ms: delta,
      contaminated: Boolean(l.contaminated),
    };
  });

  return {
    session_id: sessionId,
    mode: graph.session_count < 3 ? 'observations' : 'patterns',
    sessions_until_patterns: graph.sessions_until_patterns,
    newly_closed: graph.newly_closed.map((key) => ({
      key,
      description: GAP_DESCRIPTIONS[key] ?? key,
      fired_count: graph.active.concat(graph.closed).find((g) => g.key === key)?.fired_count ?? 0,
    })),
    findings,
    focus: graph.focus
      ? { key: graph.focus, description: GAP_DESCRIPTIONS[graph.focus] ?? graph.focus }
      : null,
    trigger_occurred: classification.trigger_occurred,
  };
}
