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

export interface GenerateOptions {
  /** Directory to create the problem in. Created if missing; must be empty-ish. */
  targetDir: string;
  theme: string;
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
  const prompt = template
    .replace(/\{\{THEME\}\}/g, opts.theme)
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
