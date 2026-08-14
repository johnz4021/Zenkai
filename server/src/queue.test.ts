/**
 * Queue semantics — the pace-not-calendar rule and disk-derived status are
 * the two things that keep the season program honest, so both get pinned.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RoundSpec } from '@interview-prep/shared';
import type { Target } from './intake.js';
import { bucketIntoDays, daysLeft, localDate, nextUp, proposeQueue, reconcileWithDisk, repace, saveQueue, loadQueue } from './queue.js';
import type { GraphView } from './gap-graph.js';

const NOW = Date.parse('2026-08-01T12:00:00');

const spec = (id: string): RoundSpec => ({
  id,
  label: id,
  capabilities: { interviewer: false, can_run_tests: true, time_limit_ms: 60_000, starts_from: 'blank', submit: 'one_shot' },
  check: { kind: 'all_failing' },
  memory_tags: ['from_scratch'],
});

const target = (over: Partial<Target> = {}): Target => ({
  id: 't1',
  label: 'T1',
  description: '',
  specs: [spec('oa')],
  created: '2026-08-01',
  ...over,
});

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const scratch = () => {
  const d = mkdtempSync(path.join(tmpdir(), 'ip-queue-'));
  dirs.push(d);
  return d;
};

describe('proposeQueue', () => {
  it('sizes the queue to the runway, capped', () => {
    const twoWeeks = proposeQueue(target({ interview_date: '2026-08-15' }), NOW);
    expect(twoWeeks.items.length).toBe(6); // 2 weeks × 3/week
    const farOff = proposeQueue(target({ interview_date: '2026-12-01' }), NOW);
    expect(farOff.items.length).toBe(12); // capped, never a wall of items
    const undated = proposeQueue(target(), NOW);
    expect(undated.items.length).toBe(6); // default 2-week horizon
  });

  it('round-robins across multiple confirmed specs', () => {
    const q = proposeQueue(target({ specs: [spec('a'), spec('b')], interview_date: '2026-08-15' }), NOW);
    expect(q.items.map((i) => i.spec_id).slice(0, 4)).toEqual(['a', 'b', 'a', 'b']);
  });

  it('no confirmed specs → empty queue, never invented items', () => {
    expect(proposeQueue(target({ specs: [] }), NOW).items).toEqual([]);
  });

  it('a conversational pace resizes the queue; omitting it keeps the default', () => {
    const t = target({ interview_date: '2026-08-15' });
    const paced = proposeQueue(t, NOW, 5);
    expect(paced.items.length).toBe(11); // 15-day runway × 5/week
    expect(paced.pace.per_week).toBe(5);
    // Byte-identical default when the third arg is absent (compat contract).
    expect(proposeQueue(t, NOW)).toEqual(proposeQueue(t, NOW, 3));
  });
});

describe('repace — a queue with a pace, not a calendar', () => {
  it('slippage changes the pace number, never creates overdue state', () => {
    const t = target({ interview_date: '2026-08-15' });
    const q = proposeQueue(t, NOW);
    // A week passes, nothing done: same items, higher pace, no "overdue".
    const later = Date.parse('2026-08-08T12:00:00');
    const paced = repace(q, t, null, later);
    expect(paced.pace.per_week).toBe(6); // 6 remaining / 1 week left
    expect(paced.items.every((i) => i.status === 'pending')).toBe(true);
    expect(JSON.stringify(paced)).not.toContain('overdue');
  });

  it('pace clamps to a human range', () => {
    const t = target({ interview_date: '2026-08-02' }); // tomorrow, 6 items
    const paced = repace(proposeQueue(t, NOW), t, null, NOW);
    expect(paced.pace.per_week).toBe(7);
  });

  it('the focus gap lands as a note on the next item only', () => {
    const t = target({ interview_date: '2026-08-15' });
    const view = { focus: 'verify' } as GraphView;
    const paced = repace(proposeQueue(t, NOW), t, view, NOW);
    expect(paced.items[0]!.note).toBe('focus: verify');
    expect(paced.items.slice(1).every((i) => !i.note)).toBe(true);
  });
});

describe('reconcileWithDisk — restart-safe by construction', () => {
  it('derives generating→ready from .validated, session from .used, done from the assessment', () => {
    const root = scratch();
    const pdir = path.join(root, 'targets', 't1', 'problems', 'item-1');
    mkdirSync(pdir, { recursive: true });
    mkdirSync(path.join(root, 'assessments'), { recursive: true });

    const t = target({ interview_date: '2026-08-15' });
    let q = proposeQueue(t, NOW);
    q.items[0]!.status = 'generating';
    q.items[0]!.problem_dir = pdir;

    // Nothing on disk yet: stays generating.
    expect(reconcileWithDisk(root, q).items[0]!.status).toBe('generating');

    writeFileSync(path.join(pdir, '.validated'), 'now');
    expect(reconcileWithDisk(root, q).items[0]!.status).toBe('ready');

    writeFileSync(path.join(pdir, '.used'), 'sess-abc\n2026-08-02');
    q = reconcileWithDisk(root, q);
    expect(q.items[0]!.session_id).toBe('sess-abc');
    expect(q.items[0]!.status).toBe('ready'); // session running, not done

    writeFileSync(path.join(root, 'assessments', 'sess-abc.json'), '{}');
    expect(reconcileWithDisk(root, q).items[0]!.status).toBe('done');
  });

  it('a ready item still takes its session_id from .used, unchanged', () => {
    const root = scratch();
    const pdir = path.join(root, 'p1');
    mkdirSync(pdir, { recursive: true });
    const q = proposeQueue(target({ interview_date: '2026-08-15' }), NOW);
    q.items[0]!.status = 'ready';
    q.items[0]!.problem_dir = pdir;
    q.items[0]!.session_id = 'sess-stale';
    writeFileSync(path.join(pdir, '.validated'), 'now');
    writeFileSync(path.join(pdir, '.used'), 'sess-live\n2026-08-02T10:00:00.000Z\n');
    const out = reconcileWithDisk(root, q).items[0]!;
    expect(out.session_id).toBe('sess-live');
    expect(out.status).toBe('ready');
  });

  it('a source binding survives the JSON round-trip untouched', () => {
    const root = scratch();
    const q = proposeQueue(target({ interview_date: '2026-08-15' }), NOW);
    q.items[0]!.source = {
      kind: 'leetcode', slug: 'two-sum', title: 'Two Sum',
      difficulty: 'easy', picked_by: 'user',
    };
    expect(reconcileWithDisk(root, q).items[0]!.source).toEqual(q.items[0]!.source);
  });
});

/**
 * "Practice again" overwrites `.used` with the new sid while the row still
 * reads `done` from the previous run. Reconciliation has to move BACKWARD
 * here (TODOS #53's forward-only rule, narrowed) or the second attempt would
 * never show as live and would never re-complete.
 */
describe('reconcileWithDisk — a repeat re-points and demotes the row', () => {
  const doneRow = (root: string, pdir: string, usedSid: string) => {
    mkdirSync(pdir, { recursive: true });
    mkdirSync(path.join(root, 'assessments'), { recursive: true });
    const q = proposeQueue(target({ interview_date: '2026-08-15' }), NOW);
    q.items[0]!.status = 'done';
    q.items[0]!.problem_dir = pdir;
    q.items[0]!.session_id = 'sess-first';
    q.items[0]!.done_at = '2026-08-02';
    writeFileSync(path.join(pdir, '.validated'), 'now');
    writeFileSync(path.join(pdir, '.used'), `${usedSid}\n2026-08-05T09:00:00.000Z\n`);
    writeFileSync(path.join(root, 'assessments', 'sess-first.json'), JSON.stringify({ status: 'assessed' }));
    return q;
  };

  it('a different sid in .used demotes done → ready and drops done_at', () => {
    const root = scratch();
    const pdir = path.join(root, 'p1');
    const out = reconcileWithDisk(root, doneRow(root, pdir, 'sess-second')).items[0]!;
    expect(out.session_id).toBe('sess-second');
    expect(out.status).toBe('ready');
    expect(out.done_at).toBeUndefined();
  });

  it('the same sid leaves a done row completely alone', () => {
    const root = scratch();
    const pdir = path.join(root, 'p1');
    const out = reconcileWithDisk(root, doneRow(root, pdir, 'sess-first')).items[0]!;
    expect(out.session_id).toBe('sess-first');
    expect(out.status).toBe('done');
    expect(out.done_at).toBe('2026-08-02'); // pinned, not recomputed
  });

  it('the repeat completes normally once the NEW assessment lands', () => {
    const root = scratch();
    const pdir = path.join(root, 'p1');
    let q = reconcileWithDisk(root, doneRow(root, pdir, 'sess-second'));
    expect(q.items[0]!.status).toBe('ready');

    // A judge failure is not a verdict: the row stays live.
    writeFileSync(
      path.join(root, 'assessments', 'sess-second.json'),
      JSON.stringify({ status: 'unassessed', reason: 'judge call failed' }),
    );
    expect(reconcileWithDisk(root, q).items[0]!.status).toBe('ready');

    writeFileSync(
      path.join(root, 'assessments', 'sess-second.json'),
      JSON.stringify({ status: 'assessed' }),
    );
    q = reconcileWithDisk(root, q);
    expect(q.items[0]!.status).toBe('done');
    expect(q.items[0]!.session_id).toBe('sess-second');
    expect(q.items[0]!.done_at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('an empty first line never clobbers a completed row', () => {
    const root = scratch();
    const pdir = path.join(root, 'p1');
    const q = doneRow(root, pdir, '');
    const out = reconcileWithDisk(root, q).items[0]!;
    expect(out.session_id).toBe('sess-first');
    expect(out.status).toBe('done');
  });
});

describe('store + nextUp', () => {
  it('round-trips and prefers ready over pending', () => {
    const root = scratch();
    const q = proposeQueue(target({ interview_date: '2026-08-15' }), NOW);
    q.items[1]!.status = 'ready';
    saveQueue(root, q);
    const loaded = loadQueue(root, 't1')!;
    expect(nextUp(loaded)?.id).toBe('item-2');
  });
});

describe('daysLeft', () => {
  it('floors at one and tolerates garbage', () => {
    expect(daysLeft('2026-08-01', NOW)).toBe(1);
    expect(daysLeft('not-a-date', NOW)).toBeNull();
    expect(daysLeft(undefined, NOW)).toBeNull();
  });
});

describe('failed derivation + done_at pinning', () => {
  it('.failed with no .validated derives failed; .validated wins over .failed', () => {
    const root = scratch();
    const pdir = path.join(root, 'p1');
    mkdirSync(pdir, { recursive: true });
    const t = target({ interview_date: '2026-08-15' });
    const q = proposeQueue(t, NOW);
    q.items[0]!.status = 'generating';
    q.items[0]!.problem_dir = pdir;

    writeFileSync(path.join(pdir, '.failed'), 'exit 1');
    expect(reconcileWithDisk(root, q).items[0]!.status).toBe('failed');

    writeFileSync(path.join(pdir, '.validated'), 'now');
    expect(reconcileWithDisk(root, q).items[0]!.status).toBe('ready');
  });

  it('done stamps done_at from the assessment file', () => {
    const root = scratch();
    const pdir = path.join(root, 'p1');
    mkdirSync(pdir, { recursive: true });
    mkdirSync(path.join(root, 'assessments'), { recursive: true });
    const t = target({ interview_date: '2026-08-15' });
    const q = proposeQueue(t, NOW);
    q.items[0]!.status = 'ready';
    q.items[0]!.problem_dir = pdir;
    writeFileSync(path.join(pdir, '.validated'), 'now');
    writeFileSync(path.join(pdir, '.used'), 'sess-x\n');
    writeFileSync(path.join(root, 'assessments', 'sess-x.json'), '{}');
    const out = reconcileWithDisk(root, q).items[0]!;
    expect(out.status).toBe('done');
    expect(out.done_at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('bucketIntoDays — the timeline spine (D2: dated, forward-only)', () => {
  const dated = () => target({ interview_date: '2026-08-15' }); // 14 days from NOW

  it('renders past band, TODAY, future days, and the interview terminal row', () => {
    const q = proposeQueue(dated(), NOW);
    const rows = bucketIntoDays(q, dated(), NOW);
    const days = rows.filter((r) => r.kind === 'day');
    expect(days.filter((r) => r.kind === 'day' && r.past)).toHaveLength(4);
    expect(days.filter((r) => r.kind === 'day' && r.today)).toHaveLength(1);
    expect(rows[rows.length - 1]).toEqual({ kind: 'interview', date: '2026-08-15' });
  });

  it('TODAY prefers a startable item over queued ones', () => {
    const q = proposeQueue(dated(), NOW);
    q.items[2]!.status = 'ready';
    const rows = bucketIntoDays(q, dated(), NOW);
    const today = rows.find((r) => r.kind === 'day' && r.today) as Extract<(typeof rows)[0], { kind: 'day' }>;
    expect(today.items[0]!.id).toBe('item-3');
  });

  it('past emptiness is neutral rows, never a warning shape', () => {
    const q = proposeQueue(dated(), NOW);
    const rows = bucketIntoDays(q, dated(), NOW);
    const pastEmpty = rows.filter((r) => r.kind === 'day' && r.past && r.items.length === 0);
    expect(pastEmpty.length).toBeGreaterThan(0);
    expect(JSON.stringify(rows)).not.toMatch(/overdue|missed|late/);
  });

  it('a long season collapses its far stretch instead of scrolling forever', () => {
    const far = target({ interview_date: '2026-10-30' }); // ~90 days
    const q = proposeQueue(far, NOW); // capped at 12 items
    const rows = bucketIntoDays(q, far, NOW);
    const collapsed = rows.find((r) => r.kind === 'collapsed');
    expect(collapsed).toBeDefined();
    expect((collapsed as { count: number }).count).toBeGreaterThan(0);
    // Visible future day rows stay within the display budget.
    expect(rows.filter((r) => r.kind === 'day' && !r.past && !r.today).length).toBeLessThanOrEqual(8);
  });

  it('undated target: flat ordered list, no dates, no interview row', () => {
    const t = target();
    const rows = bucketIntoDays(proposeQueue(t, NOW), t, NOW);
    expect(rows.every((r) => r.kind === 'day')).toBe(true);
    expect(rows.filter((r) => r.kind === 'day' && r.date !== null)).toHaveLength(0);
  });

  it('rounds finished TODAY pin above the TODAY row — never invisible (QA ISSUE-002)', () => {
    const t = dated();
    const q = proposeQueue(t, NOW);
    q.items[0]!.status = 'done';
    q.items[0]!.done_at = localDate(NOW);
    const rows = bucketIntoDays(q, t, NOW);
    const dtIdx = rows.findIndex((r) => r.kind === 'done-today');
    const todayIdx = rows.findIndex((r) => r.kind === 'day' && r.today);
    expect(dtIdx).toBeGreaterThan(-1);
    expect(todayIdx).toBe(dtIdx + 1);
    expect((rows[dtIdx] as Extract<(typeof rows)[0], { kind: 'done-today' }>).items[0]!.id).toBe('item-1');
    // TODAY still offers the next action alongside today's wins.
    expect((rows[todayIdx] as Extract<(typeof rows)[0], { kind: 'day' }>).items).toHaveLength(1);
  });

  it('finishing the whole season today renders complete, not emptiness (the QA repro)', () => {
    const t = dated();
    const q = proposeQueue(t, NOW);
    for (const i of q.items) {
      i.status = 'done';
      i.done_at = localDate(NOW);
    }
    const rows = bucketIntoDays(q, t, NOW);
    const complete = rows.find((r) => r.kind === 'complete');
    expect(complete).toBeDefined();
    expect((complete as { done_count: number }).done_count).toBe(q.items.length);
    // No empty TODAY row claiming "nothing scheduled" on the best day.
    expect(rows.some((r) => r.kind === 'day' && r.today)).toBe(false);
    expect(rows.some((r) => r.kind === 'done-today')).toBe(true);
    expect(rows[rows.length - 1]).toEqual({ kind: 'interview', date: '2026-08-15' });
  });

  it('runs of 2+ empty future days compress to one quiet row; lone empties stay dated (D4)', () => {
    const t = dated();
    const q = proposeQueue(t, NOW);
    q.items = q.items.slice(0, 2); // sparse queue → multi-day gaps (the Palantir shape)
    const rows = bucketIntoDays(q, t, NOW);
    const quiet = rows.filter((r) => r.kind === 'quiet');
    expect(quiet.length).toBeGreaterThan(0);
    for (const qr of quiet) expect((qr as { count: number }).count).toBeGreaterThanOrEqual(2);
    // No run of 2+ consecutive empty future day rows survives.
    let emptyStreak = 0;
    for (const r of rows) {
      if (r.kind === 'day' && !r.past && !r.today && r.items.length === 0) {
        emptyStreak++;
        expect(emptyStreak).toBeLessThan(2);
      } else emptyStreak = 0;
    }
  });

  it('done items pin to their done_at day in the past band', () => {
    const t = dated();
    const q = proposeQueue(t, NOW);
    q.items[0]!.status = 'done';
    q.items[0]!.done_at = localDate(NOW - 2 * 86_400_000);
    const rows = bucketIntoDays(q, t, NOW);
    const pinned = rows.find(
      (r) => r.kind === 'day' && r.past && r.items.some((i) => i.id === 'item-1'),
    ) as Extract<(typeof rows)[0], { kind: 'day' }>;
    expect(pinned.date).toBe(localDate(NOW - 2 * 86_400_000));
  });
});

// ---- per-round dates (one plan per loop, rounds on different days) ----

const datedSpec = (id: string, date?: string): RoundSpec => ({ ...spec(id), ...(date ? { date } : {}) });

describe('proposeQueue with per-round dates', () => {
  it('orders by imminence and sizes each round against its own runway', () => {
    // NOW = Aug 1. OA on Aug 5 (4 days), onsite Sep 1 (31 days).
    const t = target({
      interview_date: '2026-09-01',
      specs: [datedSpec('onsite', '2026-09-01'), datedSpec('oa', '2026-08-05')],
    });
    const q = proposeQueue(t, NOW);
    // Nearest round's practice comes FIRST even though the spec is listed second.
    expect(q.items[0]!.spec_id).toBe('oa');
    const oa = q.items.filter((i) => i.spec_id === 'oa').length;
    const onsite = q.items.filter((i) => i.spec_id === 'onsite').length;
    expect(oa).toBeGreaterThanOrEqual(1);
    expect(onsite).toBeGreaterThan(oa); // 31-day runway outweighs 4 days
    expect(q.items.length).toBeLessThanOrEqual(12);
    // Labels still count per spec, never a global "round N".
    expect(q.items[0]!.label).toBe('oa — round 1');
  });

  it('an undated spec gets a small flat block at the end', () => {
    const t = target({
      specs: [datedSpec('oa', '2026-08-08'), datedSpec('mystery')],
    });
    const q = proposeQueue(t, NOW);
    const mystery = q.items.filter((i) => i.spec_id === 'mystery');
    expect(mystery).toHaveLength(2);
    // Parked at the end, after every dated item.
    expect(q.items.slice(-2).every((i) => i.spec_id === 'mystery')).toBe(true);
  });
});

describe('repace surfaces per-round over-commitment', () => {
  it('a tight segment gets a note; a comfortable loop does not hide it', () => {
    // 6 debugging items, 3 days to the debugging round, loop ends a month out.
    const t = target({
      interview_date: '2026-09-01',
      specs: [datedSpec('debug', '2026-08-04'), datedSpec('onsite', '2026-09-01')],
    });
    const q = proposeQueue(t, NOW);
    const debugItems = q.items.filter((i) => i.spec_id === 'debug');
    for (let k = debugItems.length; k < 6; k++) {
      q.items.unshift({ id: `extra-${k}`, label: `debug — round ${k}`, spec_id: 'debug', status: 'pending' });
    }
    const paced = repace(q, t, null, NOW);
    const noted = paced.items.find((i) => i.note?.startsWith('tight:'));
    expect(noted?.spec_id).toBe('debug');
    expect(noted?.note).toContain('to debug');
    // The onsite segment is comfortable — no tight note there.
    expect(paced.items.filter((i) => i.spec_id === 'onsite').every((i) => !i.note?.startsWith('tight:'))).toBe(true);
  });
});

describe('bucketIntoDays with per-round dates', () => {
  it('each dated round gets a labeled interview row at its place in the runway', () => {
    const t = target({
      interview_date: '2026-08-15',
      specs: [datedSpec('oa', '2026-08-05'), datedSpec('onsite', '2026-08-15')],
    });
    const q = proposeQueue(t, NOW);
    const rows = bucketIntoDays(q, t, NOW);
    const interviews = rows.filter((r) => r.kind === 'interview');
    expect(interviews).toHaveLength(2);
    expect(interviews[0]).toMatchObject({ date: '2026-08-05', label: 'oa' });
    expect(interviews[1]).toMatchObject({ date: '2026-08-15', label: 'onsite' });
    // The OA's marker comes BEFORE the onsite practice that follows it.
    const kinds = rows.map((r) => (r.kind === 'interview' ? 'interview:' + r.date : r.kind));
    expect(kinds.indexOf('interview:2026-08-05')).toBeLessThan(kinds.indexOf('interview:2026-08-15'));
    // Practice for the OA lands before its round day.
    const oaIdx = kinds.indexOf('interview:2026-08-05');
    const before = rows.slice(0, oaIdx).filter((r) => r.kind === 'day' && !r.past && !r.today);
    expect(before.some((r) => r.kind === 'day' && r.items.some((i) => i.spec_id === 'oa'))).toBe(true);
  });

  it('undated rounds park after the runway as an honest unscheduled block', () => {
    const t = target({
      specs: [datedSpec('oa', '2026-08-08'), datedSpec('mystery')],
    });
    const q = proposeQueue(t, NOW);
    const rows = bucketIntoDays(q, t, NOW);
    const unschedIdx = rows.findIndex((r) => r.kind === 'unscheduled');
    expect(unschedIdx).toBeGreaterThan(-1);
    expect(rows[unschedIdx]).toMatchObject({ kind: 'unscheduled', count: 2 });
    // Its items follow as undated day rows.
    const tail = rows.slice(unschedIdx + 1).filter((r) => r.kind === 'day');
    expect(tail.every((r) => r.kind === 'day' && r.date === null)).toBe(true);
    expect(tail.flatMap((r) => (r.kind === 'day' ? r.items : [])).every((i) => i.spec_id === 'mystery')).toBe(true);
  });

  it('a passed round emits no future marker; its leftovers merge into the next window', () => {
    // Debug round was Jul 30 (passed); onsite Aug 15 upcoming.
    const t = target({
      interview_date: '2026-08-15',
      specs: [datedSpec('debug', '2026-07-30'), datedSpec('onsite', '2026-08-15')],
    });
    const q = proposeQueue(t, NOW);
    q.items.unshift({ id: 'left', label: 'debug — round 9', spec_id: 'debug', status: 'pending' });
    const rows = bucketIntoDays(q, t, NOW);
    const interviews = rows.filter((r) => r.kind === 'interview');
    expect(interviews).toHaveLength(1);
    expect(interviews[0]).toMatchObject({ date: '2026-08-15' });
    // The leftover debug item still appears on a future day (never dropped).
    const futureItems = rows.flatMap((r) => (r.kind === 'day' && !r.past && !r.today ? r.items : []));
    expect(futureItems.some((i) => i.spec_id === 'debug')).toBe(true);
  });
});
