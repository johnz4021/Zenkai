import { describe, expect, it } from 'vitest';
import { DIMENSIONS } from '@interview-prep/shared';
import type { JudgeResult } from './judge.js';
import { buildVerdictHistory, sessionStartMs, type VerdictHistoryInput } from './verdict-history.js';

/**
 * Fixture codes, one char per dimension in DIMENSIONS order:
 *   w weak · a adequate · s strong · u unassessable · W weak with every
 *   citation stripped (unreceipted — informative arithmetic must skip it).
 */
function A(sid: string, judgedAt: number, hash: string, solved: boolean, codes: string): JudgeResult {
  return {
    session_id: sid,
    status: 'assessed',
    judged_at: judgedAt,
    model: 'test',
    prompt_hash: hash,
    schema_version: 1,
    renderer_version: 1,
    expectations_used: {} as never,
    solved,
    summary: 's',
    dimensions: [...codes].map((c, i) => ({
      dimension: DIMENSIONS[i]!,
      verdict: c === 'a' ? 'adequate' : c === 's' ? 'strong' : c === 'u' ? 'unassessable' : 'weak',
      analysis: `${DIMENSIONS[i]} in ${sid}`,
      evidence: c === 'u' || c === 'W' ? [] : [10],
      ...(c === 'W' ? { evidence_stripped: true } : {}),
    })),
  };
}

function input(over: Partial<VerdictHistoryInput> & Pick<VerdictHistoryInput, 'assessments'>): VerdictHistoryInput {
  const sids = over.assessments.map((a) => a.session_id);
  return {
    owners: Object.fromEntries(sids.map((s) => [s, undefined])),
    presentFeedback: new Set(sids),
    archivedIds: new Set(),
    userId: 'u1',
    legacyOwnerId: 'u1',
    isAdmin: false,
    nowMs: 2_000_000_000_000,
    ...over,
  };
}

/**
 * The real store, verbatim (2026-08-13): the ten eligible sessions'
 * per-dimension verdicts, in DIMENSIONS order (clarify approach communicate
 * implement verify reflect). Nine share one judge prompt_hash; the newest
 * carries another. This pins the arithmetic against the data the feature
 * shipped over — if the trend maths drifts, this fails.
 */
const REJUDGED = 1_760_000_000_000; // one batch-rejudge instant, deliberately identical
const REAL = [
  A('sess-1785444187708', REJUDGED, 'h1', false, 'wwauuu'),
  A('sess-1785461200029', REJUDGED, 'h1', false, 'wwwuuw'),
  A('sess-1785534051260', REJUDGED, 'h1', false, 'uuwwwu'),
  A('sess-1785713543008', REJUDGED, 'h1', false, 'uuuwwu'),
  A('sess-1785731479608', REJUDGED, 'h1', false, 'uwwuuu'),
  A('sess-1785962737985', REJUDGED, 'h1', true, 'wwwwaa'),
  A('sess-1786072934316', REJUDGED, 'h1', true, 'wwwwaw'),
  A('sess-1786082098943', 1_755_000_000_000, 'h1', false, 'uwwwww'), // never rejudged — EARLIER judged_at
  A('sess-1786220758002', REJUDGED, 'h1', true, 'wwWaaa'),
  A('sess-1786643587196', REJUDGED + 1, 'h2', false, 'awwwww'),
];

describe('buildVerdictHistory — the real-data pin', () => {
  const h = buildVerdictHistory(input({ assessments: [...REAL].reverse() }));

  it('orders by session start, never judged_at', () => {
    // 082098943 has the EARLIEST judged_at but is 8th by session start; the
    // batch-rejudged sessions all share one judged_at. Only sid-time ordering
    // produces this sequence.
    expect(h.sessions.map((s) => s.sid.slice(-6))).toEqual([
      '187708', '200029', '051260', '543008', '479608',
      '737985', '934316', '098943', '758002', '587196',
    ]);
  });

  it('pins the trend: 1/14 first half, 7/28 second half (unreceipted excluded)', () => {
    expect(h.trend).toEqual({
      first: { not_weak: 1, informative: 14 },
      second: { not_weak: 7, informative: 28 },
    });
  });

  it('counts 3 solved rounds, all in the second half', () => {
    expect(h.solved_count).toBe(3);
    expect(h.sessions.slice(0, 5).every((s) => s.solved === false)).toBe(true);
  });

  it('marks the judge-prompt boundary before the newest session', () => {
    expect(h.comparability_boundaries).toEqual([9]);
  });

  it('derives the states the Gaps band shows', () => {
    expect(h.states.communicate.state).toBe('still firing');
    expect(h.states.verify.state).toBe('improving');
    expect(h.states.verify.recent_not_weak).toBe(3); // "3 of last 5 adequate"
    expect(h.states.verify.recent_informative).toBe(5);
    expect(h.states.clarify.state).toBe('improving'); // first adequate, last round
  });

  it('treats a stripped weak as uninformative but still renders the row', () => {
    const s = h.sessions.find((x) => x.sid.endsWith('758002'))!;
    const co = s.rows.find((r) => r.dimension === 'communicate')!;
    expect(co.verdict).toBe('weak');
    expect(co.unreceipted).toBe(true);
  });

  it('carries the latest informative analysis as the receipt', () => {
    expect(h.states.clarify.latest_analysis).toBe('clarify in sess-1786643587196');
    // communicate's newest informative is 587196 (758002 was stripped)
    expect(h.states.communicate.latest_analysis).toBe('communicate in sess-1786643587196');
  });
});

describe('membership and ownership', () => {
  it('empty input → empty history', () => {
    const h = buildVerdictHistory(input({ assessments: [] }));
    expect(h.sessions).toEqual([]);
    expect(h.trend).toBeNull();
    expect(h.states.clarify.state).toBe('no signal');
  });

  it('UNASSESSED never becomes history', () => {
    const h = buildVerdictHistory(input({
      assessments: [
        { session_id: 'sess-1', status: 'unassessed', judged_at: 1, reason: 'x' },
        A('sess-2000000000000', 1, 'h', false, 'wwwwww'),
      ],
    }));
    expect(h.sessions).toHaveLength(1);
  });

  it('archived eras are excluded', () => {
    const h = buildVerdictHistory(input({
      assessments: REAL,
      archivedIds: new Set(['sess-1785444187708']),
    }));
    expect(h.sessions).toHaveLength(9);
  });

  it('a session with no feedback file is excluded and counted, never guessed', () => {
    const h = buildVerdictHistory(input({
      assessments: REAL,
      presentFeedback: new Set(REAL.map((a) => a.session_id).filter((s) => !s.endsWith('187708'))),
    }));
    expect(h.sessions).toHaveLength(9);
    expect(h.unattributable).toBe(1);
  });

  it('a feedback file without user_id belongs to the legacy owner (WU5)', () => {
    const one = [A('sess-2000000000000', 1, 'h', false, 'wwwwww')];
    const mine = buildVerdictHistory(input({ assessments: one }));
    expect(mine.sessions).toHaveLength(1);
    const stranger = buildVerdictHistory(input({ assessments: one, userId: 'u2' }));
    expect(stranger.sessions).toHaveLength(0);
  });

  it("another user's attributed session is invisible to a non-admin and visible to an admin", () => {
    const one = [A('sess-2000000000000', 1, 'h', false, 'wwwwww')];
    const owners = { 'sess-2000000000000': 'u9' };
    expect(buildVerdictHistory(input({ assessments: one, owners })).sessions).toHaveLength(0);
    expect(buildVerdictHistory(input({ assessments: one, owners, isAdmin: true })).sessions).toHaveLength(1);
  });
});

describe('sessionStartMs', () => {
  it('parses the sid timestamp and falls back on judged_at', () => {
    expect(sessionStartMs('sess-1785444187708', 5)).toBe(1_785_444_187_708);
    expect(sessionStartMs('qa-lc-1786575866000', 5)).toBe(1_786_575_866_000);
    expect(sessionStartMs('sess-abc', 5)).toBe(5);
  });
});
