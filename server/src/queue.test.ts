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
