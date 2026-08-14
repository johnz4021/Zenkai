/**
 * Mechanical post-check on a generated problem (trust-but-verify on the
 * agent's self-validation — eng review 5A lineage, narrowed by decision 8).
 *
 * Asserts, cheaply and objectively:
 *   1. problem.json exists and is shaped like GeneratedProblem
 *   2. rubric labels are a subset of the single label source of truth
 *   3. the planted-bug file exists
 *   4. `vitest run` reports EXACTLY one failing test
 *   5. that failing test is the one the manifest names
 *
 * No LLM calls. No retries. A failure here means the generator's claim was
 * wrong — regenerate, don't patch.
 */

import { spawnSync } from 'node:child_process';
import { childEnv } from './child-env.js';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { GeneratedProblem } from '@interview-prep/shared';
import { DIMENSIONS, resolveRoundSpec, validateRoundSpec } from '@interview-prep/shared';
import { listWorkspaceFiles } from './panes.js';

export interface ValidationReport {
  ok: boolean;
  problem?: GeneratedProblem;
  failures: string[];
  /** Names of failed tests observed in the run. */
  failedTests: string[];
}

/** Pure parser for vitest's jest-style JSON reporter output. Exported for tests. */
export function parseVitestJson(jsonText: string): { failed: string[]; total: number } {
  const data = JSON.parse(jsonText) as {
    numTotalTests?: number;
    testResults?: {
      assertionResults?: { status?: string; fullName?: string; title?: string }[];
    }[];
  };
  const failed: string[] = [];
  let total = 0;
  for (const file of data.testResults ?? []) {
    for (const t of file.assertionResults ?? []) {
      total += 1;
      if (t.status === 'failed') failed.push(t.fullName ?? t.title ?? '<unnamed>');
    }
  }
  return { failed, total: data.numTotalTests ?? total };
}

/**
 * Test names arrive in two notations: vitest's `fullName` joins describe and
 * test with a single SPACE ("hold expiry keeps units reserved"), while humans
 * and generators write the conventional separator ("hold expiry > keeps units
 * reserved"). Normalize both before comparing, or a correct problem gets
 * rejected over punctuation. Exported for tests.
 */
export function normalizeTestName(name: string): string {
  return name
    .replace(/\s*>\s*/g, ' ')
    // Python's dotted path (tests.test_dashboard.WatchlistTest.test_x) is a
    // THIRD notation for the same name — a live learning-round generation
    // failed validation on exactly this. Dots normalize like separators;
    // both sides go through here, so names containing literal dots still
    // compare consistently.
    .replace(/\./g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Pure manifest checker. Exported for tests. Dispatches on the round
 *  spec's check kind — the debugging-only hard-reject died with the format
 *  menu (CEO review 2026-07-31: capabilities, not categories). */
const SOURCE_EXTENSIONS = new Set(['.ts', '.js', '.mjs', '.py']);
const TEST_DIRS = new Set(['test', 'tests']);
const HARNESS_BASENAMES = /^(vitest|vite)\.config\.\w+$/;
const TEST_BASENAMES = /(\.test\.\w+|_test\.py)$|^test_.*\.py$/;

/** Is this workspace-relative path a test file by the repo's conventions?
 *  The ONLY test-file identification that exists: no manifest field names
 *  the test file, so consumers (problem-view's failing-test lookup) share
 *  this predicate instead of growing a drifting copy. */
export function isTestFile(rel: string): boolean {
  const parts = rel.split('/');
  if (TEST_DIRS.has(parts[0] ?? '')) return true;
  return TEST_BASENAMES.test(parts[parts.length - 1] ?? '');
}

/** Candidate-facing source files from a listWorkspaceFiles() listing —
 *  what check.max_source_files counts. Tests and harness config are the
 *  problem's scaffolding, not its size. */
export function countSourceFiles(files: string[]): number {
  return files.filter((f) => {
    if (!SOURCE_EXTENSIONS.has(path.extname(f))) return false;
    if (isTestFile(f)) return false;
    const base = f.split('/').pop() ?? '';
    return !HARNESS_BASENAMES.test(base);
  }).length;
}

export function checkManifest(problem: GeneratedProblem, repoDir: string): string[] {
  const failures: string[] = [];
  // A manifest-carried spec must be in-vocabulary; absence is fine (legacy
  // manifests resolve to the debugging default).
  if (problem.round_spec) {
    failures.push(...validateRoundSpec(problem.round_spec).map((f) => `round_spec: ${f}`));
  }
  const spec = resolveRoundSpec(problem);

  if (spec.check.kind === 'one_failing_test') {
    // The planted bug IS this kind's ground truth — nothing else proves the
    // failing test is intentional rather than a generation accident.
    if (!problem.planted_bug) {
      failures.push('planted_bug missing (required for one_failing_test)');
    } else {
      if (!problem.planted_bug.failing_test) failures.push('planted_bug.failing_test missing');
      if (!existsSync(path.join(repoDir, problem.planted_bug.file))) {
        failures.push(`planted_bug.file does not exist: ${problem.planted_bug.file}`);
      }
    }
  }
  if (spec.check.kind === 'diff_present') {
    // The manifest-side half of the diff contract: the GENERATOR must declare
    // which files changed (validateRoundSpec no longer requires this at
    // inference time — no problem exists there to name files from), and every
    // declared file must exist. An empty declaration means the review round
    // has nothing to review, which is a generation failure.
    const changed = spec.check.files_changed ?? [];
    if (changed.length === 0) failures.push('diff_present manifest requires non-empty check.files_changed');
    for (const f of changed) {
      if (!existsSync(path.join(repoDir, f))) failures.push(`files_changed entry does not exist: ${f}`);
    }
  }
  // The one enforceable size knob. This is what makes the generator prompt's
  // max-files sentence TRUE — every other size claim was removed from the
  // requirement blocks precisely because nothing proved it.
  if (spec.check.max_source_files !== undefined) {
    const count = countSourceFiles(listWorkspaceFiles(repoDir));
    if (count > spec.check.max_source_files) {
      failures.push(`${count} source files — check.max_source_files allows ${spec.check.max_source_files}`);
    }
  }
  if (!problem.spec || problem.spec.length < 100) failures.push('spec missing or too short');
  failures.push(...checkExpectations(problem));
  return failures;
}

/**
 * Expectation concreteness gate (eng review T3, upgraded to critical path
 * by the outside voice): under the judge design, feedback quality is
 * DOWNSTREAM of expectation quality — a vague expectation produces vague
 * feedback on that dimension forever, and it looks like a judge problem.
 * The gate is mechanical: every dimension present, long enough to say
 * something, not a known-vague stem, and tied to THIS problem's vocabulary.
 */
const VAGUE_STEMS = /^(understands?|thinks? about|considers?|is (aware|mindful)|knows?|has a (good|solid) (grasp|understanding))\b/i;

export function checkExpectations(problem: GeneratedProblem): string[] {
  const failures: string[] = [];
  const dims = problem.rubric?.dimensions;
  if (!dims) {
    // Pre-v2 manifests fall back to round-type defaults; only NEW
    // generations (which the generator prompt requires to emit dimensions)
    // are held to the gate. validateProblem runs at generation time, so a
    // fresh manifest without dimensions is a generation failure.
    return ['rubric.dimensions missing (generator must emit per-dimension expectations)'];
  }
  // Vocabulary pool: the spec AND the planted bug. reflect/approach
  // expectations legitimately speak the bug's language ("the boundary
  // instant"), which the candidate-facing spec deliberately does not.
  // Identifiers stay WHOLE (`[^a-z0-9_]+`, not `[^a-z]+`): `min_ms` used to
  // shred into "min"+"ms", both under the floor, so the most
  // problem-specific token a spec and its expectations can share was
  // invisible to the gate. Skinned LC rounds fail on this structurally —
  // the spec speaks the story ("chime", "pulses") while expectations speak
  // the algorithm ("recurrence", "modulus"), and the shared identifiers are
  // the whole bridge (rep-e2e52324, 2026-08-13; standing limitation #5 in
  // docs/problem-generation.md). Strictly additive: nothing that matched
  // before stops matching.
  const tokenize = (s: string) => s.toLowerCase().split(/[^a-z0-9_]+/);
  const specWords = new Set(
    tokenize(`${problem.spec ?? ''} ${problem.planted_bug?.description ?? ''}`)
      .filter((w) => w.length >= 5),
  );
  for (const key of DIMENSIONS) {
    const exp = dims[key];
    if (!exp || exp.trim().length === 0) {
      failures.push(`expectation missing for dimension: ${key}`);
      continue;
    }
    if (exp.trim().split(/\s+/).length < 8) {
      failures.push(`expectation for ${key} too thin (< 8 words): "${exp}"`);
    }
    if (VAGUE_STEMS.test(exp.trim())) {
      failures.push(`expectation for ${key} starts with a vague stem: "${exp.slice(0, 40)}..."`);
    }
    const tied = tokenize(exp).some((w) => w.length >= 5 && specWords.has(w));
    if (!tied) {
      failures.push(`expectation for ${key} shares no vocabulary with the spec — not problem-specific: "${exp.slice(0, 60)}..."`);
    }
  }
  return failures;
}

/**
 * Parse `python -m unittest -v` output (it writes to stderr). Two line
 * shapes exist in the wild — 3.10's `test_x (mod.Class)` and 3.11+'s
 * `test_x (mod.Class.test_x)` — both matched by the same head pattern.
 * Names come back as `mod > Class > test_x` so normalizeTestName makes
 * them comparable with manifest-side `Class > test_x` via substring.
 * Exported for tests.
 */
export function parseUnittestOutput(text: string): { failed: string[]; total: number } {
  const failed: string[] = [];
  let total = 0;
  for (const line of text.split('\n')) {
    const m = line.match(/^(\S+) \(([\w.]+)\) \.\.\. (ok|FAIL|ERROR|skipped)/);
    if (!m) {
      const ran = line.match(/^Ran (\d+) tests?/);
      if (ran) total = Number(ran[1]);
      continue;
    }
    const [, name, cls, status] = m;
    if (status === 'FAIL' || status === 'ERROR') {
      const parts = cls!.split('.');
      // 3.11+ repeats the test name at the end of the class path — drop it.
      if (parts[parts.length - 1] === name) parts.pop();
      failed.push(`${parts.join(' > ')} > ${name}`);
    }
  }
  return { failed, total };
}

/**
 * Run the problem's suite on the host and report failures uniformly.
 * Dispatch is on `runtime`, not `test_command` — test_command is the
 * CONTAINER invocation and references container paths.
 */
function runSuite(
  problem: GeneratedProblem,
  repoDir: string,
): { failed: string[]; total: number } | { error: string } {
  if ((problem.runtime ?? 'node') === 'python') {
    const run = spawnSync('python3', ['-m', 'unittest', 'discover', '-v'], {
      cwd: repoDir,
      encoding: 'utf8',
      timeout: 180_000,
      // WU8: generated (potentially stranger-steered) code runs with a bare
      // env — no keys, no config, nothing to exfiltrate.
      env: childEnv('sandbox', process.env),
    });
    const text = `${run.stderr ?? ''}\n${run.stdout ?? ''}`;
    const parsed = parseUnittestOutput(text);
    if (parsed.total === 0) return { error: `unittest ran no tests: ${text.slice(0, 300)}` };
    return parsed;
  }

  // Install if the agent cleaned up node_modules (or we're on a fresh clone).
  if (!existsSync(path.join(repoDir, 'node_modules'))) {
    const install = spawnSync('npm', ['install', '--no-fund', '--no-audit'], {
      cwd: repoDir,
      encoding: 'utf8',
      timeout: 180_000,
      env: childEnv('sandbox', process.env),
    });
    if (install.status !== 0) {
      return { error: `npm install failed: ${install.stderr?.slice(0, 400)}` };
    }
  }
  const outFile = path.join(repoDir, '.vitest-report.json');
  spawnSync(
    'npx',
    ['vitest', 'run', '--reporter=json', `--outputFile=${outFile}`],
    { cwd: repoDir, encoding: 'utf8', timeout: 180_000, env: childEnv('sandbox', process.env) },
  );
  if (!existsSync(outFile)) return { error: 'vitest produced no JSON report' };
  return parseVitestJson(readFileSync(outFile, 'utf8'));
}

/**
 * Prove the generated problem satisfies its declared check kind. The
 * criteria live HERE, in code, per kind — the generator declares which
 * kind applies and never writes its own passing criteria.
 */
export function checkSuiteAgainstKind(
  problem: GeneratedProblem,
  failed: string[],
  total: number,
): string[] {
  const failures: string[] = [];
  const check = resolveRoundSpec(problem).check;
  switch (check.kind) {
    case 'one_failing_test': {
      const min = check.min_tests ?? 8;
      if (total < min) failures.push(`only ${total} tests — one_failing_test requires >= ${min}`);
      if (failed.length !== 1) {
        failures.push(`expected exactly 1 failing test, got ${failed.length}: [${failed.join(' | ')}]`);
      } else if (problem.planted_bug) {
        const observed = normalizeTestName(failed[0] ?? '');
        const claimed = normalizeTestName(problem.planted_bug.failing_test);
        if (observed !== claimed && !observed.includes(claimed) && !claimed.includes(observed)) {
          failures.push(
            `failing test "${failed[0]}" is not the manifest's "${problem.planted_bug.failing_test}"`,
          );
        }
      }
      break;
    }
    case 'all_failing': {
      const min = check.min_tests ?? 5;
      if (total < min) failures.push(`only ${total} tests — all_failing requires >= ${min}`);
      if (failed.length !== total) {
        failures.push(
          `all_failing requires every test to fail initially; ${total - failed.length} of ${total} pass`,
        );
      }
      break;
    }
    case 'all_passing': {
      const min = check.min_tests ?? 5;
      if (total < min) failures.push(`only ${total} tests — all_passing requires >= ${min}`);
      if (failed.length !== 0) {
        failures.push(`all_passing requires a green suite; failing: [${failed.join(' | ')}]`);
      }
      break;
    }
    case 'diff_present':
      // No suite assertion — file existence was checked in checkManifest.
      break;
  }
  return failures;
}

export function validateProblem(repoDir: string): ValidationReport {
  const failures: string[] = [];

  const manifestPath = path.join(repoDir, 'problem.json');
  if (!existsSync(manifestPath)) {
    return { ok: false, failures: ['problem.json missing'], failedTests: [] };
  }
  let problem: GeneratedProblem;
  try {
    problem = JSON.parse(readFileSync(manifestPath, 'utf8')) as GeneratedProblem;
  } catch (e) {
    return { ok: false, failures: [`problem.json unparseable: ${String(e)}`], failedTests: [] };
  }

  failures.push(...checkManifest(problem, repoDir));

  if (resolveRoundSpec(problem).check.kind === 'diff_present') {
    return { ok: failures.length === 0, problem, failures, failedTests: [] };
  }

  const suite = runSuite(problem, repoDir);
  if ('error' in suite) {
    failures.push(suite.error);
    return { ok: false, problem, failures, failedTests: [] };
  }

  failures.push(...checkSuiteAgainstKind(problem, suite.failed, suite.total));
  return { ok: failures.length === 0, problem, failures, failedTests: suite.failed };
}
