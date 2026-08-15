# PostHog setup

Dashboard-side steps for the analytics layer (`server/src/posthog.ts`). The
code side is three env vars; everything here is PostHog's UI. Free tier
covers the beta many times over (1M events, 5K replays, 100K exceptions per
month, no card).

## 1. Project + key (~3 min)

1. [posthog.com](https://posthog.com) → sign up → create a project (US Cloud
   unless you have an EU-data reason; the host below must match).
2. Settings → Project → **Project API key**. It starts with `phc_`.
3. Into `.env`:

```
IP_POSTHOG_KEY=phc_...
IP_POSTHOG_HOST=https://us.i.posthog.com   # optional; this is the default
```

**`phc_` only.** A personal API key (`phx_`) is a real secret; the boot check
refuses it because this value ships to every browser. The project key is
public by design — same class as the Supabase anon key.

Restart the app. Unset = analytics off, box byte-identical — that is the
whole off-switch, and the kill switch.

## 2. Session replay (~2 min)

Settings → Session replay → enable recording for the project (the client
config asks for it, but the project toggle is the master switch).

What records where, by design (`posthog.ts`, `session.ts`):

| Surface | Recorded | Not recorded |
|---|---|---|
| App (:3300) | layout, clicks, navigation | plan conversation, composer gaps, feedback cards (`maskTextSelector`), every input (`maskAllInputs`) |
| Round (:3200) | header, timer, statement, controls | the IDE iframe, the Monaco pane, the transcript, test output (`blockSelector`) |

The round interior stays blocked until `IP_POSTHOG_REPLAY_ROUND=1`. Before
flipping it on a live box:

1. Run a real round with it off; type a paragraph in the editor with DevTools
   Performance recording. Note input latency.
2. Flip the flag, restart, repeat in a fresh round. rrweb serializes DOM
   mutations on the main thread and the VS Code workbench is the heaviest
   mutation source in the product — this measurement is the decision.
3. If you keep it on, fix the round page's intro copy: it currently promises
   "other terminal commands are not observed", and full replay observes them.

## 3. What arrives, and what never does

Server events (`app.ts`, `session.ts`): `round_launched`, `round_ended`,
`round_crashed` (the record that exists nowhere else — a session that died
without its lifecycle), `round_abandoned`, `judge_unassessed`,
`build_started` / `build_finished` / `build_failed`, and the WTP funnel
`gate_shown` → `gate_would_pay` → `gate_would_pay_confirmed`.

Identity is the Supabase user id only. **Never sent:** emails (stay in
`paywall.jsonl`), the expected-price free text, trace contents, code,
transcripts. The JSONL ledgers on the box remain authoritative — PostHog is
a mirror in exactly the `db.ts` sense, and nothing reads back from it.

## 4. Ad blockers (accepted, by design)

The bundle is vendored from `node_modules` at a neutral path
(`/vendor/insight-<version>.js`), but the capture host is still PostHog's and
EasyPrivacy blocks it. Blocked users produce no data and break nothing — the
client's only door is a guarded `track()` helper, and `app.test.ts` pins that
no bare `posthog.*` call exists. Expect a coverage gap in the numbers
(10–30% of a technical audience). The fix, if it ever matters, is a Caddy
reverse-proxy path on a neutral subdomain — deliberately out of scope for
now (`ops/Caddyfile` change on the live box).

## 5. Verifying a fresh setup

```bash
IP_POSTHOG_KEY=phc_... IP_APP_PORT=3311 IP_PUBLIC_APP_URL=http://localhost:3311 \
  npx tsx server/src/cli.ts app
```

Open the app, sign in, click around. PostHog → Activity should show
`$pageview` + autocaptured clicks within ~1 min, a replay within ~2. Then
launch a round and confirm `round_launched` arrives with your user id as the
distinct id.
