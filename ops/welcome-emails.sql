-- Idempotency ledger for the post-signup welcome sweep (server/src/welcome.ts).
-- Safe to run more than once — every statement here is idempotent.
--
-- The PRIMARY KEY is the whole point: welcome.ts claims a user by inserting
-- here with `Prefer: resolution=ignore-duplicates,return=representation` and
-- only sends when the insert actually created a row. Two overlapping sweeps,
-- or a sweep racing a manual run, cannot both win that insert — which is the
-- only reason a duplicate "hey, saw you signed up" is structurally impossible.
--
-- It lives in Postgres rather than in a file on the box because this is the
-- one irreversible outbound action in the system: a lost disk (which has
-- happened once — see backup.ts) would otherwise re-mail every existing user.
--
-- `kind` separates the two ways a row gets here:
--   'sent'       we actually emailed them
--   'suppressed' pre-claimed by `welcome-sweep --seed-existing` at cutover, so
--                the sweep can never reach them. Existing users must not get a
--                "saw you just signed up" email months after they signed up.

create table if not exists public.welcome_emails (
  user_id uuid primary key references auth.users (id) on delete cascade,
  email   text not null,
  kind    text not null default 'sent',
  sent_at timestamptz not null default now()
);

-- For a table created before `kind` existed.
alter table public.welcome_emails add column if not exists kind text not null default 'sent';

-- No policies are defined, so with RLS on, the anon and authenticated roles
-- reach nothing here. The sweep uses the service key, which bypasses RLS.
alter table public.welcome_emails enable row level security;

comment on table public.welcome_emails is
  'One row per user the welcome sweep will never mail again. Insert = claim.';

-- Useful after cutover:
--   select kind, count(*) from public.welcome_emails group by kind;
