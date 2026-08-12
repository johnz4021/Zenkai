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
2. **Auth → Providers:** enable **Google** (primary — no email deliverability
   risk). If you also want email OTP: configure **custom SMTP** (Auth →
   Settings) first; the built-in sender is rate-limited to a handful of mails
   an hour and will eat a login wave.
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

   **Trap — a project on asymmetric signing kills the legacy `eyJ…` keys.**
   Once the project publishes an ES256 JWKS, the old JWT-shaped `anon` and
   `service_role` keys stop being accepted and you need the new
   `sb_publishable_…` / `sb_secret_…` pair from Settings → API Keys. The
   failure is confusing because the keys still *look* valid: they decode to
   the right `ref` and `role` and are years from expiry, but **every**
   endpoint — `/rest/v1/`, `/auth/v1/settings`, even `/auth/v1/health` —
   answers `401 {"message":"Invalid API key"}`. Confirm with:

   ```bash
   curl -s "$URL/auth/v1/.well-known/jwks.json" | jq '.keys[].alg'   # ES256 = migrated
   curl -s -o /dev/null -w '%{http_code}\n' "$URL/rest/v1/" -H "apikey: $ANON"
   ```

   ES256 plus a 401 means swap the keys. No code change is needed: both keys
   are opaque strings everywhere they are used (`db.ts` sends them as
   `apikey`/`Bearer`, `app.ts` hands the anon key to the browser), and the
   `auth.ts` JWKS path is already the one asymmetric projects want.
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
