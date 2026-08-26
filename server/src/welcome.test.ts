/**
 * The sweep's contract: the 30-minute window and its 24h backstop, a gated
 * template that refuses to half-render, and claim-before-send with rollback
 * so a duplicate welcome email is structurally impossible and a failed send
 * is retried. Injected fetch and injected sender — no network, no SMTP.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  BACKSTOP_MS,
  DELAY_MS,
  claimUser,
  eligible,
  fetchSignups,
  firstName,
  humanAge,
  renderTemplate,
  runWelcomeSweep,
  seedExisting,
  type SignupUser,
} from './welcome.js';

const CFG = { supabaseUrl: 'https://x.supabase.co', serviceKey: 'svc', adminEmails: ['boss@zenkai.run'] };
const NOW = Date.parse('2026-08-20T12:00:00Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

const user = (over: Partial<SignupUser> = {}): SignupUser => ({
  id: over.id ?? 'u-1',
  email: 'ada@example.com',
  // The common case: a Google OAuth signup carrying a real full_name.
  user_metadata: { full_name: 'Ada Lovelace' },
  created_at: ago(45 * 60_000),
  email_confirmed_at: ago(45 * 60_000),
  ...over,
});

const TPL = 'Subject: hi {{FIRST_NAME}}\n\nHey {{FIRST_NAME}},\n\nbody.\n';

describe('eligible', () => {
  it('holds a signup until the delay has passed, then releases it', () => {
    const fresh = user({ created_at: ago(DELAY_MS - 60_000), email_confirmed_at: ago(0) });
    const ripe = user({ created_at: ago(DELAY_MS + 60_000), email_confirmed_at: ago(0) });
    expect(eligible([fresh], { nowMs: NOW })).toEqual([]);
    expect(eligible([ripe], { nowMs: NOW })).toHaveLength(1);
  });

  it('the backstop drops signups older than 24h', () => {
    const stale = user({ created_at: ago(BACKSTOP_MS + 60_000), email_confirmed_at: ago(BACKSTOP_MS) });
    expect(eligible([stale], { nowMs: NOW })).toEqual([]);
  });

  it('skips unconfirmed addresses and admins', () => {
    const unconfirmed = user({ id: 'u-2', email_confirmed_at: null, confirmed_at: null });
    const admin = user({ id: 'u-3', email: 'Boss@Zenkai.run' });
    const got = eligible([unconfirmed, admin, user()], { nowMs: NOW, adminEmails: CFG.adminEmails });
    expect(got.map((u) => u.id)).toEqual(['u-1']);
  });

  it('accepts confirmed_at when email_confirmed_at is absent (older projects)', () => {
    const u = user({ email_confirmed_at: undefined, confirmed_at: ago(40 * 60_000) });
    expect(eligible([u], { nowMs: NOW })).toHaveLength(1);
  });

  it('drops rows with no email or an unparseable timestamp', () => {
    const noEmail = user({ id: 'u-4', email: null });
    const junk = user({ id: 'u-5', created_at: 'not-a-date' });
    expect(eligible([noEmail, junk], { nowMs: NOW })).toEqual([]);
  });

  it('returns oldest first, so a backlog drains in signup order', () => {
    const a = user({ id: 'a', created_at: ago(3 * 60 * 60_000), email_confirmed_at: ago(0) });
    const b = user({ id: 'b', created_at: ago(2 * 60 * 60_000), email_confirmed_at: ago(0) });
    expect(eligible([b, a], { nowMs: NOW }).map((u) => u.id)).toEqual(['a', 'b']);
  });
});

describe('firstName', () => {
  it('prefers metadata, first token only, capitalized', () => {
    expect(firstName({ email: 'x@y.z', user_metadata: { full_name: 'ada lovelace' } })).toBe('Ada');
  });
  it('never mines the email address for a name', () => {
    // Audited against the real table: the local part bought zero correct
    // names and three mangles. An address is not a name.
    expect(firstName({ email: 'ada.lovelace@example.com', user_metadata: null })).toBe('there');
    expect(firstName({ email: 'davidjsm@umich.edu', user_metadata: null })).toBe('there');
    expect(firstName({ email: 'terrinoni.media@gmail.com', user_metadata: null })).toBe('there');
    expect(firstName({ email: 'zhang4021@gmail.com', user_metadata: null })).toBe('there');
  });
  it('takes an OAuth full_name over anything in the address', () => {
    expect(firstName({ email: 'davidjsm@umich.edu', user_metadata: { full_name: 'David Smith' } })).toBe('David');
  });
});

describe('renderTemplate', () => {
  it('splits the Subject line from the body and substitutes', () => {
    const { subject, text } = renderTemplate(TPL, { FIRST_NAME: 'Ada', EMAIL: 'a@b.c' });
    expect(subject).toBe('hi Ada');
    expect(text).toBe('Hey Ada,\n\nbody.');
  });
  it('throws rather than mail a surviving placeholder', () => {
    expect(() => renderTemplate('Subject: s\n\nHey {{FIRST_NAME}}, {{COMPANY}}', { FIRST_NAME: 'Ada' }))
      .toThrow(/COMPANY/);
  });
  it('throws without a Subject line', () => {
    expect(() => renderTemplate('Hey {{FIRST_NAME}}', { FIRST_NAME: 'Ada' })).toThrow(/Subject:/);
  });
});

describe('fetchSignups', () => {
  it('stops on a short page and sends the service key', async () => {
    const seen: string[] = [];
    const f = vi.fn(async (url: string) => {
      seen.push(url);
      return { ok: true, json: async () => ({ users: [user()] }) } as unknown as Response;
    });
    const got = await fetchSignups(CFG, f as never);
    expect(got).toHaveLength(1);
    expect(seen).toEqual(['https://x.supabase.co/auth/v1/admin/users?page=1&per_page=100']);
  });

  it('throws on a non-ok response rather than treating it as zero signups', async () => {
    const f = vi.fn(async () => ({ ok: false, status: 401, text: async () => 'bad key' }) as unknown as Response);
    await expect(fetchSignups(CFG, f as never)).rejects.toThrow(/401/);
  });
});

describe('claimUser', () => {
  it('an inserted row means we own the send', async () => {
    const f = vi.fn(async () => ({ ok: true, json: async () => [{ user_id: 'u-1' }] }) as unknown as Response);
    await expect(claimUser(CFG, { user_id: 'u-1', email: 'a@b.c' }, f as never)).resolves.toBe(true);
    const init = (f.mock.calls[0] as unknown[])[1] as RequestInit;
    expect((init.headers as Record<string, string>).prefer).toContain('ignore-duplicates');
  });
  it('an empty array means someone already sent it', async () => {
    const f = vi.fn(async () => ({ ok: true, json: async () => [] }) as unknown as Response);
    await expect(claimUser(CFG, { user_id: 'u-1', email: 'a@b.c' }, f as never)).resolves.toBe(false);
  });
});

// ---- the sweep, end to end over a fake Supabase ----

function fakeSupabase(opts: { users: SignupUser[]; claimed?: Set<string> }) {
  const claimed = opts.claimed ?? new Set<string>();
  const deletes: string[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes('/auth/v1/admin/users')) {
      return { ok: true, json: async () => ({ users: opts.users }) } as unknown as Response;
    }
    if (!init || init.method === undefined || init.method === 'GET') {
      // the read-only claims probe used by --dry-run
      return { ok: true, json: async () => [...claimed].map((id) => ({ user_id: id })) } as unknown as Response;
    }
    if (init?.method === 'DELETE') {
      const id = decodeURIComponent(url.split('user_id=eq.')[1]!);
      claimed.delete(id);
      deletes.push(id);
      return { ok: true } as unknown as Response;
    }
    // PostgREST takes an ARRAY: claimUser sends one row, seedExisting sends a
    // batch. `ignore-duplicates` + `return=representation` gives back only the
    // rows that were actually inserted — which is the whole claim protocol.
    const rows = JSON.parse(String(init!.body)) as { user_id: string }[];
    const inserted = rows.filter((r) => !claimed.has(r.user_id));
    for (const r of rows) claimed.add(r.user_id);
    return { ok: true, json: async () => inserted } as unknown as Response;
  });
  return { fetchImpl, claimed, deletes };
}

describe('runWelcomeSweep', () => {
  it('sends once and logs the send', async () => {
    const { fetchImpl } = fakeSupabase({ users: [user()] });
    const sent: { to: string; subject: string }[] = [];
    const rows: unknown[] = [];
    const out = await runWelcomeSweep(CFG, {
      template: TPL,
      fetchImpl: fetchImpl as never,
      nowMs: NOW,
      log: () => {},
      send: async (m) => void sent.push(m),
      onSent: (r) => void rows.push(r),
    });
    expect(sent).toEqual([{ to: 'ada@example.com', subject: 'hi Ada', text: 'Hey Ada,\n\nbody.' }]);
    expect(rows).toHaveLength(1);
    expect(out).toContain('sent 1');
  });

  it('a second sweep over the same user sends nothing', async () => {
    const fake = fakeSupabase({ users: [user()] });
    const sent: unknown[] = [];
    const deps = {
      template: TPL,
      fetchImpl: fake.fetchImpl as never,
      nowMs: NOW,
      log: () => {},
      send: async (m: unknown) => void sent.push(m),
    };
    await runWelcomeSweep(CFG, deps);
    const out = await runWelcomeSweep(CFG, deps);
    expect(sent).toHaveLength(1);
    expect(out).toContain('already-sent 1');
  });

  it('a failed send releases the claim so the next sweep retries', async () => {
    const fake = fakeSupabase({ users: [user()] });
    const sent: unknown[] = [];
    let fail = true;
    const deps = {
      template: TPL,
      fetchImpl: fake.fetchImpl as never,
      nowMs: NOW,
      log: () => {},
      send: async (m: unknown) => {
        if (fail) throw new Error('535 auth');
        sent.push(m);
      },
    };
    const first = await runWelcomeSweep(CFG, deps);
    expect(first).toContain('failed 1');
    expect(fake.deletes).toEqual(['u-1']);
    fail = false;
    await runWelcomeSweep(CFG, deps);
    expect(sent).toHaveLength(1);
  });

  it('dry run claims nothing and sends nothing', async () => {
    const fake = fakeSupabase({ users: [user()] });
    const out = await runWelcomeSweep(CFG, {
      template: TPL,
      fetchImpl: fake.fetchImpl as never,
      nowMs: NOW,
      log: () => {},
      dryRun: true,
      send: async () => {
        throw new Error('must not send on a dry run');
      },
    });
    expect(fake.claimed.size).toBe(0);
    expect(out).toContain('would send 1');
  });

  it('an empty window is a quiet no-op', async () => {
    const { fetchImpl } = fakeSupabase({ users: [user({ created_at: ago(60_000), email_confirmed_at: ago(0) })] });
    const out = await runWelcomeSweep(CFG, {
      template: TPL,
      fetchImpl: fetchImpl as never,
      nowMs: NOW,
      log: () => {},
      send: async () => {
        throw new Error('must not send');
      },
    });
    expect(out).toContain('none due');
  });
});

describe('seedExisting (cutover suppression)', () => {
  it('claims every current user and sends nothing', async () => {
    const users = [
      user({ id: 'a', email: 'a@x.com' }),
      user({ id: 'b', email: 'b@x.com', created_at: ago(30 * 24 * 3600_000) }),
      user({ id: 'c', email: 'c@x.com', email_confirmed_at: null }), // unconfirmed too
    ];
    const fake = fakeSupabase({ users });
    const out = await seedExisting(CFG, { fetchImpl: fake.fetchImpl as never, log: () => {} });
    expect([...fake.claimed].sort()).toEqual(['a', 'b', 'c']);
    expect(out).toContain('3 newly suppressed');
  });

  it("suppression means a later sweep mails nobody who existed at cutover", async () => {
    const fake = fakeSupabase({ users: [user()] });
    await seedExisting(CFG, { fetchImpl: fake.fetchImpl as never, log: () => {} });
    const out = await runWelcomeSweep(CFG, {
      template: TPL,
      fetchImpl: fake.fetchImpl as never,
      nowMs: NOW,
      log: () => {},
      send: async () => {
        throw new Error('an existing user must never be mailed');
      },
    });
    expect(out).toContain('already-sent 1');
  });

  it('a user who signs up AFTER the seed still gets mailed', async () => {
    const existing = user({ id: 'old', email: 'old@x.com' });
    const fake = fakeSupabase({ users: [existing] });
    await seedExisting(CFG, { fetchImpl: fake.fetchImpl as never, log: () => {} });

    // Same fake DB, new signup appears in the user list afterwards.
    const later = fakeSupabase({
      users: [existing, user({ id: 'new', email: 'new@x.com' })],
      claimed: fake.claimed,
    });
    const sent: { to: string }[] = [];
    await runWelcomeSweep(CFG, {
      template: TPL,
      fetchImpl: later.fetchImpl as never,
      nowMs: NOW,
      log: () => {},
      send: async (m) => void sent.push(m),
    });
    expect(sent.map((m) => m.to)).toEqual(['new@x.com']);
  });

  it('is idempotent — a second seed claims nothing new', async () => {
    const fake = fakeSupabase({ users: [user()] });
    await seedExisting(CFG, { fetchImpl: fake.fetchImpl as never, log: () => {} });
    const out = await seedExisting(CFG, { fetchImpl: fake.fetchImpl as never, log: () => {} });
    expect(out).toContain('0 newly suppressed');
  });

  it('dry run claims nothing', async () => {
    const fake = fakeSupabase({ users: [user()] });
    const out = await seedExisting(CFG, { fetchImpl: fake.fetchImpl as never, log: () => {}, dryRun: true });
    expect(fake.claimed.size).toBe(0);
    expect(out).toContain('would suppress 1');
  });
});

describe('dry run vs the claim table', () => {
  it('reports a suppressed user as already-sent, not as a pending send', async () => {
    const fake = fakeSupabase({ users: [user()] });
    await seedExisting(CFG, { fetchImpl: fake.fetchImpl as never, log: () => {} });
    const out = await runWelcomeSweep(CFG, {
      template: TPL,
      fetchImpl: fake.fetchImpl as never,
      nowMs: NOW,
      log: () => {},
      dryRun: true,
      send: async () => {
        throw new Error('must not send on a dry run');
      },
    });
    expect(out).toContain('would send 0');
    expect(out).toContain('already-sent 1');
  });
});

describe('seed dry run tells you what you are giving up', () => {
  it('flags only the users who would actually be mailed on the next tick', async () => {
    const users = [
      user({ id: 'live', email: 'live@x.com', created_at: ago(90 * 60_000), email_confirmed_at: ago(89 * 60_000) }),
      user({ id: 'tooNew', email: 'toonew@x.com', created_at: ago(2 * 60_000), email_confirmed_at: ago(60_000) }),
      user({ id: 'old', email: 'old@x.com', created_at: ago(20 * 24 * 3600_000), email_confirmed_at: ago(20 * 24 * 3600_000) }),
    ];
    const fake = fakeSupabase({ users });
    const lines: string[] = [];
    const out = await seedExisting(CFG, {
      fetchImpl: fake.fetchImpl as never,
      log: (s) => void lines.push(s),
      dryRun: true,
      nowMs: NOW,
    });
    expect(lines.find((l) => l.includes('live@x.com'))).toContain('WOULD BE MAILED');
    expect(lines.find((l) => l.includes('toonew@x.com'))).toContain('already unreachable');
    expect(lines.find((l) => l.includes('old@x.com'))).toContain('already unreachable');
    expect(out).toContain('1 would otherwise be mailed on the next tick');
    expect(out).toContain('0 already suppressed');
    expect(fake.claimed.size).toBe(0);
  });

  it('humanAge reads as minutes, hours, then days', () => {
    expect(humanAge(5 * 60_000)).toBe('5m');
    expect(humanAge(3 * 3600_000)).toBe('3h');
    expect(humanAge(9 * 24 * 3600_000)).toBe('9d');
  });
});

describe('seed preview after a seed', () => {
  it('reports already-suppressed users as such, not as pending sends', async () => {
    const fake = fakeSupabase({ users: [user({ id: 'live', email: 'live@x.com' })] });
    await seedExisting(CFG, { fetchImpl: fake.fetchImpl as never, log: () => {} });
    const lines: string[] = [];
    const out = await seedExisting(CFG, {
      fetchImpl: fake.fetchImpl as never,
      log: (l) => void lines.push(l),
      dryRun: true,
      nowMs: NOW,
    });
    expect(lines.find((l) => l.includes('live@x.com'))).toContain('already suppressed');
    expect(lines.find((l) => l.includes('live@x.com'))).not.toContain('WOULD BE MAILED');
    expect(out).toContain('0 would otherwise be mailed');
    expect(out).toContain('would suppress 0 more');
  });
});
