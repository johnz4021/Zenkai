/**
 * Timeline renderer — what the judge reads.
 *
 *   trace events ──► renderTimeline() ──► one readable document
 *                        │
 *                        ├─ relative offsets (+MM:SS), actor attribution
 *                        ├─ reliability annotations INLINE (sensor-down
 *                        │  intervals, [nudge] markers)
 *                        └─ token ceiling with low-signal compression
 *
 * This file is a DERIVED artifact and is tested like one (outside-voice
 * finding: "whole trace, no derived facts" was an overclaim — ordering,
 * filtering, and attribution all encode assumptions). What it must never
 * do is render a VERDICT: no "went silent", no "edited before thinking".
 * Facts the judge could not infer (a dead sensor) are annotated; everything
 * else is presented raw. Pre-computing verdicts from partial views is where
 * every wrong finding in this product's history came from.
 *
 * Reliability annotations exist because absence of evidence is ambiguous:
 * a dead mic and genuine silence look identical in a bare timeline, and a
 * judge will confidently write "went quiet for two minutes" about a vendor
 * outage. The two-sensor semantics (presence vs stt) are spelled out in
 * the annotation text itself so the judge needs no side-channel knowledge.
 */

import type { SensorPayload, TraceEvent } from '@interview-prep/shared';

export const RENDERER_VERSION = 1;

/** Rough ceiling before low-signal compression kicks in (~chars/4). */
export const TOKEN_CEILING = 12_000;

// RAW SECONDS, deliberately not +M:SS. Live rejudge finding: shown "+1:51",
// the judge cited offset 151 (reading minutes:seconds as digits), every
// citation missed by 40s, and the verifier stripped honest evidence. The
// timeline is FOR the judge; the human-facing card formats its own clocks.
const fmt = (ms: number): string => `+${Math.max(0, Math.round(ms / 1000))}s`;

/** Down-intervals per sensor from `sensor` events (moved from classifier.ts). */
export function sensorDownIntervals(
  events: TraceEvent[],
  sensor: 'presence' | 'stt',
): { start: number; end: number }[] {
  const changes = events
    .filter((e) => e.type === 'sensor' && (e.payload as SensorPayload)?.sensor === sensor)
    .sort((a, b) => a.ts - b.ts);
  if (changes.length === 0) return [];
  const out: { start: number; end: number }[] = [];
  let downSince: number | null = null;
  for (const ev of changes) {
    const state = (ev.payload as SensorPayload).state;
    if (state === 'down' && downSince === null) downSince = ev.ts;
    if (state === 'up' && downSince !== null) {
      out.push({ start: downSince, end: ev.ts });
      downSince = null;
    }
  }
  if (downSince !== null) out.push({ start: downSince, end: Number.POSITIVE_INFINITY });
  return out;
}

interface Line {
  ts: number;
  text: string;
  /** Low-signal lines are compression candidates when over the ceiling. */
  lowSignal?: boolean;
}

function eventLine(e: TraceEvent, t0: number): Line | null {
  const p = (e.payload ?? {}) as Record<string, unknown>;
  const at = fmt(e.ts - t0);
  switch (e.type) {
    case 'session_start':
      return { ts: e.ts, text: `${at}  session started` };
    case 'session_end':
      return { ts: e.ts, text: `${at}  candidate clicked End Session` };
    case 'test_run': {
      const code = p.exit_code;
      const verdictText =
        code === 0 ? 'tests PASSED' : code == null ? 'test run did not complete' : 'tests FAILED';
      return { ts: e.ts, text: `${at}  ran tests — ${verdictText}` };
    }
    case 'edit':
      return {
        ts: e.ts,
        text: `${at}  edited ${shortPath(p.path)}`,
        lowSignal: true,
      };
    case 'file_save':
      return { ts: e.ts, text: `${at}  saved ${shortPath(p.path)}`, lowSignal: true };
    case 'file_open':
      return { ts: e.ts, text: `${at}  opened ${shortPath(p.path)}`, lowSignal: true };
    case 'command':
      return { ts: e.ts, text: `${at}  terminal: ${String(p.command ?? '')}` };
    case 'utterance': {
      const text = String(p.text ?? '').trim();
      if (!text) {
        // Presence heard sound; STT produced no words. This is ACTIVITY
        // (silence is disproven) with unknown content — say exactly that.
        return { ts: e.ts, text: `${at}  candidate: [spoke — transcription unavailable]` };
      }
      return { ts: e.ts, text: `${at}  candidate: "${text}"` };
    }
    case 'interviewer': {
      const nudge = p.nudge === true ? ' [NUDGE — this narrowed the search; what follows was prompted, not self-directed]' : '';
      return { ts: e.ts, text: `${at}  interviewer: "${String(p.text ?? '')}"${nudge}` };
    }
    case 'spec_mutation':
      return { ts: e.ts, text: `${at}  SPEC CHANGED: ${String(p.diff_summary ?? '')}` };
    case 'sensor':
      return null; // rendered as interval annotations, not lines
    case 'pause':
      return null; // legacy extension verdict; readable traces may carry it, ignored
    default:
      return null;
  }
}

const shortPath = (p: unknown): string => {
  const s = String(p ?? '');
  const parts = s.split('/');
  return parts.slice(-2).join('/') || s;
};

/** Event types that can only originate from the IDE extension. */
const IDE_EVENTS = new Set<string>([
  'file_open', 'file_save', 'edit', 'test_run', 'command',
]);

/**
 * True when the extension contributed nothing at all.
 *
 * A session wired to a dead trace socket looks EXACTLY like a candidate who
 * never opened a file or ran a test — and the judge, reading it at face
 * value, will confidently score implement and verify `weak` and write those
 * gaps into the memory layer. Silence from a broken instrument must never
 * read as evidence, so the timeline says so out loud and the judge marks
 * those dimensions unassessable instead.
 */
function ideDown(events: TraceEvent[]): boolean {
  return !events.some((e) => IDE_EVENTS.has(e.type));
}

export function renderTimeline(events: TraceEvent[]): string {
  if (events.length === 0) return '(empty session — no events recorded)';
  const sorted = [...events].sort((a, b) => a.ts - b.ts || a.seq - b.seq);
  const t0 = sorted[0]!.ts;
  const tEnd = sorted[sorted.length - 1]!.ts;

  const lines: Line[] = [];
  for (const e of sorted) {
    const line = eventLine(e, t0);
    if (line) lines.push(line);
  }

  // ---- reliability annotations, inserted at interval start positions ----
  const annotations: Line[] = [];
  for (const iv of sensorDownIntervals(sorted, 'presence')) {
    const end = Number.isFinite(iv.end) ? fmt(iv.end - t0) : 'end of session';
    annotations.push({
      ts: iv.start,
      text: `[EVIDENCE GAP ${fmt(iv.start - t0)}–${end}: microphone was OFF or unavailable. Nothing about speech — presence OR content — is knowable here. Silence in this stretch proves nothing.]`,
    });
  }
  for (const iv of sensorDownIntervals(sorted, 'stt')) {
    const end = Number.isFinite(iv.end) ? fmt(iv.end - t0) : 'end of session';
    annotations.push({
      ts: iv.start,
      text: `[EVIDENCE GAP ${fmt(iv.start - t0)}–${end}: transcription was DOWN but the mic could still detect speech. "[spoke — transcription unavailable]" lines here are real speech with lost words; judge WHETHER they spoke, never WHAT they said.]`,
    });
  }

  const merged = [...lines, ...annotations].sort((a, b) => a.ts - b.ts);

  // ---- token ceiling: compress runs of low-signal lines, oldest first ----
  let body = merged.map((l) => l.text).join('\n');
  let compressed = 0;
  if (body.length / 4 > TOKEN_CEILING) {
    const kept: Line[] = [];
    let run: Line[] = [];
    const flush = () => {
      if (run.length > 3) {
        const first = run[0]!;
        const last = run[run.length - 1]!;
        kept.push({
          ts: first.ts,
          text: `${fmt(first.ts - t0)}–${fmt(last.ts - t0)}  (${run.length} edits/saves/opens — compressed)`,
        });
        compressed += run.length;
      } else {
        kept.push(...run);
      }
      run = [];
    };
    for (const l of merged) {
      if (l.lowSignal) run.push(l);
      else {
        flush();
        kept.push(l);
      }
    }
    flush();
    body = kept.map((l) => l.text).join('\n');
  }

  const durationMin = Math.round((tEnd - t0) / 60_000);
  const header = [
    `SESSION TIMELINE (${durationMin} min, offsets from session start)`,
    compressed > 0 ? `NOTE: ${compressed} low-signal editor events were compressed into ranges to fit.` : null,
    ideDown(sorted)
      ? 'RELIABILITY: the editor sent NO events for this entire session — no file opens, ' +
        'edits, saves or test runs were recorded. This is instrument failure, not candidate ' +
        'behavior. Judge only what the speech shows; anything that would be evidenced by ' +
        'editor activity is unassessable.'
      : null,
    '',
  ]
    .filter((x): x is string => x !== null)
    .join('\n');

  return header + body;
}

/**
 * Resolve a judge-cited offset (seconds from session start) back to a trace
 * event. Used by the citation verifier and the quote-pulling renderer.
 * Tolerance is deliberately tight (±2s): "cite a specific moment" is a rule,
 * not a vibe — a sloppy citation that lands near an adjacent event must not
 * silently adopt it (outside-voice granularity finding).
 */
export function eventAtOffset(
  events: TraceEvent[],
  offsetSeconds: number,
  toleranceMs = 2_000,
  /** Restrict resolution to matching events. Live finding: a `sensor`
   *  bookkeeping event 0.1s nearer than the candidate's utterance
   *  photobombed a nearest-event lookup and got an honest citation
   *  stripped — resolve against the events that can BE evidence. */
  filter?: (e: TraceEvent) => boolean,
): TraceEvent | null {
  if (events.length === 0) return null;
  const t0 = Math.min(...events.map((e) => e.ts));
  const target = t0 + offsetSeconds * 1000;
  let best: TraceEvent | null = null;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const e of events) {
    if (filter && !filter(e)) continue;
    const d = Math.abs(e.ts - target);
    if (d < bestDist) {
      best = e;
      bestDist = d;
    }
  }
  return bestDist <= toleranceMs ? best : null;
}
