/**
 * Problem generator (eng review T1, decision 8).
 *
 * Generation IS an agentic call: we shell out to `claude -p` (headless
 * Claude Code) pointed at an empty target directory. The agent writes the
 * repo, runs the tests, fixes what's broken, verifies exactly one failure,
 * and writes problem.json. Its own loop is the validator — we do NOT
 * reimplement generate/validate/retry here.
 *
 * validate.ts runs a cheap mechanical post-check afterward; that's a trust
 * check on the agent's claim, not a validation pipeline.
 */

import { spawn } from 'node:child_process';
import { childEnv } from './child-env.js';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { RoundSpec } from '@interview-prep/shared';
import { DEFAULT_DEBUGGING_SPEC } from '@interview-prep/shared';

/**
 * Per-check-kind mechanical requirements, selected in code — the generator
 * is TOLD which criterion applies and never writes its own. The
 * one_failing_test block is the original debugging prompt's requirement
 * text in substance: it is gauntlet-proven and stays canonical.
 *
 * A function of the check, not a constant: min_tests and max_source_files
 * vary per spec. Deliberately ABSENT: any file-count or repo-size claim not
 * enforced by the validator. The old "4 to 8 source files" line was framed
 * as validator-proven, never was, and beat a candidate's explicit "one page
 * of Python" (the size-loss case, docs/problem-generation.md) — shape
 * belongs to the round description, which the template says wins.
 */
export function checkRequirements(check: RoundSpec['check']): string {
  const maxFiles = check.max_source_files
    ? `\n   - At most ${check.max_source_files} source file${check.max_source_files === 1 ? '' : 's'} (tests excluded) — the validator counts them and rejects more.`
    : '';
  const blocks: Record<RoundSpec['check']['kind'], string> = {
    one_failing_test: `1. A realistic module set for the round's domain, sized per the round
   description above. Pure logic + in-memory state. No HTTP server, no
   database, no external services.${maxFiles}
   - Written like production code by a competent team: consistent style, no
     tutorial comments, realistic naming.
2. A behavioral test suite with at least ${check.min_tests ?? 8} tests describing real behavior
   ("reserving more units than available rejects"), not implementation details.
3. Plant EXACTLY ONE subtle bug in the source.
   - Realistic class: boundary condition, wrong comparator, missed invalidation,
     state updated in the wrong order, off-by-one on a partition. NOT a typo, NOT a
     syntax error, NOT a wrong constant with an obvious name.
   - Findable by a strong college senior in 20-40 minutes of real debugging.
   - No comment anywhere near the bug that hints at it. No README hints.
4. Exactly ONE test must fail because of the bug. Every other test must pass.
   - The failing test must be a legitimate behavioral test that would exist anyway —
     not a test written to point at the bug.
5. Manifest additionally carries:
   "planted_bug": { "file": "<file>", "line": <line>, "description": "<one sentence>",
                    "failing_test": "<exact full name of the one failing test>" }

Self-verification (do this before you finish — it is the whole point):
- Run the suite. Confirm exactly one test fails, and that it fails BECAUSE of the
  planted bug.
- Temporarily fix the bug, confirm ALL tests pass, then RESTORE the bug exactly.
- If anything is off, fix the problem set and re-verify.`,

    all_failing: `1. A build-from-scratch task: a scaffold (function/class signatures with
   docstrings or interface stubs, raising/throwing "not implemented") plus a VISIBLE
   behavioral test suite the candidate implements against.
   - The suite IS the spec made precise: name tests after behaviors, cover the core
     path, the rejection paths, and at least two edge cases.
   - Scope the work to fit the round's time limit for a strong college senior.${maxFiles}
2. At least ${check.min_tests ?? 5} tests (more is better).
3. EVERY test must fail on the untouched scaffold — the candidate starts from zero.
   No hidden tests: what they see is what grades them.
4. Do NOT include a reference solution anywhere in the repo.

Self-verification (do this before you finish — it is the whole point):
- Run the suite on the scaffold: every test must fail.
- Write a THROWAWAY solution elsewhere in memory or a temp file, confirm the suite
  would pass against it, then make sure no trace of it remains in the repo.`,

    all_passing: `1. An existing, working module set relevant to the round, with a green
   behavioral test suite (at least ${check.min_tests ?? 5} tests).${maxFiles}
2. The candidate's task (stated in the manifest spec) is to EXTEND or REFACTOR —
   the repo must be green before their work starts, and the spec must say clearly
   what "done" looks like.
3. Do NOT include the target-state implementation.

Self-verification: run the suite; every test passes on the repo as shipped.`,

    diff_present: `1. A base module set plus a CHANGE to review: the changed files listed in
   the round spec's check.files_changed must exist and contain a realistic diff-worth
   of modifications (a mix of sound decisions and 2-4 genuine defects worth catching).
2. Include a REVIEW.md template the candidate writes their review into.
3. The manifest spec describes what the change claims to do; the defects must be
   discoverable by reading, not by running.`,
  };
  return blocks[check.kind];
}

export interface GenerateOptions {
  /** Directory to create the problem in. Created if missing; must be empty-ish. */
  targetDir: string;
  /** What round this is + any candidate-provided reference material. */
  brief: string;
  /** Round shape; absent = the legacy debugging default. */
  spec?: RoundSpec;
  /** Optional emphasis derived from the gap graph. */
  targetNote?: string;
  /** Dataset-sourced rounds: the SOURCED PROBLEM section (lc-convert's
   *  sourceRequirements). Absent = empty substitution, invented round. */
  sourceBlock?: string;
  /** Prompt template path. */
  templatePath: string;
  model?: string;
  /** Hard wall-clock cap on the agent run. */
  timeoutMs?: number;
  /** Agent turn cap. Sourced builds skip invention and test authoring, so
   *  they run tighter (sonnet/40/5min) than invented rounds (opus/80/8min). */
  maxTurns?: number;
}

export interface GenerateResult {
  ok: boolean;
  exitCode: number | null;
  durationMs: number;
  /** Raw stdout from claude -p (json result payload when --output-format json). */
  stdout: string;
  stderr: string;
}

/**
 * The in-band failure `--output-format json` reports even on exit 0 —
 * claude -p exits 0 on error_max_turns, and `ok: code === 0` masked it: a
 * sourced build burned its whole 40-turn budget without writing a single
 * file, reported ok, and the payload carrying the real cause (subtype,
 * is_error, num_turns) was discarded because generateInto only prints it
 * on !ok (zenkai.run 2026-08-15, amazon item-1 — "problem.json missing"
 * was the validator meeting an empty dir, not the failure). Unparseable
 * stdout is NOT a failure here: older CLI output shapes fall through to
 * the validator, which rules on the artifact. Pure; exported for tests.
 */
export function inBandFailure(stdout: string): string | null {
  try {
    const p = JSON.parse(stdout) as { is_error?: boolean; subtype?: string; num_turns?: number };
    if (p.is_error) return `is_error (subtype: ${p.subtype ?? 'unknown'}, turns: ${p.num_turns ?? '?'})`;
    if (typeof p.subtype === 'string' && p.subtype !== 'success') {
      return `subtype ${p.subtype} (turns: ${p.num_turns ?? '?'})`;
    }
    return null;
  } catch {
    return null;
  }
}

export async function generateProblem(opts: GenerateOptions): Promise<GenerateResult> {
  const template = await readFile(opts.templatePath, 'utf8');
  const spec = opts.spec ?? DEFAULT_DEBUGGING_SPEC;
  const prompt = template
    .replace(/\{\{ROUND_BRIEF\}\}/g, opts.brief)
    .replace(/\{\{SOURCE_BLOCK\}\}/g, opts.sourceBlock ?? '')
    .replace(/\{\{CHECK_REQUIREMENTS\}\}/g, checkRequirements(spec.check))
    .replace(/\{\{ROUND_SPEC_JSON\}\}/g, JSON.stringify(spec))
    .replace(/\{\{TARGET_NOTE\}\}/g, opts.targetNote ?? '');

  await mkdir(opts.targetDir, { recursive: true });

  const args = [
    '-p', prompt,
    '--output-format', 'json',
    // The target dir is dedicated and disposable; the agent must be able to
    // write files and run npm without interactive permission prompts.
    '--permission-mode', 'bypassPermissions',
    '--max-turns', String(opts.maxTurns ?? 80),
  ];
  if (opts.model) args.push('--model', opts.model);

  const started = Date.now();
  return new Promise<GenerateResult>((resolve) => {
    const child = spawn('claude', args, {
      cwd: path.resolve(opts.targetDir),
      // WU8: the agent needs the Anthropic key; it never needs voice or DB
      // credentials, and its brief now carries stranger-authored prose.
      env: childEnv('generator', process.env),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));

    // 8 minutes was calibrated for a single-module debugging round (~5 min,
    // per CLAUDE.md). A multi-part OA is roughly triple the work — three
    // implementation files plus three suites — and two of them died at
    // EXACTLY 480s with SIGTERM, one of them holding a complete, validating
    // problem (2026-08-12). Sourced LC builds keep their own tighter 5-min
    // budget from cli.ts: those are a transform, not invention.
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
    }, opts.timeoutMs ?? 15 * 60_000);

    child.on('close', (code) => {
      clearTimeout(timeout);
      // A clean exit still fails when the payload says so — the artifact
      // remains the final judge (generateInto falls through to the
      // validator either way); !ok's job is making the payload VISIBLE.
      const inBand = code === 0 ? inBandFailure(stdout) : null;
      if (inBand) console.error(`[generate] claude -p reported in-band failure: ${inBand}`);
      resolve({
        ok: code === 0 && inBand === null,
        exitCode: code,
        durationMs: Date.now() - started,
        stdout,
        stderr,
      });
    });
    child.on('error', (err) => {
      clearTimeout(timeout);
      resolve({
        ok: false,
        exitCode: null,
        durationMs: Date.now() - started,
        stdout,
        stderr: String(err),
      });
    });
  });
}
