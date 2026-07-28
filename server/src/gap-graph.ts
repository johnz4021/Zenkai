/**
 * Gap graph (eng review T11, design review D1/D3).
 *
 *   session classification ──► recordSession ──► gaps.json (per user)
 *                                                   │
 *              buildGraphView (weights, focus, closed) ──► feedback / UI
 *
 * Rules locked in review:
 *   - NEGATIVE labels (immediate_edit, inactivity) create gap instances;
 *     positive labels are observations, not gaps.
 *   - Recency weight: 0.5^(sessionsAgo / 5) — half-life of 5 sessions.
 *   - REMEDIATION (T11): a gap closes only after 3 consecutive sessions where
 *     the trigger condition OCCURRED and the gap did not fire. Sessions where
 *     the trigger never occurred prove nothing and must not count — that
 *     false positive corrupts persisted state.
 *   - D3: remediation is an EVENT (surfaced once) and then a record in a
 *     `closed` list. A closed gap that fires again reopens.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { SpecChangeLabel } from '@interview-prep/shared';

export const GAP_LABELS: readonly SpecChangeLabel[] = ['immediate_edit', 'inactivity'];
export const GAP_DESCRIPTIONS: Record<string, string> = {
  immediate_edit: 'Starts editing before reading the failure or asking about it.',
  inactivity: 'Goes quiet when something breaks instead of narrating or probing.',
};

export interface GapInstance {
  session_id: string;
  ts: number;
  evidence: { source: string; seq: number; ts: number; note: string }[];
}

export interface SessionRecord {
  session_id: string;
  ts: number;
  round_type: string;
  trigger_occurred: boolean;
  labels_fired: SpecChangeLabel[];
}

export interface GapStore {
  user_id: string;
  sessions: SessionRecord[];
  gaps: Record<string, { instances: GapInstance[]; closed_at?: number; closed_after?: string }>;
}

export interface GapView {
  key: string;
  description: string;
  fired_count: number;
  last_fired_ts: number | null;
  weight: number;
  state: 'rising' | 'stable' | 'fading';
  closed: boolean;
}

export interface GraphView {
  session_count: number;
  /** D1: below this, present findings as observations, not patterns. */
  sessions_until_patterns: number;
  active: GapView[];
  closed: GapView[];
  focus: string | null;
  /** D3: gaps that closed as a result of the MOST RECENT session — the event. */
  newly_closed: string[];
}

export const PATTERN_MIN_SESSIONS = 3;
const HALF_LIFE_SESSIONS = 5;
const REMEDIATION_STREAK = 3;

export function emptyStore(userId: string): GapStore {
  return { user_id: userId, sessions: [], gaps: {} };
}

export function recordSession(
  store: GapStore,
  record: SessionRecord,
  evidenceByLabel: Record<string, GapInstance['evidence']>,
): GapStore {
  const next: GapStore = JSON.parse(JSON.stringify(store)) as GapStore;
  next.sessions.push(record);

  for (const label of record.labels_fired) {
    if (!(GAP_LABELS as readonly string[]).includes(label)) continue;
    const gap = (next.gaps[label] ??= { instances: [] });
    gap.instances.push({
      session_id: record.session_id,
      ts: record.ts,
      evidence: evidenceByLabel[label] ?? [],
    });
    // Reopen on fire (D3): a closed gap that fires again is active history intact.
    delete gap.closed_at;
    delete gap.closed_after;
  }

  // Remediation check (T11). Only sessions where the trigger occurred count
  // toward the streak; trigger-less sessions are ignored entirely — they
  // neither advance nor reset it.
  const triggered = next.sessions.filter((s) => s.trigger_occurred);
  const recent = triggered.slice(-REMEDIATION_STREAK);
  for (const [key, gap] of Object.entries(next.gaps)) {
    if (gap.closed_at || gap.instances.length === 0) continue;
    if (recent.length < REMEDIATION_STREAK) continue;
    const streakClean = recent.every((s) => !s.labels_fired.includes(key as SpecChangeLabel));
    // The gap must have existed BEFORE the streak began, or "3 clean sessions"
    // is just "we never saw it" wearing a suit.
    const firstOfStreak = recent[0];
    const existedBefore = gap.instances.some((i) => i.ts < (firstOfStreak?.ts ?? 0));
    if (streakClean && existedBefore) {
      gap.closed_at = record.ts;
      gap.closed_after = record.session_id;
    }
  }
  return next;
}

export function buildGraphView(store: GapStore, lastSessionId?: string): GraphView {
  const sessionIndex = new Map(store.sessions.map((s, i) => [s.session_id, i]));
  const latest = store.sessions.length - 1;

  const views: GapView[] = Object.entries(store.gaps).map(([key, gap]) => {
    let weight = 0;
    for (const inst of gap.instances) {
      const idx = sessionIndex.get(inst.session_id) ?? latest;
      weight += Math.pow(0.5, (latest - idx) / HALF_LIFE_SESSIONS);
    }
    const last = gap.instances[gap.instances.length - 1] ?? null;
    const firedRecently = last && sessionIndex.get(last.session_id) === latest;
    const oldWeight = weight - (firedRecently ? 1 : 0);
    const state: GapView['state'] = firedRecently
      ? oldWeight > 0.6
        ? 'rising'
        : 'stable'
      : 'fading';
    return {
      key,
      description: GAP_DESCRIPTIONS[key] ?? key,
      fired_count: gap.instances.length,
      last_fired_ts: last?.ts ?? null,
      weight: Number(weight.toFixed(3)),
      state,
      closed: Boolean(gap.closed_at),
    };
  });

  const active = views.filter((v) => !v.closed).sort((a, b) => b.weight - a.weight);
  const closed = views.filter((v) => v.closed);
  const newly_closed = lastSessionId
    ? Object.entries(store.gaps)
        .filter(([, g]) => g.closed_after === lastSessionId)
        .map(([k]) => k)
    : [];

  return {
    session_count: store.sessions.length,
    sessions_until_patterns: Math.max(0, PATTERN_MIN_SESSIONS - store.sessions.length),
    active,
    closed,
    focus: active[0]?.key ?? null,
    newly_closed,
  };
}

// ---- persistence (JSON per user; SQLite when multi-user arrives) ----

export function loadStore(dir: string, userId: string): GapStore {
  const file = path.join(dir, `${userId}.json`);
  if (!existsSync(file)) return emptyStore(userId);
  return JSON.parse(readFileSync(file, 'utf8')) as GapStore;
}

export function saveStore(dir: string, store: GapStore): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${store.user_id}.json`), JSON.stringify(store, null, 2));
}
