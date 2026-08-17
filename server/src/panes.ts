/**
 * Panes surface — the server half.
 *
 *   browser panes.js ──► /api/files, /api/file, /api/panes-event, /api/run
 *                         (session.ts routes) ──► these pure helpers
 *
 * The panes surface exists because the IDE is the wrong fidelity for OA
 * rounds: the real thing is a HackerRank-style pane layout. The hard
 * constraint it inherits: the whole trace pipeline used to live inside the
 * VS Code extension, so a session without a workbench emitted NOTHING —
 * no trigger arming, no stuck detection, judge unassessable. The panes
 * client reproduces edit/file_open/file_save itself and the run route emits
 * test_run; these helpers keep that surface area honest and testable.
 *
 * Everything here is pure or single-purpose fs (listWorkspaceFiles). Route
 * plumbing stays in session.ts.
 */

import { readdirSync } from 'node:fs';
import path from 'node:path';
import type { RoundCapabilities } from '@interview-prep/shared';

/**
 * The ONE traversal gate for every path that arrives over HTTP — file
 * reads, file writes, and the Monaco vendor route all resolve through
 * here. Returns the absolute path inside rootDir, or null for anything
 * that would escape it (absolute inputs, .., empty).
 */
export function safeWorkspacePath(rootDir: string, relPath: string): string | null {
  if (typeof relPath !== 'string' || relPath.trim() === '') return null;
  if (path.isAbsolute(relPath)) return null;
  const root = path.resolve(rootDir);
  const resolved = path.resolve(root, relPath);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
  return resolved;
}

/** Directories that are infrastructure, not the candidate's problem. */
const EXCLUDED_DIRS = new Set(['node_modules', '.git', '__pycache__']);
/** problem.json carries the rubric and (for debugging rounds) the planted
 *  bug. The IDE surface has always exposed it via the workspace mount —
 *  a standing leak noted there — but the panes listing is ours to filter. */
const EXCLUDED_FILES = new Set(['problem.json']);

/**
 * Relative paths of the candidate-visible files under rootDir, sorted.
 * Dotfiles and dot-directories are the pipeline's markers (.validated,
 * .used, .generating…) and never the problem — excluded wholesale.
 */
export function listWorkspaceFiles(rootDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || EXCLUDED_DIRS.has(e.name)) continue;
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), rel);
      else if (e.isFile() && !(prefix === '' && EXCLUDED_FILES.has(e.name))) out.push(rel);
    }
  };
  walk(rootDir, '');
  return out.sort();
}

/**
 * Build-infrastructure files: real, legitimately readable, but never the
 * candidate's task. Matched by basename against the ecosystem's OWN
 * vocabulary (lockfiles, tool configs) — these are our generated repos, so
 * the set is closed in practice. Pattern-not-list would fail open for a
 * new config flavor, which costs one extra tab, not a lost file.
 */
const INFRA_FILE_RE =
  /^(package(-lock)?\.json|yarn\.lock|pnpm-lock\.yaml|tsconfig[^/]*\.json|(vitest|jest|vite|babel)\.config\.[^/]+|\.eslintrc[^/]*|pyproject\.toml|setup\.(py|cfg)|requirements[^/]*\.txt|Makefile)$/;

/**
 * Split the tab strip into what the round is ABOUT and what merely ships
 * with it. Why (owner report, 2026-08-18): the panes tab strip rendered
 * every file as a co-equal alphabetical tab, so a TS one-shot opened with
 * `package-lock.json` — a 46KB generated lockfile — sorted ahead of the
 * solution, and `files[0]` (the initial open) could be a config file.
 * Primary = manifest model_paths in manifest order, then every remaining
 * non-infra file in listing order; infra keeps its files reachable behind
 * the client's overflow control, never hidden outright — reading
 * package.json is sometimes the right move.
 */
export function partitionWorkspaceFiles(
  files: string[],
  modelPaths: string[],
): { primary: string[]; infra: string[] } {
  const norm = (p: string) => p.replace(/^\.\//, '').replace(/\\/g, '/');
  const isInfra = (f: string) => INFRA_FILE_RE.test(f.split('/').pop() ?? f);
  const model = modelPaths.map(norm).filter((m) => files.includes(m));
  const rest = files.filter((f) => !model.includes(f));
  return {
    primary: [...model, ...rest.filter((f) => !isInfra(f))],
    infra: rest.filter(isInfra),
  };
}

/**
 * Server-side enrichment for panes file_save events: the client stays dumb
 * and the server decides model-path membership, same division of labor as
 * the extension's save handler.
 */
export function isModelPath(relPath: string, modelPaths: string[]): boolean {
  const norm = (p: string) => p.replace(/^\.\//, '').replace(/\\/g, '/');
  const target = norm(relPath);
  return modelPaths.some((m) => norm(m) === target);
}

/**
 * One line from a run's tail — the same shape finalize() builds inline for
 * the one-shot grading run and summarizeRun() builds in the extension.
 * Last two non-empty lines: for vitest that is the "Tests N failed" pair,
 * for unittest the "Ran N tests" + verdict pair.
 */
export function summarizeTail(tail: string): string {
  const lines = tail.split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.slice(-2).join(' — ');
}

/**
 * Pass/fail counts from a run's output tail. Parses the SUMMARY lines only
 * — the tail is capped at 4000 chars, which can truncate per-test lines but
 * never the trailing summary. Recognizes:
 *   unittest:  "Ran 16 tests in 0.01s" + "OK" | "FAILED (failures=3, errors=2)"
 *   vitest:    "Tests  3 failed | 5 passed (8)" | "Tests  8 passed (8)"
 * Null when neither pattern is present — callers omit counts rather than
 * guess, and the timeline falls back to the binary PASSED/FAILED line.
 * Why: on one-shot rounds the graded run is the AUTHORITATIVE signal (and
 * before the 2026-08-15 un-conflation it was the only one); without counts
 * the judge cannot tell 15/16 from 0/16 (renderer v3).
 */
export function parseRunCounts(tail: string): { total: number; passed: number; failed: number } | null {
  const ran = tail.match(/^Ran (\d+) tests? in /m);
  if (ran) {
    const total = Number(ran[1]);
    if (/^OK\b/m.test(tail)) return { total, passed: total, failed: 0 };
    const verdict = tail.match(/^FAILED \(([^)]*)\)/m);
    if (!verdict) return null; // truncated or still running — do not guess
    let failed = 0;
    for (const m of verdict[1]!.matchAll(/(?:failures|errors)=(\d+)/g)) failed += Number(m[1]);
    if (failed === 0) return null; // "FAILED (skipped=…)" shapes prove nothing
    return { total, passed: Math.max(0, total - failed), failed };
  }
  const vt = tail.match(/^\s*Tests\s+(?:(\d+) failed \| )?(\d+) passed \((\d+)\)/m);
  if (vt) {
    const failed = Number(vt[1] ?? 0);
    const passed = Number(vt[2]);
    return { total: Number(vt[3]), passed, failed };
  }
  const vtAllFail = tail.match(/^\s*Tests\s+(\d+) failed \((\d+)\)/m);
  if (vtAllFail) {
    return { total: Number(vtAllFail[2]), passed: Number(vtAllFail[2]) - Number(vtAllFail[1]), failed: Number(vtAllFail[1]) };
  }
  return null;
}

export type RunRejection = 'no_runs' | 'ended' | 'busy';

/**
 * Whether /api/run may execute right now. The load-bearing case is
 * can_run_tests: it ALONE governs the run loop (un-conflation, 2026-08-15
 * — `submit: one_shot` is the autograding contract, one authoritative
 * server-side run of a read-only suite at Submit, and says nothing about
 * running; a live round's own blueprint promised HackerRank's
 * run-freely-graded-once semantics and this guard was what broke it).
 */
/**
 * Files a candidate could drop at the workspace ROOT to hijack the graded
 * run without ever touching tests/.
 *
 *   graded run:  cd <workspace> && <test_command>
 *                        │
 *                        └─ python puts CWD on sys.path for `-m`, so a
 *                           root-level unittest.py IS the `unittest` the
 *                           runner imports; vitest reads its config from
 *                           CWD; python auto-imports sitecustomize.
 *
 * QA 2026-08-14 fix-verification: the one-shot read-only block covered
 * tests/ and cases*.json, and a root-level unittest.py still forced a green
 * graded suite (demonstrated end to end). Root level only — a nested copy is
 * never the one that gets imported. Exported for tests.
 */
const RUNNER_SHADOWS = new Set([
  'unittest.py',
  'pytest.py',
  'conftest.py',
  'sitecustomize.py',
  'usercustomize.py',
  'vitest.config.ts',
  'vitest.config.js',
  'vitest.config.mjs',
]);

export function shadowsTestRunner(relPath: string): boolean {
  if (relPath.includes(path.sep)) return false; // only CWD shadows the runner
  return RUNNER_SHADOWS.has(relPath.toLowerCase());
}

export function runGuard(
  caps: RoundCapabilities,
  ended: boolean,
  running: boolean,
): RunRejection | null {
  if (ended) return 'ended';
  if (!caps.can_run_tests) return 'no_runs';
  if (running) return 'busy';
  return null;
}
