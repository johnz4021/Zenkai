import { describe, expect, it } from 'vitest';
import type { SpecChangeLabel } from '@interview-prep/shared';
import { buildGraphView, emptyStore, recordSession, type GapStore } from './gap-graph.js';

let t = 0;
const session = (
  id: string,
  labels: SpecChangeLabel[],
  triggerOccurred = true,
): Parameters<typeof recordSession>[1] => ({
  session_id: id,
  ts: (t += 1_000_000),
  round_type: 'debugging',
  trigger_occurred: triggerOccurred,
  labels_fired: labels,
});

const fire = (store: GapStore, ...args: Parameters<typeof session>) =>
  recordSession(store, session(...args), { immediate_edit: [], inactivity: [] });

describe('remediation (T11 — the false-positive rule)', () => {
  it('closes a gap after 3 consecutive TRIGGERED clean sessions', () => {
    let s = emptyStore('u1');
    s = fire(s, 's1', ['immediate_edit']);
    s = fire(s, 's2', []);
    s = fire(s, 's3', []);
    s = fire(s, 's4', []);
    expect(s.gaps['immediate_edit']?.closed_at).toBeDefined();
    expect(s.gaps['immediate_edit']?.closed_after).toBe('s4');
  });

  it('does NOT count sessions where the trigger never occurred', () => {
    let s = emptyStore('u1');
    s = fire(s, 's1', ['immediate_edit']);
    // Three "clean" sessions — but the trigger never fired in any of them.
    s = fire(s, 's2', [], false);
    s = fire(s, 's3', [], false);
    s = fire(s, 's4', [], false);
    expect(s.gaps['immediate_edit']?.closed_at).toBeUndefined();
  });

  it('does NOT close a gap that only ever fired inside the streak window', () => {
    let s = emptyStore('u1');
    // Gap fires in s2; s2..s4 are the last 3 triggered sessions. A naive
    // "3 clean" check over s2-s4 is false; but even for a gap firing at s2,
    // there is no PRE-streak history proving improvement.
    s = fire(s, 's2', ['inactivity']);
    s = fire(s, 's3', []);
    s = fire(s, 's4', []);
    expect(s.gaps['inactivity']?.closed_at).toBeUndefined();
  });

  it('reopens a closed gap when it fires again, history intact (D3)', () => {
    let s = emptyStore('u1');
    s = fire(s, 's1', ['immediate_edit']);
    s = fire(s, 's2', []);
    s = fire(s, 's3', []);
    s = fire(s, 's4', []);
    expect(s.gaps['immediate_edit']?.closed_at).toBeDefined();
    s = fire(s, 's5', ['immediate_edit']);
    expect(s.gaps['immediate_edit']?.closed_at).toBeUndefined();
    expect(s.gaps['immediate_edit']?.instances).toHaveLength(2);
  });
});

describe('graph view', () => {
  it('session one presents as observations, not patterns (D1)', () => {
    let s = emptyStore('u1');
    s = fire(s, 's1', ['immediate_edit']);
    const view = buildGraphView(s, 's1');
    expect(view.session_count).toBe(1);
    expect(view.sessions_until_patterns).toBe(2);
  });

  it('weights recent instances above old ones (half-life 5)', () => {
    let s = emptyStore('u1');
    s = fire(s, 's1', ['inactivity']);
    for (let i = 2; i <= 11; i++) s = fire(s, `s${i}`, []);
    s = fire(s, 's12', ['immediate_edit']);
    const view = buildGraphView(s, 's12');
    const inactivity = view.active.find((v) => v.key === 'inactivity');
    const immediate = view.active.find((v) => v.key === 'immediate_edit');
    // inactivity is closed by now (streak) OR heavily decayed; immediate_edit
    // just fired and must dominate focus.
    expect(view.focus).toBe('immediate_edit');
    if (inactivity && immediate) expect(immediate.weight).toBeGreaterThan(inactivity.weight);
  });

  it('newly_closed carries the D3 event exactly once', () => {
    let s = emptyStore('u1');
    s = fire(s, 's1', ['immediate_edit']);
    s = fire(s, 's2', []);
    s = fire(s, 's3', []);
    s = fire(s, 's4', []);
    expect(buildGraphView(s, 's4').newly_closed).toEqual(['immediate_edit']);
    s = fire(s, 's5', []);
    expect(buildGraphView(s, 's5').newly_closed).toEqual([]);
  });
});

describe('contaminated labels never earn remediation credit', () => {
  const record = (store: GapStore, id: string, contaminatedLabels: SpecChangeLabel[]) =>
    recordSession(store, { ...session(id, []), contaminated_labels: contaminatedLabels }, {});

  it('does not close a gap that only stayed quiet because we prompted them', () => {
    let s = emptyStore('u1');
    s = fire(s, 's1', ['immediate_edit']);
    // Three triggered sessions where it did not fire — but in one of them the
    // behavior showed up right after an interviewer nudge, so that session
    // proves nothing either way.
    s = record(s, 's2', []);
    s = record(s, 's3', ['immediate_edit']);
    s = record(s, 's4', []);
    expect(s.gaps.immediate_edit).toBeDefined();
    expect(s.gaps.immediate_edit?.closed_at).toBeUndefined();
  });

  it('still closes when the clean streak is genuinely clean', () => {
    let s = emptyStore('u1');
    s = fire(s, 's1', ['immediate_edit']);
    s = record(s, 's2', []);
    s = record(s, 's3', []);
    s = record(s, 's4', []);
    expect(s.gaps.immediate_edit?.closed_at).toBeDefined();
  });

  it('tolerates sessions recorded before the interviewer existed', () => {
    let s = emptyStore('u1');
    s = fire(s, 's1', ['inactivity']);
    s = fire(s, 's2', []);
    s = fire(s, 's3', []);
    s = fire(s, 's4', []);
    expect(s.gaps.inactivity?.closed_at).toBeDefined();
  });
});
