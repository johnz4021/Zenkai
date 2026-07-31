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
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { RoundSpec } from '@interview-prep/shared';
import { DEFAULT_DEBUGGING_SPEC } from '@interview-prep/shared';

/**
 * Per-check-kind mechanical requirements, selected in code — the generator
 * is TOLD which criterion applies and never writes its own. The
 * one_failing_test block is the original debugging prompt's requirement
 * text, verbatim in substance: it is gauntlet-proven and stays canonical.
 */
export const CHECK_REQUIREMENT_BLOCKS: Record<RoundSpec['check']['kind'], string> = {
  one_failing_test: `1. A small, realistic module set for the round's domain.
   - 4 to 8 source files. Pure logic + in-memory state. No HTTP server, no
     database, no external services.
   - Written like production code by a competent team: consistent style, no
     tutorial comments, realistic naming.
2. A behavioral test suite with 8 to 15 tests describing real behavior
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
   - Scope the work to fit the round's time limit for a strong college senior.
2. At least the spec's minimum number of tests (default 5; more is better).
3. EVERY test must fail on the untouched scaffold — the candidate starts from zero.
   No hidden tests: what they see is what grades them.
4. Do NOT include a reference solution anywhere in the repo.

Self-verification (do this before you finish — it is the whole point):
- Run the suite on the scaffold: every test must fail.
- Write a THROWAWAY solution elsewhere in memory or a temp file, confirm the suite
  would pass against it, then make sure no trace of it remains in the repo.`,

  all_passing: `1. An existing, working module set relevant to the round, with a green
   behavioral test suite (at least the spec's minimum, default 5).
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

export interface GenerateOptions {
  /** Directory to create the problem in. Created if missing; must be empty-ish. */
  targetDir: string;
  /** What round this is + any candidate-provided reference material. */
  brief: string;
  /** Round shape; absent = the legacy debugging default. */
  spec?: RoundSpec;
  /** Optional emphasis derived from the gap graph. */
  targetNote?: string;
  /** Prompt template path. */
  templatePath: string;
  model?: string;
  /** Hard wall-clock cap on the agent run. */
  timeoutMs?: number;
}

export interface GenerateResult {
  ok: boolean;
  exitCode: number | null;
  durationMs: number;
  /** Raw stdout from claude -p (json result payload when --output-format json). */
  stdout: string;
  stderr: string;
}

export async function generateProblem(opts: GenerateOptions): Promise<GenerateResult> {
  const template = await readFile(opts.templatePath, 'utf8');
  const spec = opts.spec ?? DEFAULT_DEBUGGING_SPEC;
  const prompt = template
    .replace(/\{\{ROUND_BRIEF\}\}/g, opts.brief)
    .replace(/\{\{CHECK_REQUIREMENTS\}\}/g, CHECK_REQUIREMENT_BLOCKS[spec.check.kind])
    .replace(/\{\{ROUND_SPEC_JSON\}\}/g, JSON.stringify(spec))
    .replace(/\{\{TARGET_NOTE\}\}/g, opts.targetNote ?? '');

  await mkdir(opts.targetDir, { recursive: true });

  const args = [
    '-p', prompt,
    '--output-format', 'json',
    // The target dir is dedicated and disposable; the agent must be able to
    // write files and run npm without interactive permission prompts.
    '--permission-mode', 'bypassPermissions',
    '--max-turns', '80',
  ];
  if (opts.model) args.push('--model', opts.model);

  const started = Date.now();
  return new Promise<GenerateResult>((resolve) => {
    const child = spawn('claude', args, {
      cwd: path.resolve(opts.targetDir),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));

    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
    }, opts.timeoutMs ?? 8 * 60_000);

    child.on('close', (code) => {
      clearTimeout(timeout);
      resolve({
        ok: code === 0,
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
