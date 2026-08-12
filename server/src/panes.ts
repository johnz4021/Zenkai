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
 * Why: on one-shot rounds the graded run is the ONLY signal; without counts
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

export type RunRejection = 'no_runs' | 'one_shot' | 'ended' | 'busy';

/**
 * Whether /api/run may execute right now. The load-bearing case is
 * one_shot: an OA round's suite runs ONCE, at submit — this guard is what
 * keeps the panes Run route from quietly reintroducing iteration into
 * rounds whose whole point is that you cannot iterate.
 */
export function runGuard(
  caps: RoundCapabilities,
  ended: boolean,
  running: boolean,
): RunRejection | null {
  if (ended) return 'ended';
  if (!caps.can_run_tests) return 'no_runs';
  if (caps.submit === 'one_shot') return 'one_shot';
  if (running) return 'busy';
  return null;
}
