/**
 * The two solo-round gates (owner decision 2026-08-15: no mic and no chat on
 * rounds where nobody is listening, and no fabricated talk-verdicts on their
 * silent traces). Both are pure — this pins the precedence table and the
 * clamp's exact reach, because the failure mode of each is invisible in CI:
 * a mic that opens on a solo round records a silent room (TODOS #49), and a
 * fabricated 'weak' communicate writes a gap that steers future generation.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Assessment, JudgeResult } from './judge.js';
import { clampSilentDimensions } from './judge.js';
import { voiceOffReasonFor } from './session.js';

describe('voiceOffReasonFor — the mic exists iff someone is listening', () => {
  it('no interviewer outranks everything; then the flag; then the key', () => {
    expect(voiceOffReasonFor(false, true, true)).toBe('no_interviewer');
    expect(voiceOffReasonFor(false, false, false)).toBe('no_interviewer');
    expect(voiceOffReasonFor(true, false, true)).toBe('disabled');
    expect(voiceOffReasonFor(true, false, false)).toBe('disabled');
    expect(voiceOffReasonFor(true, true, false)).toBe('no_key');
    expect(voiceOffReasonFor(true, true, true)).toBeNull();
  });
});

const assessed = (verdicts: Partial<Record<string, string>>): Assessment => ({
  session_id: 's',
  status: 'assessed',
  judged_at: 1,
  model: 'm',
  prompt_hash: 'h',
  schema_version: 1,
  renderer_version: 1,
  expectations_used: {} as Assessment['expectations_used'],
  solved: true,
  summary: 'x',
  dimensions: (['clarify', 'approach', 'communicate', 'implement', 'verify', 'reflect'] as const).map(
    (dimension) => ({
      dimension,
      verdict: (verdicts[dimension] ?? 'adequate') as Assessment['dimensions'][number]['verdict'],
      analysis: 'judge said things',
      evidence: [12],
    }),
  ),
});

describe('clampSilentDimensions — no fabricated talk-verdicts on silent solo traces', () => {
  it('clamps communicate and reflect to unassessable, clears their evidence, leaves the rest', () => {
    const out = clampSilentDimensions(assessed({ communicate: 'weak', reflect: 'strong' }), {
      hasInterviewer: false,
      utteranceCount: 0,
    }) as Assessment;
    const byKey = Object.fromEntries(out.dimensions.map((d) => [d.dimension, d]));
    expect(byKey.communicate!.verdict).toBe('unassessable');
    expect(byKey.reflect!.verdict).toBe('unassessable');
    expect(byKey.communicate!.evidence).toEqual([]);
    // clarify/approach keep non-verbal evidence (what was read before the
    // first edit) — the judge's call stands.
    expect(byKey.clarify!.verdict).toBe('adequate');
    expect(byKey.implement!.verdict).toBe('adequate');
  });

  it('never fires with an interviewer, with any utterance, or on an unassessed result', () => {
    const a = assessed({ communicate: 'weak' });
    expect(clampSilentDimensions(a, { hasInterviewer: true, utteranceCount: 0 })).toBe(a);
    expect(clampSilentDimensions(a, { hasInterviewer: false, utteranceCount: 1 })).toBe(a);
    const un: JudgeResult = { session_id: 's', status: 'unassessed', judged_at: 1, reason: 'x' };
    expect(clampSilentDimensions(un, { hasInterviewer: false, utteranceCount: 0 })).toBe(un);
  });

  it('an already-unassessable row passes through untouched (no analysis rewrite)', () => {
    const out = clampSilentDimensions(assessed({ communicate: 'unassessable' }), {
      hasInterviewer: false,
      utteranceCount: 0,
    }) as Assessment;
    const row = out.dimensions.find((d) => d.dimension === 'communicate')!;
    expect(row.analysis).toBe('judge said things');
  });
});

describe('the solo trace stays utterance-free (pinned via source)', () => {
  const src = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), 'session.ts'),
    'utf8',
  );

  it('/api/utterance refuses before emitting when there is no interviewer', () => {
    const handler = src.slice(src.indexOf("url === '/api/utterance'"));
    const guard = handler.indexOf('if (!interviewer)');
    const emit = handler.indexOf("emitChrome('utterance'");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(emit);
  });

  it('finalize clamps BEFORE any write, and the voice gate consults the interviewer handle', () => {
    expect(src).toContain('clampSilentDimensions(');
    expect(src.indexOf('clampSilentDimensions(')).toBeLessThan(src.indexOf("path.join(cfg.repoRoot, 'assessments')"));
    expect(src).toContain('voiceOffReasonFor(interviewer !== null');
  });
});

describe('clamp scope follows the surface (evidence-scoped judging, 2026-08-16)', () => {
  const byKey = (r: JudgeResult) =>
    Object.fromEntries((r as Assessment).dimensions.map((d) => [d.dimension, d.verdict]));

  it('panes solo clamps four dimensions — tab-switching is not evidence', () => {
    const v = byKey(clampSilentDimensions(assessed({}), { hasInterviewer: false, utteranceCount: 0, surface: 'panes' }));
    expect(v.clarify).toBe('unassessable');
    expect(v.approach).toBe('unassessable');
    expect(v.communicate).toBe('unassessable');
    expect(v.reflect).toBe('unassessable');
    expect(v.implement).toBe('adequate');
    expect(v.verify).toBe('adequate');
  });

  it('IDE solo keeps clarify/approach — navigation and terminal are real signal', () => {
    const v = byKey(clampSilentDimensions(assessed({}), { hasInterviewer: false, utteranceCount: 0, surface: 'ide' }));
    expect(v.clarify).toBe('adequate');
    expect(v.approach).toBe('adequate');
    expect(v.communicate).toBe('unassessable');
    expect(v.reflect).toBe('unassessable');
  });

  it('interviewer rounds clamp nothing regardless of surface', () => {
    const a = assessed({});
    expect(clampSilentDimensions(a, { hasInterviewer: true, utteranceCount: 0, surface: 'panes' })).toBe(a);
  });
});
