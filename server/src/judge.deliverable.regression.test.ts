/**
 * Regression: QA 2026-08-14 (sess-1786722081844) — on a review_diff round
 * the judge only ever saw the timeline; REVIEW.md, the round's entire
 * graded artifact, was invisible to grading, so a correct review scored
 * weak on every dimension. judgeSession now reads the written deliverable
 * from problemDir when the round has no planted bug and no test run.
 * Report: .gstack/qa-reports/qa-report-interview-prep-2026-08-14.md
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { TraceEvent } from '@interview-prep/shared';
import { deliverableText, judgeSession } from './judge.js';

const dir = mkdtempSync(path.join(tmpdir(), 'judge-deliverable-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const ev = (type: string, payload: Record<string, unknown> = {}, seq = 1): TraceEvent =>
  ({ seq, ts: 1000 + seq, type, payload } as unknown as TraceEvent);

describe('deliverableText', () => {
  it('picks up REVIEW.md by convention plus any .md the candidate saved', () => {
    writeFileSync(path.join(dir, 'REVIEW.md'), '# Review of PR\n- bug in rollup.py');
    writeFileSync(path.join(dir, 'NOTES.md'), 'scratch thinking');
    const events = [ev('file_save', { path: 'NOTES.md' }, 2)];
    const text = deliverableText(dir, events);
    expect(text).toContain('--- REVIEW.md ---');
    expect(text).toContain('bug in rollup.py');
    expect(text).toContain('--- NOTES.md ---');
  });

  it('returns empty when nothing was written', () => {
    const empty = mkdtempSync(path.join(tmpdir(), 'judge-deliverable-empty-'));
    expect(deliverableText(empty, [])).toBe('');
    rmSync(empty, { recursive: true, force: true });
  });
});

describe('judgeSession — review-shaped rounds', () => {
  const template = path.join(dir, 'template.md');
  writeFileSync(template, '{{SPEC}}\n{{BUG}}\n{{DIMENSION_ANCHORS}}\n{{EXPECTATIONS}}\n{{TIMELINE}}');
  const problemBase = { round_type: 'debugging', spec: 'review the diff', rubric: undefined };

  it('appends the deliverable to the ground truth when no bug and no run', async () => {
    let seen = '';
    await judgeSession({
      sessionId: 's1',
      events: [ev('session_start'), ev('session_end', {}, 9)],
      problem: { ...problemBase, planted_bug: undefined } as never,
      problemDir: dir,
      templatePath: template,
      judgeModel: async (prompt) => {
        seen = prompt;
        throw new Error('capture only');
      },
    });
    expect(seen).toContain('submitted written deliverable');
    expect(seen).toContain('bug in rollup.py');
  });

  it('does NOT inject the deliverable when the trace has a graded run', async () => {
    let seen = '';
    await judgeSession({
      sessionId: 's2',
      events: [ev('session_start'), ev('test_run', { via: 'submit', exit_code: 0 }, 5), ev('session_end', {}, 9)],
      problem: { ...problemBase, planted_bug: undefined } as never,
      problemDir: dir,
      templatePath: template,
      judgeModel: async (prompt) => {
        seen = prompt;
        throw new Error('capture only');
      },
    });
    expect(seen).not.toContain('submitted written deliverable');
  });

  it('does NOT inject the deliverable on planted-bug rounds', async () => {
    let seen = '';
    await judgeSession({
      sessionId: 's3',
      events: [ev('session_start'), ev('session_end', {}, 9)],
      problem: {
        ...problemBase,
        planted_bug: { file: 'a.py', line: 3, description: 'off by one', failing_test: 't' },
      } as never,
      problemDir: dir,
      templatePath: template,
      judgeModel: async (prompt) => {
        seen = prompt;
        throw new Error('capture only');
      },
    });
    expect(seen).not.toContain('submitted written deliverable');
  });
});
