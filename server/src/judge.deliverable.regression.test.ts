/**
 * Regression: QA 2026-08-14 (sess-1786722081844) — on a review_diff round
 * the judge only ever saw the timeline; REVIEW.md, the round's entire
 * graded artifact, was invisible to grading, so a correct review scored
 * weak on every dimension. judgeSession now reads the written deliverable
 * from problemDir when the ROUND SPEC says the round is review-shaped
 * (check.kind 'diff_present', or can_run_tests false), or when nothing was
 * graded at all.
 *
 * The first cut of this fix gated on "no planted bug AND no test_run" and
 * never fired on a real review round: generation plants the diff's defects
 * in `planted_bug` (rep-mst39p35 = planted_bug api.py:77 WITH
 * check.kind:'diff_present'), so the very round it was written for was
 * excluded — and the test below asserting that exclusion locked the bug in.
 * Caught by QA fix-verification, 2026-08-14 (sess-qa814-verify-rd: a
 * 3,957-byte REVIEW.md with both blockers correctly traced, still graded
 * blind). Dispatch on the closed vocabulary, never on trace shape.
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

  // The shape that shipped to real candidates and that the first cut missed:
  // a review round carries BOTH a planted_bug (the defects seeded in the
  // diff) and check.kind 'diff_present'. The spec decides, not the trace.
  it('injects the deliverable on a diff_present round that ALSO has a planted bug', async () => {
    let seen = '';
    await judgeSession({
      sessionId: 's4',
      events: [ev('session_start'), ev('session_end', {}, 9)],
      problem: {
        ...problemBase,
        planted_bug: { file: 'api.py', line: 77, description: 'four seeded defects', failing_test: '' },
        round_spec: {
          id: 'code-review-diff',
          label: 'Code review',
          check: { kind: 'diff_present', files_changed: ['api.py'] },
          capabilities: {
            interviewer: false,
            can_run_tests: false,
            time_limit_ms: 2_700_000,
            starts_from: 'diff',
            submit: 'one_shot',
            surface: 'panes',
          },
        },
      } as never,
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
