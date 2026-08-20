/**
 * Post-signup welcome sweep — the "someone noticed you" email.
 *
 *   systemd timer (*:0/5) ──► cli.ts welcome-sweep ──► runWelcomeSweep()
 *        │
 *        ├─ GET /auth/v1/admin/users        auth.users is the ONLY place a
 *        │      (service key, paged)        signup timestamp lives; db.ts's
 *        │                                  mirrored public.users has no
 *        │                                  created_at column.
 *        ├─ eligible(): pure                created_at ≤ now−30m  (the delay)
 *        │                                  created_at ≥ now−24h  (the backstop)
 *        │                                  confirmed, not an admin
 *        │
 *        ├─ claim: INSERT welcome_emails ON CONFLICT DO NOTHING RETURNING *
 *        │      []  → someone already sent it, skip
 *        │      row → we own this send, and only we do
 *        │
 *        ├─ send (plain-text SMTP, injected)
 *        │      failure → DELETE the claim so the next sweep retries
 *        │
 *        └─ append outreach/sent.jsonl
 *
 * Why a POLL and not a database webhook: the requirement is "email them ~30
 * minutes after signup", and a webhook fires at signup. Bridging that gap
 * with an in-process timer means the delay dies with the process — a deploy,
 * a `systemctl restart`, or an OOM silently drops every pending welcome, and
 * nothing anywhere records that it happened. A sweep over a WINDOW has no
 * pending state to lose: whoever became eligible while the box was down is
 * still eligible when it comes back, and the 24h backstop is what stops a
 * week of downtime from ending in a hundred simultaneous "just noticed you
 * signed up!" emails to people who signed up last Tuesday.
 *
 * Why the claim lives in Postgres and not in outreach/sent.jsonl: this is the
 * one write in this repo whose failure mode is EXTERNAL and irreversible.
 * Every other ledger can be rebuilt from disk or re-mirrored harmlessly
 * (db.ts); a duplicate welcome email cannot be recalled, and the CPX31 losing
 * its disk once already cost every user's gap graph (backup.ts). A unique
 * constraint in Postgres is the only dedupe that survives that. The JSONL is
 * a human-readable log, never the guard.
 *
 * Table DDL: ops/welcome-emails.sql. Template: templates/welcome-email.md.
 */

/** The delay. Long enough not to read as an autoresponder, short enough that
 *  the signup is still the thing they were just doing. A 5-minute sweep
 *  spreads real sends across 30–35 min, which is its own de-robotifier. */
export const DELAY_MS = 30 * 60_000;

/** Nobody older than this gets mailed, ever. See the header. */
export const BACKSTOP_MS = 24 * 60 * 60_000;

const PAGE_SIZE = 100;
/** Order-independent: we page through and filter client-side rather than
 *  trusting GoTrue's list ordering. Beta-sized user bases fit in one or two
 *  pages; hitting the cap is LOGGED, never silently truncated. */
const MAX_PAGES = 5;
/** Rows per suppression insert. PostgREST takes an array; this only keeps
 *  a very large user list from becoming one enormous request body. */
const SEED_CHUNK = 500;

export interface SignupUser {
  id: string;
  email: string | null;
  created_at: string;
  email_confirmed_at?: string | null;
  confirmed_at?: string | null;
  user_metadata?: Record<string, unknown> | null;
}

export interface WelcomeConfig {
  supabaseUrl: string;
  serviceKey: string;
  adminEmails: string[];
  /** Overridable for testing the window without waiting 30 minutes. */
  delayMs?: number;
  backstopMs?: number;
}

export interface SentRow {
  user_id: string;
  email: string;
  sent_at: string;
  subject: string;
}

export type SendMail = (msg: { to: string; subject: string; text: string }) => Promise<void>;

// ---- pure (unit-tested; no I/O, no clock reads, nowMs injected) ----

/**
 * A greeting name from OAuth metadata, or 'there'. Deliberately conservative:
 * "Hey Zhang4021," is worse than "Hey there," — a mangled name reads as a mail
 * merge, which is the exact impression this email exists to avoid.
 *
 * The email local part is NOT a fallback, though it is the obvious one and the
 * first draft used it. Audited against the real user table (2026-08-20, 24
 * users): 20 arrive via Google OAuth carrying a real full_name, and for the 4
 * who do not, the local part produced "Hey Davidjsm,", "Hey Johnzz," and
 * "Hey Terrinoni," — three mangles to buy zero correct names. An address is an
 * identifier that often contains a name; it is not a name.
 */
export function firstName(u: Pick<SignupUser, 'email' | 'user_metadata'>): string {
  const meta = u.user_metadata ?? {};
  for (const key of ['full_name', 'name', 'first_name']) {
    const v = meta[key];
    if (typeof v === 'string' && v.trim()) {
      const tok = v.trim().split(/\s+/)[0]!;
      if (/^[A-Za-z][A-Za-z'-]{1,}$/.test(tok)) return tok[0]!.toUpperCase() + tok.slice(1);
    }
  }
  return 'there';
}

/**
 * `Subject: ...` first line, blank line, body. Substitution is the repo's
 * `{{PLACEHOLDER}}` convention (prompts/*.md).
 *
 * Throws on any surviving `{{...}}`. This is the gate: a half-rendered
 * template is not a degraded email, it is a "Hey {{FIRST_NAME}}," that
 * costs the reader's trust permanently. Nothing ungated reaches a user.
 */
export function renderTemplate(
  tpl: string,
  vars: Record<string, string>,
): { subject: string; text: string } {
  let out = tpl;
  for (const [k, v] of Object.entries(vars)) out = out.split(`{{${k}}}`).join(v);
  const leftover = out.match(/\{\{[A-Z_]+\}\}/);
  if (leftover) throw new Error(`unsubstituted placeholder ${leftover[0]} in welcome template`);

  const nl = out.indexOf('\n');
  const head = (nl === -1 ? out : out.slice(0, nl)).trim();
  const m = head.match(/^Subject:\s*(.+)$/i);
  if (!m) throw new Error('welcome template must begin with a `Subject: ...` line');
  const subject = m[1]!.trim();
  if (!subject) throw new Error('welcome template has an empty subject');
  const text = out.slice(nl + 1).replace(/^\s*\n/, '').trimEnd();
  if (!text) throw new Error('welcome template has an empty body');
  return { subject, text };
}

/**
 * The window. Pure so the 30-minute rule is testable without a 30-minute test.
 */
export function eligible(
  users: SignupUser[],
  opts: { nowMs: number; delayMs?: number; backstopMs?: number; adminEmails?: string[] },
): SignupUser[] {
  const delay = opts.delayMs ?? DELAY_MS;
  const backstop = opts.backstopMs ?? BACKSTOP_MS;
  const admins = new Set((opts.adminEmails ?? []).map((e) => e.trim().toLowerCase()).filter(Boolean));

  return users
    .filter((u) => {
      if (!u.email) return false;
      if (admins.has(u.email.toLowerCase())) return false;
      // Unconfirmed = we do not know the address is real, and mailing it is
      // how a sender reputation dies. They become eligible on confirmation.
      if (!(u.email_confirmed_at ?? u.confirmed_at)) return false;
      const t = Date.parse(u.created_at);
      if (!Number.isFinite(t)) return false;
      const age = opts.nowMs - t;
      return age >= delay && age <= backstop;
    })
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
}

/** "3h", "2d" — a preview reads better than an ISO timestamp when the
 *  question is "is this person recent?". */
export function humanAge(ms: number): string {
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

// ---- I/O (fetch injected; unit tests never touch the network) ----

export async function fetchSignups(
  cfg: Pick<WelcomeConfig, 'supabaseUrl' | 'serviceKey'>,
  fetchImpl: typeof fetch = fetch,
  log: (s: string) => void = console.warn,
): Promise<SignupUser[]> {
  const out: SignupUser[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const r = await fetchImpl(
      `${cfg.supabaseUrl}/auth/v1/admin/users?page=${page}&per_page=${PAGE_SIZE}`,
      { headers: { apikey: cfg.serviceKey, authorization: `Bearer ${cfg.serviceKey}` } },
    );
    if (!r.ok) throw new Error(`admin/users ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const body = (await r.json()) as { users?: SignupUser[] };
    const batch = body.users ?? [];
    out.push(...batch);
    if (batch.length < PAGE_SIZE) return out;
    if (page === MAX_PAGES) {
      log(`[welcome] page cap hit (${MAX_PAGES}×${PAGE_SIZE}); older signups not scanned this sweep`);
    }
  }
  return out;
}

/**
 * Atomic claim. `resolution=ignore-duplicates` + `return=representation`
 * gives back the inserted row, or `[]` when the unique constraint on
 * user_id already held one. That empty array IS the "already sent" answer —
 * a read-then-write check would race two overlapping sweeps.
 */
export async function claimUser(
  cfg: Pick<WelcomeConfig, 'supabaseUrl' | 'serviceKey'>,
  row: { user_id: string; email: string; kind?: string },
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const r = await fetchImpl(`${cfg.supabaseUrl}/rest/v1/welcome_emails`, {
    method: 'POST',
    headers: {
      apikey: cfg.serviceKey,
      authorization: `Bearer ${cfg.serviceKey}`,
      'content-type': 'application/json',
      prefer: 'resolution=ignore-duplicates,return=representation',
    },
    body: JSON.stringify([{ kind: 'sent', ...row }]),
  });
  if (!r.ok) throw new Error(`claim ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const back = (await r.json()) as unknown[];
  return Array.isArray(back) && back.length > 0;
}

/**
 * Read-only: which of these users already hold a claim.
 *
 * Exists for --dry-run. A preview that ignored the claim table would report
 * "would send" for people who are permanently suppressed — which is a false
 * alarm on the exact command you run to reassure yourself before enabling the
 * timer. The live path does NOT use this: it claims atomically instead, so a
 * read here could never be the guard.
 */
export async function fetchClaimed(
  cfg: Pick<WelcomeConfig, 'supabaseUrl' | 'serviceKey'>,
  userIds: string[],
  fetchImpl: typeof fetch = fetch,
): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();
  const list = userIds.map((id) => `"${id}"`).join(',');
  const r = await fetchImpl(
    `${cfg.supabaseUrl}/rest/v1/welcome_emails?select=user_id&user_id=in.(${encodeURIComponent(list)})`,
    { headers: { apikey: cfg.serviceKey, authorization: `Bearer ${cfg.serviceKey}` } },
  );
  if (!r.ok) throw new Error(`claims ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const rows = (await r.json()) as { user_id: string }[];
  return new Set(rows.map((x) => x.user_id));
}

/** Roll the claim back so the next sweep retries. A send that failed must not
 *  leave a tombstone that permanently suppresses the email. */
export async function releaseClaim(
  cfg: Pick<WelcomeConfig, 'supabaseUrl' | 'serviceKey'>,
  userId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const r = await fetchImpl(
    `${cfg.supabaseUrl}/rest/v1/welcome_emails?user_id=eq.${encodeURIComponent(userId)}`,
    {
      method: 'DELETE',
      headers: { apikey: cfg.serviceKey, authorization: `Bearer ${cfg.serviceKey}`, prefer: 'return=minimal' },
    },
  );
  if (!r.ok) throw new Error(`release ${r.status}`);
}

export interface SweepDeps {
  send: SendMail;
  template: string;
  fetchImpl?: typeof fetch;
  nowMs?: number;
  log?: (s: string) => void;
  onSent?: (row: SentRow) => void;
  /** Resolve who would be mailed, claim nothing, send nothing. */
  dryRun?: boolean;
}

export async function runWelcomeSweep(cfg: WelcomeConfig, deps: SweepDeps): Promise<string> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const nowMs = deps.nowMs ?? Date.now();
  const log = deps.log ?? console.log;

  const users = await fetchSignups(cfg, fetchImpl, log);
  const due = eligible(users, {
    nowMs,
    ...(cfg.delayMs !== undefined ? { delayMs: cfg.delayMs } : {}),
    ...(cfg.backstopMs !== undefined ? { backstopMs: cfg.backstopMs } : {}),
    adminEmails: cfg.adminEmails,
  });
  if (due.length === 0) return `[welcome] ${users.length} users scanned, none due`;

  // A preview that ignored existing claims would cry wolf on every user who
  // is already suppressed or already mailed. One read, dry run only.
  const preClaimed = deps.dryRun ? await fetchClaimed(cfg, due.map((u) => u.id), fetchImpl) : new Set<string>();

  let sent = 0;
  let skipped = 0;
  let failed = 0;
  for (const u of due) {
    const to = u.email!;
    const { subject, text } = renderTemplate(deps.template, {
      FIRST_NAME: firstName(u),
      EMAIL: to,
    });

    if (deps.dryRun) {
      if (preClaimed.has(u.id)) {
        skipped++;
        continue;
      }
      log(`[welcome] would send to ${to} (signed up ${u.created_at})\n  subject: ${subject}`);
      sent++;
      continue;
    }

    let claimed = false;
    try {
      claimed = await claimUser(cfg, { user_id: u.id, email: to }, fetchImpl);
    } catch (e) {
      failed++;
      log(`[welcome] claim failed for ${to}: ${String(e instanceof Error ? e.message : e)}`);
      continue;
    }
    if (!claimed) {
      skipped++;
      continue;
    }

    try {
      await deps.send({ to, subject, text });
      sent++;
      deps.onSent?.({ user_id: u.id, email: to, sent_at: new Date(nowMs).toISOString(), subject });
    } catch (e) {
      failed++;
      log(`[welcome] send failed for ${to}: ${String(e instanceof Error ? e.message : e)}`);
      try {
        await releaseClaim(cfg, u.id, fetchImpl);
      } catch {
        // The safe failure: the claim stands, so this user simply never gets
        // the email. Loud, because it is the one case a human must fix.
        log(`[welcome] CLAIM STUCK for ${u.id} <${to}> — delete its welcome_emails row to retry`);
      }
    }
  }

  const verb = deps.dryRun ? 'would send' : 'sent';
  return `[welcome] ${users.length} scanned, ${due.length} due, ${verb} ${sent}, already-sent ${skipped}, failed ${failed}`;
}

/**
 * Cutover suppression: claim EVERY user that exists right now, sending
 * nothing, so the sweep can only ever reach people who sign up after this
 * runs.
 *
 * Why this is a separate command and not a smarter window: the 24h backstop
 * bounds a disaster, it does not express "start from new users only". A
 * `created_at > <install time>` cutoff would — but it would have to live in a
 * config value or a file, and the day that value is lost or a box is rebuilt
 * from the template, the sweep silently rediscovers the entire user list as
 * eligible. Rows in the claim table cannot be lost that way: they are the
 * same guard that already stops a double send, and they say WHY (kind =
 * 'suppressed') the next time someone reads the table.
 *
 * Idempotent, and safe to run twice: the primary key absorbs the repeat.
 */
export async function seedExisting(
  cfg: WelcomeConfig,
  deps: { fetchImpl?: typeof fetch; log?: (s: string) => void; dryRun?: boolean; nowMs?: number },
): Promise<string> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const log = deps.log ?? console.log;

  const users = await fetchSignups(cfg, fetchImpl, log);
  const rows = users
    .filter((u) => u.email)
    .map((u) => ({ user_id: u.id, email: u.email!, kind: 'suppressed' }));
  if (rows.length === 0) return '[welcome] no existing users — nothing to suppress';

  if (deps.dryRun) {
    // The decision this preview exists to serve is "am I about to silence
    // someone I actually wanted to greet?" — so it shows each signup's AGE
    // and flags the ones that are eligible right now. Those are the only
    // rows seeding actually takes away from you; everything older was
    // already past the 24h backstop and unreachable either way.
    const nowMs = deps.nowMs ?? Date.now();
    const delay = cfg.delayMs ?? DELAY_MS;
    const backstop = cfg.backstopMs ?? BACKSTOP_MS;
    const byId = new Map(users.map((u) => [u.id, u]));
    const aged = rows
      .map((r) => {
        const u = byId.get(r.user_id)!;
        const age = nowMs - Date.parse(u.created_at);
        const confirmed = Boolean(u.email_confirmed_at ?? u.confirmed_at);
        return { email: r.email, age, inWindow: confirmed && age >= delay && age <= backstop };
      })
      .sort((x, y) => x.age - y.age);

    for (const r of aged) {
      log(`[welcome] ${r.inWindow ? 'WOULD BE MAILED ->' : '  already unreachable'} ${r.email} (signed up ${humanAge(r.age)} ago)`);
    }
    const live = aged.filter((r) => r.inWindow).length;
    return (
      `[welcome] would suppress ${rows.length} existing user(s); sends nothing, ever\n` +
      `[welcome] of those, ${live} would otherwise be mailed on the next tick — ` +
      `the remaining ${rows.length - live} are already past the 24h backstop`
    );
  }

  let claimed = 0;
  for (let i = 0; i < rows.length; i += SEED_CHUNK) {
    const chunk = rows.slice(i, i + SEED_CHUNK);
    const r = await fetchImpl(`${cfg.supabaseUrl}/rest/v1/welcome_emails`, {
      method: 'POST',
      headers: {
        apikey: cfg.serviceKey,
        authorization: `Bearer ${cfg.serviceKey}`,
        'content-type': 'application/json',
        prefer: 'resolution=ignore-duplicates,return=representation',
      },
      body: JSON.stringify(chunk),
    });
    if (!r.ok) throw new Error(`seed ${r.status}: ${(await r.text()).slice(0, 200)}`);
    claimed += ((await r.json()) as unknown[]).length;
  }
  return `[welcome] ${rows.length} existing user(s) scanned, ${claimed} newly suppressed, ${rows.length - claimed} already claimed`;
}
