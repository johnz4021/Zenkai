# Beta runbook — zenkai.run

The no-code half of the beta. Everything code-side shipped on the `beta`
branch; this is what the founder does once, plus the per-day ops.

> **Rev 2 (2026-08-11): the beta hosts on a VPS, not the founder's laptop**
> (decision logged; concurrent sessions shipped as TODOS #22). Sections 1
> (Supabase) and 6 (success gate) are unchanged. Sections 2/3/5 below are
> superseded by "VPS cutover" at the end — the tunnel now runs ON the VPS,
> `caffeinate` is dead, and multi-session env vars are part of the config.

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
7. Invite management = **Auth → Users**: the beta gate is "can they sign in
   with an email you expect." To revoke someone: delete the user. (Google
   sign-in is open to any Google account by default — if you want a hard
   allowlist, keep Google off and use email OTP, or check off-list emails by
   watching the `users` table.)

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

Run it: `cloudflared tunnel run zenkai-beta` (later: `cloudflared service install`).
WebSockets work through the tunnel with no extra config. HTTPS comes free —
which `getUserMedia` (the mic) requires off-localhost.

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

Box: **Hetzner CPX31** (4 vCPU / 8GB / 160GB, ~$16/mo, Ashburn or Hillsboro).
8GB fits the app + 2-3 live session containers (~1GB each) + a generation run.

```bash
# on your machine
scp -r ops root@<box-ip>:
ssh root@<box-ip> 'bash ops/provision.sh'     # idempotent; prints remaining steps
# it installs: docker, lsof (assertPortFree DIES without it on Ubuntu minimal),
# node20, claude CLI, cloudflared, the zenkai user, systemd units, and sets
# ufw: OpenSSH + `allow in on docker0` — WITHOUT the docker0 rule the
# container's trace WebSocket is silently dropped and every IDE round
# records nothing while looking perfectly healthy.

# .env: your laptop's beta .env PLUS the multi-session block
#   IP_MULTI_SESSION=1
#   IP_MAX_CONCURRENT_SESSIONS=2      # 3 fits if you watch docker stats
#   IP_MAX_SESSIONS_PER_USER=1        # admins bypass (you can test 2 rooms)
scp .env zenkai@<box-ip>:interview_prep/.env

# cloudflared: create the tunnel ON the VPS (or copy your existing creds)
ssh root@<box-ip>
cloudflared tunnel login && cloudflared tunnel create zenkai-beta
cloudflared tunnel route dns zenkai-beta zenkai.run
cloudflared tunnel route dns zenkai-beta session.zenkai.run
mkdir -p /etc/cloudflared && cat > /etc/cloudflared/config.yml <<CFG
tunnel: <TUNNEL-UUID>
credentials-file: /root/.cloudflared/<TUNNEL-UUID>.json
ingress:
  - hostname: zenkai.run
    service: http://localhost:3300
  - hostname: session.zenkai.run
    service: http://localhost:3200
  - service: http_status:404
CFG
systemctl start zenkai-app cloudflared
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

**Serving days on the VPS:** nothing. systemd restarts crashes; the sweep
reaps orphans every 10 min; `journalctl -u zenkai-app -f` when curious.
Deploy a fix: `ssh zenkai@<box> 'cd interview_prep && git pull && sudo systemctl restart zenkai-app'`
(live sessions survive — they're detached processes on their own ports).
