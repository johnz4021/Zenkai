/**
 * scratch-app — boot THIS checkout's home app on a private port.
 *
 *   npx tsx qa/scratch-app.mts   (from a scratch worktree, with the qa/README env)
 *        │
 *        └──► runApp({port: 3301, sessionPort: 3201, …}) — same code path as
 *             `cli.ts app`, minus the .env load (a scratch worktree has no .env,
 *             which is the point: model-free and auth-off by default).
 *
 * Why it exists (doors QA, 2026-08-15): `cli.ts app` hard-codes :3300, and QA
 * needs a second instance whose data dirs are disposable. All state is
 * repoRoot-relative, so running this file from a worktree isolates everything;
 * ports come from QA_APP_PORT/QA_SESSION_PORT so parallel harnesses can avoid
 * each other. Only ONE instance may launch Docker sessions at a time — the
 * session sweeper reaps by the global `ip-session-` name prefix and both
 * registries allocate slots from :3401 (see qa/README.md).
 */
const root = new URL('..', import.meta.url);
const { runApp } = await import(new URL('server/src/app.ts', root).href);
const { resolvePublicConfig } = await import(new URL('server/src/public-config.ts', root).href);

runApp({
  port: Number(process.env.QA_APP_PORT ?? 3301),
  sessionPort: Number(process.env.QA_SESSION_PORT ?? 3201),
  userId: process.env.IP_USER_ID ?? 'qa-u1',
  pub: resolvePublicConfig(process.env),
});
