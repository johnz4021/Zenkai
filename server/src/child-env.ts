/**
 * Child-process env hygiene (beta WU8).
 *
 *   process.env ──► childEnv(kind) ──► the env a spawned child actually gets
 *
 *      sandbox    problem test/install runs — STRANGER-AUTHORED code
 *                 executing on the host. Allowlist: PATH/HOME + locale.
 *                 No keys, no IP_* config, nothing.
 *      generator  claude -p agentic runs + detached cli generators.
 *                 Needs ANTHROPIC_API_KEY; never voice or the DB key.
 *      session    spawned session processes. Needs both API keys (judge +
 *                 voice); never the DB service key.
 *
 * Why this exists: pre-beta, every child inherited the whole environment —
 * fine when all input was founder-authored. A beta stranger's pasted JD
 * flows into an agentic generation whose OUTPUT (the problem's own test
 * suite) then executes on the host via validate.ts. That is a prompt-
 * injection → env-exfiltration path unless the executing child simply has
 * nothing to read. Keys named here, not pattern-matched: an allowlist that
 * misses breaks visibly; a denylist that misses leaks silently.
 */

const SANDBOX_KEEP = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'SHELL', 'USER'] as const;

/** Never reaches ANY child.
 *
 *  The Stripe pair earns its place the same way the service key did: a
 *  generator is an agentic `claude -p` run whose brief carries
 *  stranger-authored prose, and money-moving credentials in its environment
 *  are one prompt injection away from being exfiltrated. Nothing a child does
 *  needs them — billing lives entirely in the app process.
 *
 *  The Gmail app password joins them for the same reason and a sharper one:
 *  it does not read mail, it SENDS as the founder. Leaked, it is a trusted
 *  From: header pointed at every beta user's inbox. The welcome sweep runs
 *  in cli.ts, never in a child. */
const ALWAYS_DROP = [
  'IP_SUPABASE_SERVICE_KEY',
  'STRIPE_API_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'IP_GMAIL_APP_PASSWORD',
] as const;

/** Dropped for generators on top of ALWAYS_DROP.
 *
 *  The PostHog trio lives HERE and not in ALWAYS_DROP on purpose: the project
 *  key (phc_) is public by design — it ships to every browser — so it guards
 *  nothing, and an agentic `claude -p` run simply has no use for it (the anon
 *  key's reasoning exactly). SESSION children keep it: they emit the round
 *  lifecycle events and render the session page's analytics snippet. */
const GENERATOR_DROP = [
  'ELEVENLABS_API_KEY',
  'IP_ELEVENLABS_KEY',
  'IP_SUPABASE_ANON_KEY',
  'IP_POSTHOG_KEY',
  'IP_POSTHOG_HOST',
  'IP_POSTHOG_REPLAY_ROUND',
] as const;

export type ChildKind = 'sandbox' | 'generator' | 'session';

export function childEnv(
  kind: ChildKind,
  base: Record<string, string | undefined>,
  extra: Record<string, string> = {},
): Record<string, string | undefined> {
  if (kind === 'sandbox') {
    const out: Record<string, string | undefined> = {};
    for (const k of SANDBOX_KEEP) if (base[k] !== undefined) out[k] = base[k];
    return { ...out, ...extra };
  }
  const out = { ...base };
  for (const k of ALWAYS_DROP) delete out[k];
  if (kind === 'generator') for (const k of GENERATOR_DROP) delete out[k];
  return { ...out, ...extra };
}
