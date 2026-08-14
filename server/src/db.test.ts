/**
 * The mirror's contract: correct PostgREST upserts with injected fetch, dead
 * silence when disabled, and disk-stays-truth on failure (a rejecting fetch
 * must never throw into the caller). No network, no model calls.
 */
import { describe, expect, it, vi } from 'vitest';
import { makeDb, repRow, sessionRow, targetRow } from './db.js';

const CFG = { url: 'https://x.supabase.co', serviceKey: 'svc' };
const T0 = 1_700_000_000_000;

describe('makeDb', () => {
  it('null cfg is a no-op that never fetches', () => {
    const db = makeDb(null, (() => {
      throw new Error('must not be called');
    }) as never);
    expect(db.enabled).toBe(false);
    db.upsertUsers([{ id: 'u', email: 'e', is_admin: false }]);
  });

  it('upserts with on_conflict + merge-duplicates and the service key', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return { ok: true, status: 201 } as Response;
    });
    const db = makeDb(CFG, fetchImpl as never);
    db.mirrorReps([repRow({ id: 'rep-a', label: 'L', spec: { id: 's' }, status: 'ready', created: '2026-08-11T00:00:00Z' }, 'u1', T0)]);
    await vi.waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0]!.url).toBe('https://x.supabase.co/rest/v1/reps?on_conflict=id');
    const h = calls[0]!.init.headers as Record<string, string>;
    expect(h.apikey).toBe('svc');
    expect(h.prefer).toContain('merge-duplicates');
    const body = JSON.parse(String(calls[0]!.init.body)) as { user_id: string }[];
    expect(body[0]!.user_id).toBe('u1'); // legacy rep → local owner
  });

  it('a failing fetch logs once per streak and never throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 500 }) as Response);
    const db = makeDb(CFG, fetchImpl as never);
    db.mirrorTargets([targetRow({ id: 't1', label: 'T', created: '2026-08-11T00:00:00Z' }, 'u1')]);
    db.mirrorTargets([targetRow({ id: 't2', label: 'T2', created: '2026-08-11T00:00:00Z' }, 'u1')]);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    await new Promise((r) => setTimeout(r, 0)); // let both .catch chains settle
    expect(warn).toHaveBeenCalledTimes(1); // streak, not spam
    warn.mockRestore();
  });

  it('empty row lists skip the network entirely', () => {
    const fetchImpl = vi.fn();
    makeDb(CFG, fetchImpl as never).mirrorSessions([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('row builders', () => {
  it('sessionRow scopes legacy feedback (no user_id) to the local owner', () => {
    const row = sessionRow('sess-1', { card: { solved: true } }, { status: 'assessed' }, 'u1', T0);
    expect(row).toEqual({
      id: 'sess-1',
      user_id: 'u1',
      label: null,
      feedback: { card: { solved: true } },
      assessment: { status: 'assessed' },
      solved: true,
      completed_at: new Date(T0).toISOString(),
    });
  });
});
