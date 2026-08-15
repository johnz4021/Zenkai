/**
 * The self-healing generation pins (owner decision 2026-08-15: five of six
 * prod builds failed at least once, every recovery manual — adopt Claude
 * Code's own layers). Layer 2a: the validator joins the agent's loop via
 * {{VALIDATE_CMD}}. Layer 2b: a repair pass with the validator's failures
 * as prompt. Layer 1: blind retry-once in the app's close handlers, exit-64
 * excluded (judge.ts's doctrine: config state repeats identically). Most of
 * the wiring lives in spawn handlers and a CLI flow that only fire against
 * real processes, so the ordering contracts are pinned via source — the
 * repo's established idiom for exactly this (app.test.ts).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_DEBUGGING_SPEC } from '@interview-prep/shared';
import { buildRepairPrompt, VALIDATE_CMD } from './generate.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(path.join(here, rel), 'utf8');

describe('layer 2a — the gate joins the loop', () => {
  it('the generator template tells the agent to run the real validator before finishing', () => {
    const tpl = read('../../prompts/generate-round.md');
    expect(tpl).toContain('{{VALIDATE_CMD}}');
    expect(tpl).toContain('Prove it before you finish');
    // The trust boundary is stated to the agent: the pipeline re-rules.
    expect(tpl).toMatch(/re-runs the same check\s+authoritatively/);
  });

  it('VALIDATE_CMD points at this repo’s CLI and runs in the agent’s cwd', () => {
    expect(VALIDATE_CMD).toMatch(/^npx tsx .*server\/src\/cli\.ts validate \.$/);
  });
});

describe('layer 2b — the repair prompt (pure substitution)', () => {
  const tpl = read('../../prompts/repair-round.md');

  it('the template opens with the shim-dispatch marker and carries every placeholder', () => {
    expect(tpl.startsWith('# Round repair')).toBe(true);
    for (const ph of ['{{FAILURES}}', '{{ROUND_SPEC_JSON}}', '{{CHECK_REQUIREMENTS}}', '{{SOURCED_NOTE}}', '{{VALIDATE_CMD}}']) {
      expect(tpl, ph).toContain(ph);
    }
    // The one rule that keeps repair honest: never weaken tests to pass.
    expect(tpl).toMatch(/NEVER weaken, delete, or trivialize\s+tests/);
  });

  it('failures land verbatim as a list, and the sourced note appears only when sourced', () => {
    const failures = ['expectation for reflect shares no vocabulary with the spec — x', 'only 4 tests — one_failing_test requires >= 8'];
    const invented = buildRepairPrompt(tpl, { failures, spec: DEFAULT_DEBUGGING_SPEC, sourced: false });
    for (const f of failures) expect(invented).toContain(`- ${f}`);
    expect(invented).not.toContain('DATASET-SOURCED');
    expect(invented).toContain(VALIDATE_CMD);
    const sourced = buildRepairPrompt(tpl, { failures, spec: DEFAULT_DEBUGGING_SPEC, sourced: true });
    expect(sourced).toContain('DATASET-SOURCED');
    expect(sourced).toContain('fix ONLY solution files');
  });
});

describe('layer 2b — cli wiring (pinned via source)', () => {
  const cli = readFileSync(path.join(here, 'cli.ts'), 'utf8');

  it('repair is gated on a parseable manifest, runs once, and the re-rule decides', () => {
    expect(cli).toContain('manifestParses');
    const repairAt = cli.indexOf('repairProblem({');
    expect(repairAt).toBeGreaterThan(-1);
    // Sourced re-stamp after EVERY agent exit, then the authoritative re-rule.
    expect(cli.indexOf('await restampSourced();', repairAt)).toBeGreaterThan(repairAt);
    expect(cli.indexOf('await ruleOnArtifact();', repairAt)).toBeGreaterThan(cli.indexOf('await restampSourced();', repairAt));
    // Exactly one repair pass: a single call site.
    expect(cli.match(/repairProblem\(\{/g)).toHaveLength(1);
  });
});

describe('layer 1 — blind retry-once (pinned via source)', () => {
  const app = readFileSync(path.join(here, 'app.ts'), 'utf8');

  it('both close handlers try the automatic retry before writing .failed', () => {
    const calls = app.match(/autoRetryOnce\(dir, code, /g) ?? [];
    expect(calls).toHaveLength(2);
    // In each handler the retry attempt precedes the .failed write.
    for (const anchor of ['generation for ${item.id}', 'rep ${rep.id} build']) {
      const at = app.indexOf(anchor);
      expect(at, anchor).toBeGreaterThan(-1);
      const failedWrite = app.indexOf("writeFileSync(path.join(dir, '.failed')", at);
      expect(failedWrite).toBeGreaterThan(at);
    }
  });

  it('the retry excludes exit 64, is bounded by the rotated-log ledger, and respects the slot', () => {
    const fn = app.slice(app.indexOf('function autoRetryOnce'));
    expect(fn).toContain('if (code === 64) return false;');
    expect(fn).toContain("existsSync(dir + '.build.1.log')");
    // `>` not `>=`: reconcileWithDisk still counts this item as generating
    // at close time, so it holds its own slot.
    expect(fn).toContain('countLiveBuilds() > maxBuildsCap');
    expect(fn).toContain('rmSync(dir, { recursive: true, force: true });');
  });

  it('both manual retries rotate the log, wipe the dir, and honor the global slot', () => {
    for (const anchor of ['retrying generation for', 'rep ${rep.id} retrying']) {
      const at = app.indexOf(anchor);
      expect(at, anchor).toBeGreaterThan(-1);
      const window = app.slice(at - 1600, at);
      expect(window, anchor).toContain('rotateBuildLog(dir);');
      expect(window, anchor).toContain('rmSync(dir, { recursive: true, force: true });');
      expect(window, anchor).toContain('countLiveBuilds() >= cfg.pub.caps.maxConcurrentBuilds');
    }
  });

  it('every build event carries the attempt derived from the ledger', () => {
    expect(app.match(/attempt: buildAttempt\(dir\)/g)?.length).toBe(2); // both build_started
    expect(app.match(/duration_ms: Date\.now\(\) - buildT0, attempt/g)?.length).toBe(4); // failed(auto)+final, both kinds
  });
});
