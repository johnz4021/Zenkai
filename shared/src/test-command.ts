/**
 * Is this shell command a test run?
 *
 * Terminal runs were invisible for the whole life of the product: the
 * extension observed only its own Run Tests button, and the session chrome
 * told candidates outright that "terminal commands are not observed". A
 * replay over 19 real traces found the Run Tests button pressed roughly
 * twice, ever — every other `test_run` was the autorun at +3s. So a
 * candidate who verified their fix the normal way (`npm test` in a terminal)
 * was recorded as never verifying at all, and the judge's `verify` dimension
 * scored that false negative into the gap graph.
 *
 * This lives in shared/ so the classifier is unit-testable without a VS Code
 * runtime; the extension owns only the subscription.
 *
 * Deliberately conservative. A false POSITIVE mislabels an unrelated command
 * as verification and credits work that never happened, which is worse than
 * missing an exotic runner — the same asymmetry the intent check uses when it
 * defaults to "not addressed".
 */

/** Runner invocations we recognise, anchored so `echo pytest` never matches. */
const TEST_PATTERNS: RegExp[] = [
  // npm/yarn/pnpm/bun script runners
  /^(?:npm|yarn|pnpm|bun)\s+(?:run\s+)?test\b/,
  /^(?:npx|pnpm\s+dlx|bunx)\s+(?:vitest|jest|mocha|ava|tap)\b/,
  // direct runners
  /^(?:vitest|jest|mocha|ava|tap)\b/,
  // python
  /^(?:python3?|py)\s+-m\s+(?:unittest|pytest)\b/,
  /^(?:pytest|nose2)\b/,
  // other ecosystems the generator may pick
  /^go\s+test\b/,
  /^cargo\s+test\b/,
  /^(?:mvn|gradle|\.\/gradlew)\s+.*\btest\b/,
  /^(?:rspec|bundle\s+exec\s+rspec)\b/,
  // the bundled node running a vitest entrypoint (our own IP_TEST_CMD shape)
  /\bvitest\.mjs\b/,
];

/** Strip env-var prefixes and leading noise: `CI=1 npx vitest run` → `npx …`. */
function normalize(commandLine: string): string {
  let s = commandLine.trim();
  // Drop a leading shell prompt artifact if the terminal handed one back.
  s = s.replace(/^[$#>]\s+/, '');
  // Drop VAR=value prefixes.
  while (/^[A-Za-z_][A-Za-z0-9_]*=[^\s]*\s+/.test(s)) {
    s = s.replace(/^[A-Za-z_][A-Za-z0-9_]*=[^\s]*\s+/, '');
  }
  return s;
}

export function isTestCommand(commandLine: string | undefined | null): boolean {
  if (!commandLine) return false;
  const s = normalize(commandLine);
  if (!s) return false;
  // A compound command counts if ANY segment is a test run (`npm i && npm test`).
  return s
    .split(/\s*(?:&&|\|\||;)\s*/)
    .some((seg) => TEST_PATTERNS.some((re) => re.test(seg.trim())));
}
