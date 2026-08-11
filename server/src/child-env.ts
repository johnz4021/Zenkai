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

/** Never reaches ANY child. */
const ALWAYS_DROP = ['IP_SUPABASE_SERVICE_KEY'] as const;

/** Dropped for generators on top of ALWAYS_DROP. */
const GENERATOR_DROP = ['ELEVENLABS_API_KEY', 'IP_ELEVENLABS_KEY', 'IP_SUPABASE_ANON_KEY'] as const;

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
