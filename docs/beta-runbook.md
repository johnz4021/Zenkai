# Beta runbook — zenkai.run

The no-code half of the beta. Everything code-side shipped on the `beta`
branch; this is what the founder does once, plus the per-day ops.

> **Rev 2 (2026-08-11): the beta hosts on a VPS, not the founder's laptop**
> (decision logged; concurrent sessions shipped as TODOS #22). Sections 1
> (Supabase) and 6 (success gate) are unchanged. Sections 2/3/5 below are
> superseded by "VPS cutover" at the end — **Caddy replaces the Cloudflare
> tunnel** (Cloudflare's fixed 100s proxy timeout sits in front of the
> planner's inline web-search calls; Caddy's is configurable), `caffeinate`
> is dead, and multi-session env vars are part of the config.

## 1. Supabase project (~15 min)

1. Create a project at supabase.com (free tier).
2. **Auth → Providers:** enable **Google** (no email deliverability risk) and
   leave **Email** enabled — the login screen offers Google plus email +
   password. The old 6-digit OTP flow is gone precisely because it round-trips
   through email, and the built-in Supabase sender is rate-limited to a handful
   of mails an hour.

   ⚠️ **Auth → Settings → turn OFF "Confirm email".** It is ON by default, and
   with it on a password signup returns a user with **no session** — the person
   is told to click a link this beta cannot reliably deliver, which reinstates
   exactly the problem password auth was meant to remove. The client handles
   that case honestly ("check your email to confirm it, then sign in") but it
   is a dead end for the user until you flip this. Turn it back on, with custom
   SMTP, whenever the beta stops being ten people you know.
3. **Auth → Settings → Access token expiry: `86400`** (24h). Sessions run
   longer than the 1h default and the beta has no refresh flow; an expiring
   token mid-round would 401 the voice socket.
4. **Auth → URL configuration:** site URL `https://zenkai.run`, additional
   redirect URL `https://zenkai.run/`.
5. **SQL editor** — run once:

```sql
create table users (
  id text primary key,          -- internal id: supabase uid, or 'u1' for the founder
  email text unique not null,
  is_admin boolean default false,
  created_at timestamptz default now()
);
create table reps (
  id text primary key, user_id text not null, label text, spec jsonb,
  status text, created_at timestamptz, updated_at timestamptz
);
create table targets (
  id text primary key, user_id text not null, label text,
  interview_date date, created_at timestamptz
);
create table sessions (
  id text primary key, user_id text not null, label text,
  feedback jsonb, assessment jsonb, solved boolean, completed_at timestamptz
);
-- RLS on, NO policies: only the service key (server-side) can touch these.
alter table users    enable row level security;
alter table reps     enable row level security;
alter table targets  enable row level security;
alter table sessions enable row level security;
```

6. Copy from Settings → API into `.env` (template below): project URL, anon
   key, service role key. **New projects sign JWTs asymmetrically** and the
   server verifies via public JWKS automatically. If the dashboard shows a
   legacy HS256 "JWT secret" instead, also set `IP_SUPABASE_JWT_SECRET`.

   **Trap — never probe these keys with `grep | cut`.** `.env.example` puts an
   explanatory `# comment` at the end of the two key lines, and the repo's
   `.env` inherits them. `process.loadEnvFile` strips a trailing comment, so
   the app gets a clean key and works; a shell one-liner like
   `grep '^IP_SUPABASE_ANON_KEY=' .env | cut -d= -f2-` does **not**, and hands
   curl the key plus ~50 trailing characters. Supabase answers that with
   `401 {"message":"Invalid API key"}` on **every** endpoint — including
   `/auth/v1/health`, which needs no key at all — so it reads exactly like
   revoked credentials. This cost an hour during the launch pre-flight and
   produced a confident, wrong diagnosis of "the project migrated to
   asymmetric signing and retired the legacy keys."

   Probe through the same loader the app uses, never through the shell:

   ```bash
   ssh zenkai-box "node -e \"process.loadEnvFile('/home/zenkai/Zenkai/.env');
     const U=process.env.IP_SUPABASE_URL, S=process.env.IP_SUPABASE_SERVICE_KEY;
     for (const t of ['users','reps','targets','sessions'])
       fetch(\\\`\\\${U}/rest/v1/\\\${t}?select=*&limit=1\\\`,
         {headers:{apikey:S, authorization:\\\`Bearer \\\${S}\\\`}})
         .then(r =\> console.log(t, r.status));\""
   ```

   Those four are the *only* tables the mirror touches (`db.ts` upserts
   `users`/`reps`/`targets`/`sessions`); a 404 on anything else means you
   invented a table name, not that the schema is incomplete. Separately, an
   ES256 JWKS on the project is normal and needs no action — `auth.ts` prefers
   that path already, and it says nothing about whether the API keys are live.
7. Invite management: see 1b — Google's **test users list IS the allowlist**.
   To revoke someone, remove them there (and delete the row in Supabase
   Auth → Users to clear the session).

## 1b. Google OAuth credentials (~15 min, required for Google sign-in)

Supabase does not provide Google credentials — you create an OAuth client and
paste it in. Google renamed this surface in 2024: the old "OAuth consent
screen" menu is now **Google Auth Platform**, three tabs.

1. **Branding** — app name (Zenkai), support email.
2. **Audience** — user type **External**, publishing status **Testing**, and
   **add each invitee's Gmail address as a test user**.
3. **Data access** — `userinfo.email` and `userinfo.profile` are default;
   **add `openid` manually**, Supabase needs it and it is not there by default.
4. **Clients** → Create OAuth client → **Web application**:
   - Authorized JavaScript origin: `https://zenkai.run`
   - Authorized redirect URI: **Supabase's callback**, copied verbatim from
     the Google provider page in the Supabase dashboard —
     `https://<project-ref>.supabase.co/auth/v1/callback`. A mismatch here is
     the most common failure and it surfaces as an opaque redirect error.
5. Paste **Client ID + Client Secret** into Supabase → Auth → Providers → Google.

**Why Testing status is the right answer, not a limitation:** an External app
in Testing only permits explicitly-listed test users (cap 100), so Google
enforces the invite allowlist for you. No verification is needed either —
email/profile are non-sensitive scopes, so there is no multi-day Google review.

⚠️ **Google's test-user list is no longer the whole allowlist.** It gates the
*Google* button only. Since the login screen also offers email + password,
anyone with the URL can create an account without appearing in that list. That
is consistent with signup being open by decision (2026-08-12) — but if you were
treating the Google list as the invite control, it is not anymore. If you need
a real gate, it has to live server-side (an allowlist checked in `auth.ts`), not
in Google's console.

**The one caveat:** test-user authorizations expire 7 days after consent. An
invitee returning after a week re-sees the consent screen. It does not break
their Zenkai session (that runs on the Supabase JWT, set to 24h) — it is
friction, not a wall. Publishing the app removes the expiry but also removes
the allowlist, so keep Testing for the beta.

## 2. Cloudflare tunnel (~20 min, needs zenkai.run on Cloudflare DNS)

```bash
brew install cloudflared
cloudflared tunnel login
cloudflared tunnel create zenkai-beta
cloudflared tunnel route dns zenkai-beta zenkai.run
cloudflared tunnel route dns zenkai-beta session.zenkai.run
```

`~/.cloudflared/config.yml`:

```yaml
tunnel: <TUNNEL-UUID>
credentials-file: /Users/johnzhang/.cloudflared/<TUNNEL-UUID>.json
ingress:
  - hostname: zenkai.run
    service: http://localhost:3300
  - hostname: session.zenkai.run
    service: http://localhost:3200
  - service: http_status:404
```

**Superseded in rev 2 — see §7.** The VPS terminates TLS itself with Caddy
(`ops/Caddyfile`): same free HTTPS that `getUserMedia` requires, native
WebSocket proxying, and timeouts you control. Keep this section only if you
ever go back to serving from a laptop.

## 3. `.env` additions

```bash
IP_PUBLIC_APP_URL=https://zenkai.run
IP_PUBLIC_SESSION_URL=https://session.zenkai.run
IP_APP_BIND=127.0.0.1
IP_SUPABASE_URL=https://<project>.supabase.co
IP_SUPABASE_ANON_KEY=<anon key>
IP_SUPABASE_SERVICE_KEY=<service role key>
IP_AUTH_ADMIN_EMAILS=zhang4021@gmail.com
IP_MAX_CONCURRENT_BUILDS=1
IP_MAX_REPS_PER_USER_DAY=3
IP_MAX_PENDING_REPS_PER_USER=4
IP_RETENTION_DAYS=14
IP_REAP_NODE_MODULES=1
```

Unset all of it and the product is byte-identical to pre-beta local dev
(pinned by `public-config.test.ts`).

## 4. Pre-invite verification (the plan's LAN-bypass + stranger checks)

```bash
npm test && npx tsc -b shared server          # 723 tests, all pure
npx tsx server/src/cli.ts app                 # with the beta .env
# From ANOTHER device on your LAN (auth must hold without the tunnel):
curl -s -o /dev/null -w '%{http_code}\n' http://<lan-ip>:3200/api/status   # 401
curl -s -o /dev/null -w '%{http_code}\n' -H 'Authorization: Bearer garbage' http://<lan-ip>:3200/api/status  # 401
# Incognito, an invited test account:
#  zenkai.run → login → composer + beta tag, EMPTY reps/targets, no founder data
#  paste a JD → clarify → build → Start → session.zenkai.run loads, mic prompts,
#  voice chip live, interviewer speaks
#  finish → card renders (memory note under the "Session 1 of 3" line)
#  → visible in that account's history; 404 from a second account; visible to you
# While the stranger sessions: stat -f %m gaps/u1.json  (must not change)
# Supabase: sessions table has the row.
```

## 5. Serving days

- `caffeinate -dimsu` in a terminal — a sleeping laptop kills tunnel + container silently.
- Health check before each invited slot: `curl -s localhost:3300/api/state | head -c 200`.
- Docker Desktop running.
- Canned recovery message: *"that broke on my end — here's a fresh link, your
  work is saved."* (The trace survives on disk; `cli.ts rejudge <sid>` grades it.)
- Watch spend: each round ≈ a 5-min opus generation + ≤$1 voice. Caps bound it
  at ~30 builds/day worst case if all ten invitees max out.

## 6. Success gate (from the design doc — write results in beta-signal.md)

- **Done condition:** one `feedback/<sid>.json` (and one Supabase `sessions`
  row) from a session you did not start, with `user_id != u1`.
- ≥3 invite redemptions (any launch) · ≥1 completed round · ≥1 unprompted
  follow-up ("when's the next one / can I do another").
- Upvotes and "this is sick" count as **zero**.

## 6a. Willingness-to-pay gate (`paywall.ts`)

The gate above asks *would you do another round*. This asks *would you buy
one* — and unlike a survey it actually stops someone, which is the only way
the answer means anything. Armed by `IP_PAYWALL_GATE=1` (already in
`ops/env.launch.template`): after 3 rounds (or 3 plans) a user sees a price and
does not get that round until they answer. Pressing Subscribe records intent,
reveals that payments are not switched on yet, and unlocks them for the rest of
the beta. **No card details are collected anywhere.**

You are an admin, so you never see it and nothing you click is recorded.

**KILL SWITCH — know this before you serve.** Comment out `IP_PAYWALL_GATE`
and `sudo systemctl restart zenkai-app`. About ten seconds, and
`KillMode=process` means nobody's live round is touched. One bad report from a
beta user and it is off; no deploy, no code change.

**Pull it** (lives only on the box; gitignored, in `BACKUP_PATHS`):

```bash
ssh zenkai@<box-ip> 'cat Zenkai/paywall.jsonl' > paywall.jsonl
```

**Read it deduped BY PERSON, never by row** — someone gated four times is one
data point, not four:

```bash
jq -r '[.action,.user_id] | @tsv' paywall.jsonl | sort -u | cut -f1 | sort | uniq -c
jq -r 'select(.expect) | "\(.email)\t\(.expect)"' paywall.jsonl
```

The five actions: `gated` (the denominator — actually stopped), `would_pay`
(pressed Subscribe), `not_yet` (declined, got no round),
`would_pay_confirmed` (agreed to be emailed about paying) and
`notify_declined`.

**`would_pay_confirmed` is the honest number.** `would_pay` costs nothing and
still yields the round, so it is a ceiling. Agreeing to be contacted about
paying is a second deliberate act — the gap between the two is the size of the
cheap-talk problem, measured instead of assumed.

**The decision rule, written down before any data exists** (same
pre-registration discipline as "upvotes count as zero" above — a rule invented
after seeing the numbers is not a rule):

- **≥5 distinct users gated, ≥1 distinct `would_pay_confirmed`** → there is a
  price worth pursuing. Read the `expect` free text for where it sits.
- **≥5 gated, several `would_pay` but 0 `would_pay_confirmed`** → people will
  click a free button and will not commit. Treat as no at $39.
- **≥5 gated, 0 `would_pay`** → no at $39. Lower `IP_PAYWALL_PRICE_USD` and
  run again rather than concluding there is no business.
- **<5 distinct users gated** → **the instrument did not run.** Not a negative
  result. Lower `IP_PAYWALL_FREE_ROUNDS`, or get more users, and try again.

Two honesty notes for whoever reads it. Every `expect` answer was given
*after* seeing $39, so it is anchored — read them as a floor, not an estimate.
And a fresh email resets the counter, since signup is open by decision; at
this size that costs precision, not money.

## 7. VPS cutover (supersedes 2, 3 and 5 — rev 2)

Box: **Hetzner CPX31, Ashburn (US East)** — 4 vCPU AMD / 8GB / 160GB NVMe.
Price moved during 2026; read the live figure in the console (roughly $18-25/mo,
plus a small IPv4 fee). US boxes carry 1-8TB traffic vs the EU's 20-60TB —
irrelevant at this scale.

**The CX line is NOT an option here.** Hetzner's US locations offer only the
AMD products (CPX shared, CCX dedicated) — CX is Intel and EU-only. A German
CX32 is ~€6.80/mo for the same cores and RAM, but adds 90-160ms to every
keystroke in the browser-hosted IDE and a beat of dead air to every voice
turn. Latency IS the product in a live interview simulator; pay the ~$10.

Sizing, measured rather than guessed: an idle openvscode container is ~29MB
and the three images total ~1.5GB on disk. RAM goes to active rooms
(extension host + language servers + test runs) and `npm install` spikes
during generation, so 8GB carries 2-3 rooms plus a build. Disk: ~3GB Ubuntu +
~1.5GB images + ~1GB deps + the ~5GB retention ceiling ≈ 11GB of 160GB.
CPX21 (3 vCPU / 4GB) is the tempting economy and the wrong one — two live
rooms plus a build is exactly where 4GB runs out. If you outgrow CPX31:
CPU/RAM upgrades are reversible, a DISK resize is permanent.

```bash
# on your machine
scp -r ops root@<box-ip>:
ssh root@<box-ip> 'bash ops/provision.sh'     # idempotent; prints remaining steps
# Image: Ubuntu 24.04 LTS (26.04 works — NodeSource is codename-independent —
# but 24.04 is two years hardened and supported to 2029, well past this beta).
# it installs: docker, lsof (assertPortFree DIES without it on Ubuntu minimal),
# node22 (Node 20 hit EOL 2026-04-30; this box is public), claude CLI, Caddy,
# the zenkai user, systemd units, and sets ufw:
# OpenSSH + 80/443 (Caddy) + `allow in on docker0`. WITHOUT the docker0 rule
# the container's trace WebSocket is silently dropped and every IDE round
# records nothing while looking perfectly healthy. The app (3300) and session
# ports (3200, 3401+) are NEVER opened — Caddy reaches them over loopback.

# .env — fill ops/env.launch.template and ship that (it carries the LAUNCH
# sizing: 4 concurrent rooms, 2 concurrent builds, and the spend note).
scp ops/env.launch.template zenkai@<box-ip>:Zenkai/.env

# DNS: A records for BOTH hostnames -> this box's IPv4, wherever your
# domain's DNS lives (no migration needed). If DNS happens to be on
# Cloudflare, set both to "DNS only" (grey cloud) — the proxied path has a
# fixed 100s timeout and /api/plan/turn awaits a web-search model call.
#   zenkai.run          A  <box-ip>
#   session.zenkai.run  A  <box-ip>

ssh root@<box-ip> 'sed -i "s/zhang4021@gmail.com/<your-email>/" /etc/caddy/Caddyfile'
ssh root@<box-ip> 'systemctl start zenkai-app caddy'
ssh root@<box-ip> 'journalctl -u caddy -n 30 --no-pager'   # "certificate obtained successfully"
```

**Multi-session smoke (before any invite):**
1. Two browser profiles, two invited accounts → launch a round each →
   `docker ps` shows `ip-session-sess-…` ×2; both rooms independently live
   through session.zenkai.run (each URL carries its own `?sid=`).
2. **Trace smoke, the #1 latent breaker:** during an IDE round,
   `wc -l traces/<sid>.jsonl` grows as you edit. If it doesn't → `ufw status`
   and re-add `allow in on docker0`.
3. Third launch → "all 2 interview rooms are busy". Kill one → slot frees.
4. A graded round's card: reachable for 30 min at its session URL, forever
   under history (confirms now POST to the app, so "did this match?" works
   from history indefinitely).
5. `docker stats` with 2 rooms + 1 generation: headroom on 8GB.

**Serving days on the VPS:** nothing. systemd restarts crashes; Caddy renews
certs on its own; the sweep reaps orphans every 10 min;
`journalctl -u zenkai-app -f` when curious.
Deploy a fix: `ssh zenkai@<box> 'cd Zenkai && git pull && sudo systemctl restart zenkai-app'`
(live sessions survive — they're detached processes on their own ports).
