/**
 * Eval seam: the classifier against hand-labeled REAL sessions.
 *
 *   fixtures/<session>.jsonl         real trace, captured from a live session
 *   fixtures/<session>.labels.json   what a human says the window contains
 *
 *   for each pair:  classify(trace) vs hand labels  →  per-label agreement
 *
 * This is the difference between "I believe the classifier" and "the
 * classifier agreed with me on N of M windows". labels.ts warns that label
 * drift without an eval makes the system silently measure nothing — this
 * file is the tripwire. It is NOT the full eval harness (6A/T8): utterance
 * judgments are part of the hand labels, so the MECHANICAL layer is what is
 * being measured; LLM-judge accuracy is a separate, deferred question.
 *
 * Fixtures are ground truth. A failure here means the classifier changed
 * meaning on a real session — either fix the regression or re-label the
 * fixture ON PURPOSE, with the diff explaining why the old label was wrong.
 *
 * To add a fixture: copy traces/<session>.jsonl into fixtures/, hand-write
 * <session>.labels.json next to it (see the existing one for the shape).
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Rubric, SpecChangeLabel, TraceEvent } from '@interview-prep/shared';
import { SPEC_CHANGE_LABELS } from '@interview-prep/shared';
import { classify, type UtteranceJudge, type UtteranceJudgment } from './classifier.js';

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures');

/** The canonical debugging rubric (matches the generator prompt). */
const DEBUGGING_RUBRIC: Rubric = {
  round_type: 'debugging',
  trigger: { event: 'test_run', predicate: 'first_failure' },
  window: { until: 'test_run', min_duration_ms: 30_000, duration_ms: 600_000 },
  labels: SPEC_CHANGE_LABELS,
  expectation: 'reads the failure before editing',
};

interface HandLabels {
  session_id: string;
  note: string;
  round_type: string;
  utterance_judgments: (UtteranceJudgment & { text: string; why: string })[];
  expected: {
    trigger_occurred: boolean;
    labels: SpecChangeLabel[];
    contaminated: SpecChangeLabel[];
  };
}

function loadFixtures(): { name: string; events: TraceEvent[]; labels: HandLabels }[] {
  if (!existsSync(FIXTURES)) return [];
  return readdirSync(FIXTURES)
    .filter((f) => f.endsWith('.labels.json'))
    .map((f) => {
      const name = f.replace('.labels.json', '');
      const labels = JSON.parse(readFileSync(path.join(FIXTURES, f), 'utf8')) as HandLabels;
      const events = readFileSync(path.join(FIXTURES, `${name}.jsonl`), 'utf8')
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as TraceEvent);
      return { name, events, labels };
    });
}

const fixtures = loadFixtures();

describe('classifier vs hand-labeled real sessions', () => {
  it('has at least one hand-labeled fixture (the seam is not decorative)', () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  for (const { name, events, labels } of fixtures) {
    it(`agrees with the hand labels on ${name}`, async () => {
      // The hand judgments ARE the judge: the mechanical layer is under test.
      const judge: UtteranceJudge = async (utterances) =>
        utterances.map(
          (u) =>
            labels.utterance_judgments.find((j) => j.seq === u.seq) ?? {
              seq: u.seq,
              clarifying_question: false,
              assumption_update: false,
            },
        );

      const result = await classify(events, DEBUGGING_RUBRIC, 'spec', judge);

      const fired = new Set(result.labels.filter((l) => !l.contaminated).map((l) => l.label));
      const contaminated = new Set(
        result.labels.filter((l) => l.contaminated).map((l) => l.label),
      );

      // Per-label agreement over the WHOLE label set — absent labels count.
      // A report like "4/5 labels agree; disagreement: inactivity" names the
      // drift; a bare set-equality failure would not.
      const disagreements: string[] = [];
      for (const label of SPEC_CHANGE_LABELS) {
        const expected = labels.expected.labels.includes(label);
        if (fired.has(label) !== expected) {
          disagreements.push(
            `${label}: classifier=${fired.has(label) ? 'fired' : 'silent'}, hand-label=${expected ? 'fired' : 'silent'}`,
          );
        }
      }

      const agreement = `${SPEC_CHANGE_LABELS.length - disagreements.length}/${SPEC_CHANGE_LABELS.length}`;
      // eslint-disable-next-line no-console
      console.log(
        `[eval] ${name}: ${agreement} labels agree` +
          (disagreements.length ? ` — ${disagreements.join('; ')}` : ''),
      );

      expect(result.trigger_occurred).toBe(labels.expected.trigger_occurred);
      expect(disagreements).toEqual([]);
      expect([...contaminated].sort()).toEqual([...labels.expected.contaminated].sort());
    });
  }
});
