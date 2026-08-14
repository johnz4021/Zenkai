/**
 * Supabase Postgres mirror (beta WU7).
 *
 *   disk (authoritative) ──► makeDb(cfg).mirror*() ──► PostgREST upserts
 *                                                        users / reps /
 *                                                        targets / sessions
 *
 * The DB is the durable RECORD, never the runtime: every write is a
 * fire-and-forget upsert at a moment that already exists (rep create/state
 * change, target create, feedback file landing), and a failed write logs and
 * moves on — the product keeps working from disk. Upsert semantics
 * (on_conflict=id + merge-duplicates) make re-mirroring after an app restart
 * harmless, which is what lets the session sweep be a dumb watermark scan.
 *
 * Why sessions are mirrored BY THE APP from feedback/<sid>.json rather than
 * written by the session at finalize: WU8 hands the service key to no child,
 * and session processes are children. The app already polls; it sweeps.
 *
 * cfg = null (local dev) → every method is a no-op. fetch is injectable so
 * tests never touch the network (repo rule: unit tests call no model, and no
 * network either).
 */

import type { SupabaseConfig } from './public-config.js';

export interface UserRow {
  id: string;
  email: string;
  is_admin: boolean;
}
export interface RepRow {
  id: string;
  user_id: string;
  label: string;
  spec: unknown;
  status: string;
  created_at: string;
  updated_at: string;
}
export interface TargetRow {
  id: string;
  user_id: string;
  label: string;
  interview_date: string | null;
  created_at: string;
}
export interface SessionRow {
  id: string;
  user_id: string;
  label: string | null;
  feedback: unknown;
  assessment: unknown;
  solved: boolean | null;
  completed_at: string;
}

export interface Db {
  enabled: boolean;
  upsertUsers(rows: UserRow[]): void;
  mirrorReps(rows: RepRow[]): void;
  mirrorTargets(rows: TargetRow[]): void;
  mirrorSessions(rows: SessionRow[]): void;
}

const NOOP: Db = {
  enabled: false,
  upsertUsers: () => {},
  mirrorReps: () => {},
  mirrorTargets: () => {},
  mirrorSessions: () => {},
};

export function makeDb(
  cfg: Pick<SupabaseConfig, 'url' | 'serviceKey'> | null,
  fetchImpl: typeof fetch = fetch,
): Db {
  if (!cfg) return NOOP;
  const { url, serviceKey } = cfg;

  // One log line per table per failure STREAK — a dead network must not turn
  // the app log into a scroll of identical stack traces.
  const failing = new Set<string>();

  const upsert = (table: string, rows: unknown[]): void => {
    if (rows.length === 0) return;
    void fetchImpl(`${url}/rest/v1/${table}?on_conflict=id`, {
      method: 'POST',
      headers: {
        apikey: serviceKey,
        authorization: `Bearer ${serviceKey}`,
        'content-type': 'application/json',
        prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify(rows),
    })
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status}`);
        failing.delete(table);
      })
      .catch((e) => {
        if (!failing.has(table)) {
          failing.add(table);
          console.warn(`[db] mirror ${table} failing (${String(e).slice(0, 120)}) — disk remains truth`);
        }
      });
  };

  return {
    enabled: true,
    upsertUsers: (rows) => upsert('users', rows),
    mirrorReps: (rows) => upsert('reps', rows),
    mirrorTargets: (rows) => upsert('targets', rows),
    mirrorSessions: (rows) => upsert('sessions', rows),
  };
}

// ---- pure row builders (unit-tested; the wiring stays dumb) ----

export function repRow(
  rep: { id: string; user_id?: string; label: string; spec: unknown; status: string; created: string },
  legacyOwnerId: string,
  nowMs: number,
): RepRow {
  return {
    id: rep.id,
    user_id: rep.user_id ?? legacyOwnerId,
    label: rep.label,
    spec: rep.spec,
    status: rep.status,
    created_at: rep.created,
    updated_at: new Date(nowMs).toISOString(),
  };
}

export function targetRow(
  t: { id: string; user_id?: string; label: string; interview_date?: string; created: string },
  legacyOwnerId: string,
): TargetRow {
  return {
    id: t.id,
    user_id: t.user_id ?? legacyOwnerId,
    label: t.label,
    interview_date: t.interview_date ?? null,
    created_at: t.created,
  };
}

export function sessionRow(
  sid: string,
  fb: { user_id?: string; card?: { summary?: string; solved?: boolean } },
  assessment: unknown,
  legacyOwnerId: string,
  completedAtMs: number,
): SessionRow {
  return {
    id: sid,
    user_id: fb.user_id ?? legacyOwnerId,
    label: null,
    feedback: fb,
    assessment,
    solved: fb.card?.solved ?? null,
    completed_at: new Date(completedAtMs).toISOString(),
  };
}
