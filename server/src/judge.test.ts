import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { TraceEvent } from '@interview-prep/shared';
import {
  JudgeTimeoutError,
  buildJudgePrompt,
  judgeSession,
  parseAssessmentOutput,
  promptHash,
  verifyCitations,
} from './judge.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TEMPLATE = path.join(REPO, 'prompts', 'judge-session.md');

let n = 0;
const T0 = 1_000_000;
const ev = (type: TraceEvent['type'], dtSec: number, payload: unknown = {}, source: TraceEvent['source'] = 'extension'): TraceEvent => ({
  session_id: 's', user_id: 'u', source, seq: n++, ts: T0 + dtSec * 1000, type, payload,
});

const EVENTS: TraceEvent[] = [
  ev('session_start', 0),
  ev('test_run', 6, { exit_code: 1 }),
  ev('utterance', 50, { text: 'the sweep releases the full count, not the remaining' }, 'chrome'),
  ev('interviewer', 60, { text: 'what makes you say that?', nudge: false }, 'chrome'),
  ev('edit', 90, { path: '/p/src/sweep.ts' }),
  ev('test_run', 200, { exit_code: 0 }),
  ev('session_end', 220, {}, 'chrome'),
];

const PROBLEM = {
  round_type: 'debugging' as const,
  spec: 'Inventory holds expire on their own deadlines.',
  planted_bug: {
    file: 'src/sweep.ts', line: 10,
    description: 'sweep releases the original unit count instead of remaining',
    failing_test: 'expiry > releases remaining units',
  },
  rubric: { round_type: 'debugging' as const },
};

const GOOD_OUTPUT = JSON.stringify({
  solved: true,
  summary: 'Read the failure, named the mechanism, fixed and verified.',
  dimensions: [
    { dimension: 'clarify', verdict: 'adequate', analysis: 'Read the failing output before acting.', evidence: [6] },
    { dimension: 'approach', verdict: 'strong', analysis: 'Named the exact mechanism before editing.', evidence: [50] },
    { dimension: 'communicate', verdict: 'adequate', analysis: 'Narrated the key hypothesis.', evidence: [50] },
    { dimension: 'implement', verdict: 'adequate', analysis: 'One targeted change at the stated site.', evidence: [90] },
    { dimension: 'verify', verdict: 'strong', analysis: 'Re-ran the suite and confirmed green.', evidence: [200] },
    { dimension: 'reflect', verdict: 'unassessable', analysis: 'Session ended immediately after the green run.', evidence: [] },
  ],
});

describe('parseAssessmentOutput (schema is the gate)', () => {
  it('accepts the contract and tolerates prose around the JSON', () => {
    const parsed = parseAssessmentOutput('Here you go:\n```json\n' + GOOD_OUTPUT + '\n```');
    expect(parsed.solved).toBe(true);
    expect(parsed.dimensions).toHaveLength(6);
  });

  it('rejects a missing dimension — partial output must not become a partial verdict', () => {
    const bad = JSON.parse(GOOD_OUTPUT);
    bad.dimensions.pop();
    expect(() => parseAssessmentOutput(JSON.stringify(bad))).toThrow(/missing dimension: reflect/);
  });

  it('rejects unknown verdicts and unknown dimensions', () => {
    const bad = JSON.parse(GOOD_OUTPUT);
    bad.dimensions[0].verdict = 'excellent';
    expect(() => parseAssessmentOutput(JSON.stringify(bad))).toThrow(/unknown verdict/);
    const bad2 = JSON.parse(GOOD_OUTPUT);
    bad2.dimensions[0].dimension = 'vibes';
    expect(() => parseAssessmentOutput(JSON.stringify(bad2))).toThrow(/unknown dimension/);
  });

  it('rejects non-JSON entirely', () => {
    expect(() => parseAssessmentOutput('I think they did fine overall.')).toThrow(/no JSON/);
  });

  // Live failure (sess-1785461200029): even through a forced tool call the
  // API validates only the TOP level of the input schema, and the model sent
  // dimensions as a stringified array — with a stray `}` trailing it. The
  // string held a complete, correct assessment; discarding it cost a session.
  it('normalizes a stringified dimensions array, ignoring trailing garbage', () => {
    const good = JSON.parse(GOOD_OUTPUT);
    const wrapped = JSON.stringify({
      solved: good.solved,
      summary: good.summary,
      dimensions: JSON.stringify(good.dimensions) + '}',
    });
    const parsed = parseAssessmentOutput(wrapped);
    expect(parsed.dimensions).toHaveLength(6);
    expect(parsed.dimensions[1]!.verdict).toBe('strong');
  });

  it('a stringified dimensions field with no array inside still fails loudly', () => {
    const bad = JSON.stringify({ solved: true, summary: 'x', dimensions: 'they did well' });
    expect(() => parseAssessmentOutput(bad)).toThrow(/no array inside/);
  });
});

describe('verifyCitations (attribution is the likely failure)', () => {
  const dims = (evidence: number[]) => [
    { dimension: 'approach' as const, verdict: 'weak' as const, analysis: 'x', evidence },
  ];

  it('keeps citations that resolve to candidate events', () => {
    const out = verifyCitations(dims([50, 90]), EVENTS);
    expect(out[0]!.evidence).toEqual([50, 90]);
    expect(out[0]!.evidence_stripped).toBeUndefined();
  });

  it("strips a citation of the INTERVIEWER's line — context, never candidate evidence", () => {
    const out = verifyCitations(dims([60]), EVENTS);
    expect(out[0]!.evidence).toEqual([]);
    expect(out[0]!.stripped_evidence).toEqual([60]);
    expect(out[0]!.evidence_stripped).toBe(true);
  });

  it('strips citations that resolve to nothing (±2s tolerance)', () => {
    const out = verifyCitations(dims([130]), EVENTS);
    expect(out[0]!.evidence).toEqual([]);
    expect(out[0]!.evidence_stripped).toBe(true);
  });

  it('unassessable needs no evidence by definition', () => {
    const out = verifyCitations(
      [{ dimension: 'reflect', verdict: 'unassessable', analysis: 'nothing to see', evidence: [999] }],
      EVENTS,
    );
    expect(out[0]!.evidence).toEqual([]);
    expect(out[0]!.evidence_stripped).toBeUndefined();
  });
});

describe('judgeSession pipeline', () => {
  it('produces a versioned assessment from a well-behaved model', async () => {
    const result = await judgeSession({
      sessionId: 's1', events: EVENTS, problem: PROBLEM, templatePath: TEMPLATE,
      judgeModel: async () => GOOD_OUTPUT, modelName: 'fake',
    });
    expect(result.status).toBe('assessed');
    if (result.status === 'assessed') {
      expect(result.prompt_hash).toHaveLength(12);
      expect(result.schema_version).toBe(1);
      expect(result.expectations_used.approach).toContain('MECHANISM');
      expect(result.dimensions.find((d) => d.dimension === 'verify')?.verdict).toBe('strong');
    }
  });

  it('a failing model yields UNASSESSED — never a fabricated verdict', async () => {
    const result = await judgeSession({
      sessionId: 's1', events: EVENTS, problem: PROBLEM, templatePath: TEMPLATE,
      judgeModel: async () => { throw new Error('api down'); },
    });
    expect(result.status).toBe('unassessed');
    if (result.status === 'unassessed') expect(result.reason).toContain('api down');
  });

  it('parse failure is NOT retried (schema mismatch repeats at full cost)', async () => {
    let calls = 0;
    const result = await judgeSession({
      sessionId: 's1', events: EVENTS, problem: PROBLEM, templatePath: TEMPLATE,
      judgeModel: async () => { calls++; return 'not json at all'; },
    });
    expect(result.status).toBe('unassessed');
    expect(calls).toBe(1);
  });

  it('a timeout IS retried once, then unassessed', async () => {
    let calls = 0;
    const result = await judgeSession({
      sessionId: 's1', events: EVENTS, problem: PROBLEM, templatePath: TEMPLATE,
      judgeModel: async () => { calls++; throw new JudgeTimeoutError('slow'); },
    });
    expect(result.status).toBe('unassessed');
    expect(calls).toBe(2);
  });

  // A live session died to `SyntaxError ... at position 430` and the output
  // that caused it was never written down, so the only way to see it was to
  // re-run a nondeterministic model against a session that had already ended.
  // Whatever the judge says that we cannot use, we keep.
  it('keeps the raw output when the model emits malformed JSON', async () => {
    const slop = '{"solved": false, "summary": "he said "yes" out loud", "dimensions": []}';
    const result = await judgeSession({
      sessionId: 's1', events: EVENTS, problem: PROBLEM, templatePath: TEMPLATE,
      judgeModel: async () => slop,
    });
    expect(result.status).toBe('unassessed');
    if (result.status === 'unassessed') {
      expect(result.reason).toContain('unparseable twice');
      expect(result.raw_output).toBe(slop);
    }
  });

  it('keeps the raw output when the model breaks the schema', async () => {
    const wrong = JSON.stringify({ solved: false, summary: 'ok', dimensions: [] });
    const result = await judgeSession({
      sessionId: 's1', events: EVENTS, problem: PROBLEM, templatePath: TEMPLATE,
      judgeModel: async () => wrong,
    });
    expect(result.status).toBe('unassessed');
    if (result.status === 'unassessed') expect(result.raw_output).toBe(wrong);
  });

  it('records no raw output when the model never spoke', async () => {
    const result = await judgeSession({
      sessionId: 's1', events: EVENTS, problem: PROBLEM, templatePath: TEMPLATE,
      judgeModel: async () => { throw new Error('api down'); },
    });
    expect(result.status).toBe('unassessed');
    if (result.status === 'unassessed') expect(result.raw_output).toBeUndefined();
  });

  it('a timeout followed by success assesses normally', async () => {
    let calls = 0;
    const result = await judgeSession({
      sessionId: 's1', events: EVENTS, problem: PROBLEM, templatePath: TEMPLATE,
      judgeModel: async () => {
        calls++;
        if (calls === 1) throw new JudgeTimeoutError('slow');
        return GOOD_OUTPUT;
      },
    });
    expect(result.status).toBe('assessed');
  });
});

describe('prompt assembly', () => {
  const template = readFileSync(TEMPLATE, 'utf8');

  it('fills every slot — a literal {{VAR}} is a silently broken prompt', () => {
    const prompt = buildJudgePrompt(template, {
      timeline: 'THE TIMELINE', spec: 'THE SPEC', bug: 'THE BUG',
      expectations: {
        clarify: 'c', approach: 'a', communicate: 'm', implement: 'i', verify: 'v', reflect: 'r',
      },
    });
    expect(prompt).not.toMatch(/\{\{[A-Z_]+\}\}/);
    expect(prompt).toContain('THE TIMELINE');
    expect(prompt).toContain('THE BUG');
    expect(prompt).toContain('- approach: a');
  });

  it('prompt hash covers the anchors too — an anchor change invalidates comparability', () => {
    expect(promptHash(template)).toHaveLength(12);
    expect(promptHash(template)).not.toBe(promptHash(template + ' '));
  });
});
