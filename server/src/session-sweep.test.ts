/**
 * The sweep plan matrix. The rows that matter: a healthy cold boot is never
 * touched, the card window keys on ended_at (a long round graded a minute
 * ago keeps its server), and cleanup order is container-before-ide-data.
 */
import { describe, expect, it } from 'vitest';
import { ENDED_LINGER_MS, planSessionSweep } from './session-sweep.js';
import type { ProbeResult, SessionEntry } from './session-registry.js';

const T0 = 1_700_000_000_000;
const entry = (over: Partial<SessionEntry>): SessionEntry => ({
  sid: 'sess-1-aa', user_id: 'u', port: 3401, ide_port: 3451, pid: 9,
  problem_dir: 'reps/a/problem', started_at: T0 - 60_000, ...over,
});
const probe = (o: Partial<ProbeResult>): ProbeResult => ({
  reachable: false, ended: false, session_id: null, ...o,
});

describe('planSessionSweep', () => {
  it('live healthy session: no actions at all', () => {
    const e = entry({});
    const probes = new Map([[e.sid, probe({ reachable: true, session_id: e.sid })]]);
    expect(planSessionSweep([e], probes, () => true, [`ip-session-${e.sid}`], T0)).toEqual([]);
  });

  it('cold boot (unreachable, pid alive) is untouched', () => {
    const e = entry({ started_at: T0 - 10 * 60_000 });
    expect(planSessionSweep([e], new Map(), () => true, [], T0)).toEqual([]);
  });

  it('dead entry: persist, then container BEFORE ide-data', () => {
    const e = entry({});
    const actions = planSessionSweep([e], new Map(), () => false, [`ip-session-${e.sid}`], T0);
    expect(actions.map((a) => a.kind)).toEqual(['persist', 'rm-container', 'rm-ide-data']);
  });

  it('ended session keeps its card server for 30 min FROM GRADING, then reaps', () => {
    const graded = entry({ started_at: T0 - 60 * 60_000, ended_at: T0 - 60_000 });
    const probes = new Map([[graded.sid, probe({ reachable: true, ended: true, session_id: graded.sid })]]);
    expect(planSessionSweep([graded], probes, () => true, [], T0)).toEqual([]);
    const past = entry({ started_at: T0 - 2 * 60 * 60_000, ended_at: T0 - ENDED_LINGER_MS - 1 });
    const probes2 = new Map([[past.sid, probe({ reachable: true, ended: true, session_id: past.sid })]]);
    const actions = planSessionSweep([past], probes2, () => true, [], T0);
    expect(actions).toEqual([{ kind: 'shutdown-ended', sid: past.sid, port: past.port }]);
  });

  it('orphan containers: per-session prefix only, never legacy ip-session', () => {
    const actions = planSessionSweep([], new Map(), () => false,
      ['ip-session', 'ip-session-sess-9-ff', 'unrelated'], T0);
    expect(actions).toEqual([{ kind: 'orphan-container', container: 'ip-session-sess-9-ff' }]);
  });
});
