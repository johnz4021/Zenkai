import { describe, expect, it } from 'vitest';
import type { Rubric, TraceEvent } from '@interview-prep/shared';
import { classify, extractWindow, findTrigger, mechanicalLabels } from './classifier.js';

const rubric: Rubric = {
  round_type: 'debugging',
  trigger: { event: 'test_run', predicate: 'first_failure' },
  // One debugging cycle: failure → next attempt, capped at 10 minutes.
  window: { until: 'test_run', min_duration_ms: 30_000, duration_ms: 600_000 },
  labels: ['clarifying_question', 'assumption_update', 'immediate_edit', 'test_run', 'inactivity'],
  expectation: 'reads the failure before editing',
};

/** The old fixed-duration shape, kept to prove both still work. */
const fixedWindowRubric: Rubric = { ...rubric, window: { duration_ms: 90_000 } };

let n = 0;
const ev = (type: TraceEvent['type'], ts: number, payload: unknown = null): TraceEvent => ({
  session_id: 's',
  user_id: 'u',
  source: 'extension',
  seq: n++,
  ts,
  type,
  payload,
});

const failedRun = (ts: number) => ev('test_run', ts, { via: 'task', exit_code: 1, duration_ms: 900 });
const greenRun = (ts: number) => ev('test_run', ts, { via: 'task', exit_code: 0, duration_ms: 900 });

const noJudge = async () => [];

describe('findTrigger (first_failure)', () => {
  it('skips green runs and picks the first failing one', () => {
    const events = [greenRun(1000), failedRun(5000), failedRun(9000)];
    expect(findTrigger(events, rubric)?.ts).toBe(5000);
  });

  it('returns null when the trigger never occurred — remediation must see this', () => {
    expect(findTrigger([greenRun(1000), ev('edit', 2000)], rubric)).toBeNull();
  });

  it('does not treat a null exit_code (never completed) as a failure', () => {
    const hung = ev('test_run', 1000, { via: 'task', exit_code: null, duration_ms: null });
    expect(findTrigger([hung], rubric)).toBeNull();
  });
});

describe('extractWindow', () => {
  it('bounds a fixed window by duration and excludes the trigger itself', () => {
    const t = failedRun(10_000);
    const inside = ev('edit', 50_000);
    const outside = ev('edit', 101_000);
    expect(extractWindow([t, inside, outside], fixedWindowRubric, t)).toEqual([inside]);
  });

  // REGRESSION (found by driving a real session in a browser): a genuine
  // clarifying question arrived 272s after the failing test and fell outside
  // the old 90s window, so the classifier could not see the good behavior it
  // exists to reward. One debugging cycle must include it.
  it('captures a clarifying question at +272s that the old 90s window missed', () => {
    const t = failedRun(0);
    const question = ev('utterance', 272_000, { text: 'is the deadline measured from now?' });
    expect(extractWindow([t, question], fixedWindowRubric, t)).toEqual([]);
    expect(extractWindow([t, question], rubric, t)).toEqual([question]);
  });

  it('closes the cycle on the next test run', () => {
    const t = failedRun(0);
    const edit = ev('edit', 60_000);
    const rerun = greenRun(120_000);
    const after = ev('edit', 200_000);
    const w = extractWindow([t, edit, rerun, after], rubric, t);
    expect(w).toEqual([edit, rerun]); // includes the closing attempt, excludes what follows
  });

  it('ignores an instant re-run inside min_duration_ms (re-reading the output)', () => {
    const t = failedRun(0);
    const peek = failedRun(5_000); // same failure, re-run just to look again
    const think = ev('utterance', 60_000, { text: 'why is the boundary excluded?' });
    const attempt = greenRun(200_000);
    const w = extractWindow([t, peek, think, attempt], rubric, t);
    expect(w.map((e) => e.type)).toEqual(['test_run', 'utterance', 'test_run']);
  });

  it('falls back to the hard cap when the cycle is never closed', () => {
    const t = failedRun(0);
    const inside = ev('edit', 500_000);
    const beyondCap = ev('edit', 700_000);
    expect(extractWindow([t, inside, beyondCap], rubric, t)).toEqual([inside]);
  });
});

describe('mechanicalLabels', () => {
  it('labels immediate_edit when an edit precedes any judged question', () => {
    const edit = ev('edit', 11_000, { path: '/p/src/x.ts', changes: 3 });
    const ask = ev('utterance', 20_000, { text: 'can a hold be extended twice?' });
    const labels = mechanicalLabels([edit, ask], [
      { seq: ask.seq, clarifying_question: true, assumption_update: false },
    ]);
    const names = labels.map((l) => l.label);
    expect(names).toContain('immediate_edit');
    expect(names).toContain('clarifying_question');
  });

  it('does NOT label immediate_edit when the question came first', () => {
    const ask = ev('utterance', 11_000, { text: 'does extend stack?' });
    const edit = ev('edit', 20_000, { path: '/p/src/x.ts', changes: 3 });
    const labels = mechanicalLabels([ask, edit], [
      { seq: ask.seq, clarifying_question: true, assumption_update: false },
    ]);
    expect(labels.map((l) => l.label)).not.toContain('immediate_edit');
  });

  it('derives inactivity from a gap in the merged trace, plus test_run from a rerun', () => {
    // Trigger at t=10s, first activity (the rerun) at t=60s → a 50s gap.
    const rerun = greenRun(60_000);
    const names = mechanicalLabels([rerun], [], { start_ts: 10_000, end_ts: 60_000 }).map(
      (l) => l.label,
    );
    expect(names).toContain('inactivity');
    expect(names).toContain('test_run');
  });

  it('ignores legacy pause events from old traces — they are no longer a verdict', () => {
    // A pre-PR1 trace claims a pause, but the merged trace shows activity
    // every 10s. The old extension-side verdict must not resurrect the label.
    const legacyPause = ev('pause', 30_000, { since_ts: 10_000, silence_ms: 20_000 });
    const busy = [
      ev('edit', 15_000, { path: 'a.ts' }),
      ev('utterance', 25_000, { text: 'hm, the expiry index...' }),
      legacyPause,
      ev('edit', 35_000, { path: 'a.ts' }),
    ];
    const names = mechanicalLabels(busy, [], { start_ts: 10_000, end_ts: 40_000 }).map((l) => l.label);
    expect(names).not.toContain('inactivity');
  });

  it('every label carries at least one evidence ref (feedback card depends on it)', () => {
    const edit = ev('edit', 11_000, { path: '/p/src/x.ts', changes: 1 });
    for (const l of mechanicalLabels([edit], [])) {
      expect(l.evidence.length).toBeGreaterThan(0);
    }
  });
});

describe('classify end-to-end (fake judge)', () => {
  it('reports trigger_occurred=false with no labels when nothing failed', async () => {
    const result = await classify([greenRun(1000)], rubric, 'spec', noJudge);
    expect(result.trigger_occurred).toBe(false);
    expect(result.labels).toEqual([]);
  });

  it('classifies the canonical bad session: fail → silent edit spree', async () => {
    // Edits every ~13s: busy hands, no thought. immediate_edit fires;
    // inactivity does not, because no gap reaches 20s.
    const events = [
      failedRun(10_000),
      ev('edit', 12_000, { path: '/p/src/expiryIndex.ts', changes: 5 }),
      ev('edit', 25_000, { path: '/p/src/expiryIndex.ts', changes: 2 }),
      ev('edit', 38_000, { path: '/p/src/expiryIndex.ts', changes: 1 }),
    ];
    const result = await classify(events, rubric, 'spec', noJudge);
    expect(result.trigger_occurred).toBe(true);
    expect(result.labels.map((l) => l.label)).toEqual(['immediate_edit']);
  });
});

describe('server-side inactivity — the regression matrix', () => {
  // THE live bug this PR fixes: typing a clarifying question into the notes
  // panel is a chrome-sourced utterance that never reached the extension's
  // activity clock, so 30 seconds of typing there scored as silence.
  it('30s spent typing in the notes panel is NOT inactivity', async () => {
    const chatUtterance = (ts: number, text: string): TraceEvent => ({
      session_id: 's', user_id: 'u', source: 'chrome', seq: n++, ts, type: 'utterance',
      payload: { text },
    });
    const events = [
      failedRun(10_000),
      chatUtterance(25_000, 'is the deadline measured from now'),
      chatUtterance(42_000, 'or from the original deadline?'),
      ev('edit', 55_000, { path: 'a.ts' }),
    ];
    const result = await classify(events, rubric, 'spec', noJudge);
    expect(result.labels.map((l) => l.label)).not.toContain('inactivity');
  });

  it('30s of narration with zero IDE activity is NOT inactivity', async () => {
    // Voice utterances land as source:'chrome' utterances (via the relay);
    // thinking out loud is the behavior the rubric asks for.
    const spoken = (ts: number): TraceEvent => ({
      session_id: 's', user_id: 'u', source: 'chrome', seq: n++, ts, type: 'utterance',
      payload: { text: 'okay so the sweep releases the full count...', via: 'voice' },
    });
    const events = [failedRun(10_000), spoken(25_000), spoken(42_000), ev('edit', 58_000, { path: 'a.ts' })];
    const result = await classify(events, rubric, 'spec', noJudge);
    expect(result.labels.map((l) => l.label)).not.toContain('inactivity');
  });

  // The positive control. Without this, "fixing" the bug by never firing the
  // label at all would pass every other test in this file.
  it('genuine 30s of silence after the failing run DOES fire inactivity', async () => {
    const events = [failedRun(10_000), ev('edit', 45_000, { path: 'a.ts' })];
    const result = await classify(events, rubric, 'spec', noJudge);
    const inactivity = result.labels.find((l) => l.label === 'inactivity');
    expect(inactivity).toBeDefined();
    expect(inactivity?.evidence[0]?.note).toContain('35s');
  });

  it('the interviewer talking does not excuse the candidate being silent', async () => {
    // Agent monologue at 20s and 35s; candidate does nothing for 40s.
    const agentTurn = (ts: number): TraceEvent => ({
      session_id: 's', user_id: 'u', source: 'chrome', seq: n++, ts, type: 'interviewer',
      payload: { text: 'what is your leading theory?', kind: 'pressure', nudge: false, unprompted: true },
    });
    const events = [failedRun(10_000), agentTurn(20_000), agentTurn(35_000), ev('edit', 50_000, { path: 'a.ts' })];
    const result = await classify(events, rubric, 'spec', noJudge);
    expect(result.labels.map((l) => l.label)).toContain('inactivity');
  });

  it('a trailing gap — silence between the last action and the window close — counts', async () => {
    // Activity at 15s, then nothing until the session ends at 50s.
    const sessionEnd = (ts: number): TraceEvent => ({
      session_id: 's', user_id: 'u', source: 'chrome', seq: n++, ts, type: 'session_end', payload: {},
    });
    const events = [failedRun(10_000), ev('edit', 15_000, { path: 'a.ts' }), sessionEnd(50_000)];
    const result = await classify(events, rubric, 'spec', noJudge);
    expect(result.labels.map((l) => l.label)).toContain('inactivity');
  });
});

describe('nudge contamination (interviewer posture A)', () => {
  const nudge = (ts: number) =>
    ev('interviewer', ts, { text: 'have another look at the index', kind: 'answer', nudge: true, unprompted: false });
  const neutralTurn = (ts: number) =>
    ev('interviewer', ts, { text: '12 minutes left. Leading theory?', kind: 'pressure', nudge: false, unprompted: true });

  it('marks a label whose only evidence follows a nudge', async () => {
    const events = [failedRun(10_000), nudge(20_000), ev('edit', 30_000, { path: 'a.ts' })];
    const result = await classify(events, rubric, 'spec', noJudge);
    const edit = result.labels.find((l) => l.label === 'immediate_edit');
    expect(edit?.contaminated).toBe(true);
  });

  it('leaves labels clean when the interviewer only applied pressure', async () => {
    const events = [failedRun(10_000), neutralTurn(20_000), ev('edit', 30_000, { path: 'a.ts' })];
    const result = await classify(events, rubric, 'spec', noJudge);
    expect(result.labels.find((l) => l.label === 'immediate_edit')?.contaminated).toBeFalsy();
  });

  it('does not contaminate behavior that PRECEDED the nudge', async () => {
    const events = [failedRun(10_000), ev('edit', 15_000, { path: 'a.ts' }), nudge(20_000)];
    const result = await classify(events, rubric, 'spec', noJudge);
    expect(result.labels.find((l) => l.label === 'immediate_edit')?.contaminated).toBeFalsy();
  });

  it('expires: one nudge does not blank the whole debugging cycle', async () => {
    const events = [failedRun(10_000), nudge(20_000), ev('edit', 200_000, { path: 'a.ts' })];
    const result = await classify(events, rubric, 'spec', noJudge);
    expect(result.labels.find((l) => l.label === 'immediate_edit')?.contaminated).toBeFalsy();
  });

  it('keeps a label whose evidence is only PARTLY prompted', async () => {
    // Two silence gaps: one starting at the trigger (10s→40s, clean — before
    // the nudge), one starting after the nudge (50s→80s, inside its shadow).
    // Mixed evidence means the label stands on the clean gap.
    const events = [
      failedRun(10_000),
      ev('edit', 40_000, { path: 'a.ts' }),
      nudge(45_000),
      ev('edit', 50_000, { path: 'a.ts' }),
      ev('edit', 80_000, { path: 'a.ts' }),
    ];
    const result = await classify(events, rubric, 'spec', noJudge);
    const inactivity = result.labels.find((l) => l.label === 'inactivity');
    expect(inactivity).toBeDefined();
    expect(inactivity?.contaminated).toBeFalsy();
  });
});
