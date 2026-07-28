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
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { isSpecChangeLabel, type GeneratedProblem } from '@interview-prep/shared';

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

/** Pure manifest checker. Exported for tests. */
export function checkManifest(problem: GeneratedProblem, repoDir: string): string[] {
  const failures: string[] = [];
  if (problem.round_type !== 'debugging') {
    failures.push(`round_type is ${problem.round_type}, expected debugging`);
  }
  if (!problem.planted_bug) {
    failures.push('planted_bug missing');
  } else {
    if (!problem.planted_bug.failing_test) failures.push('planted_bug.failing_test missing');
    if (!existsSync(path.join(repoDir, problem.planted_bug.file))) {
      failures.push(`planted_bug.file does not exist: ${problem.planted_bug.file}`);
    }
  }
  if (!problem.spec || problem.spec.length < 100) failures.push('spec missing or too short');
  const badLabels = (problem.rubric?.labels ?? []).filter((l) => !isSpecChangeLabel(l));
  if (badLabels.length > 0) failures.push(`rubric labels outside source of truth: ${badLabels.join(', ')}`);
  if (problem.rubric?.trigger?.event !== 'test_run') {
    failures.push('debugging rubric trigger must be test_run');
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

  // Install if the agent cleaned up node_modules (or we're on a fresh clone).
  if (!existsSync(path.join(repoDir, 'node_modules'))) {
    const install = spawnSync('npm', ['install', '--no-fund', '--no-audit'], {
      cwd: repoDir,
      encoding: 'utf8',
      timeout: 180_000,
    });
    if (install.status !== 0) {
      failures.push(`npm install failed: ${install.stderr?.slice(0, 400)}`);
      return { ok: false, problem, failures, failedTests: [] };
    }
  }

  const outFile = path.join(repoDir, '.vitest-report.json');
  spawnSync(
    'npx',
    ['vitest', 'run', '--reporter=json', `--outputFile=${outFile}`],
    { cwd: repoDir, encoding: 'utf8', timeout: 180_000 },
  );
  if (!existsSync(outFile)) {
    failures.push('vitest produced no JSON report');
    return { ok: false, problem, failures, failedTests: [] };
  }

  const { failed, total } = parseVitestJson(readFileSync(outFile, 'utf8'));
  if (total < 8) failures.push(`only ${total} tests — prompt requires >= 8`);
  if (failed.length !== 1) {
    failures.push(`expected exactly 1 failing test, got ${failed.length}: [${failed.join(' | ')}]`);
  } else if (
    problem.planted_bug &&
    failed[0] !== problem.planted_bug.failing_test &&
    !failed[0]?.includes(problem.planted_bug.failing_test)
  ) {
    failures.push(
      `failing test "${failed[0]}" is not the manifest's "${problem.planted_bug.failing_test}"`,
    );
  }

  return { ok: failures.length === 0, problem, failures, failedTests: failed };
}
