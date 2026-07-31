/**
 * Intake is the LLM's entry point into the vocabulary, so what gets tested
 * is the SEAM: flat draft → RoundSpec with derived tags, gated mechanically.
 * Model calls never happen here (repo convention).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { deriveMemoryTags } from '@interview-prep/shared';
import { draftToSpec, listTargets, loadTarget, saveTarget, slugify } from './intake.js';

const dirs: string[] = [];
const scratch = () => {
  const d = mkdtempSync(path.join(tmpdir(), 'ip-intake-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('draftToSpec', () => {
  const oaDraft = {
    id: 'Node OA!!',
    label: 'Node.js HackerRank task',
    interviewer: false,
    can_run_tests: true,
    time_limit_minutes: 90,
    starts_from: 'blank' as const,
    submit: 'one_shot' as const,
    check_kind: 'all_failing' as const,
    emphasis: 'REST endpoints',
    rationale: 'Described as an autograded timed task built from scratch.',
    unsupported: '',
  };

  it('converts minutes to ms, slugifies the id, derives the tags', () => {
    const { spec, rationale, unsupported } = draftToSpec(oaDraft);
    expect(spec.capabilities.time_limit_ms).toBe(90 * 60_000);
    expect(spec.id).toBe('node-oa');
    expect(spec.memory_tags).toEqual(['from_scratch', 'time_boxed', 'autograded']);
    expect(spec.emphasis).toBe('REST endpoints');
    expect(rationale).toMatch(/autograded/);
    expect(unsupported).toBeUndefined();
  });

  it('an incoherent draft dies at the vocabulary gate, never reaches a session', () => {
    expect(() =>
      draftToSpec({ ...oaDraft, can_run_tests: false }),
    ).toThrow(/incoherent/);
  });

  it('unsupported passes through so the product can decline honestly', () => {
    const d = draftToSpec({
      ...oaDraft,
      check_kind: 'all_passing' as const,
      unsupported: 'This is a system-design round; there is no code to write.',
    });
    expect(d.unsupported).toMatch(/system-design/);
  });
});

describe('deriveMemoryTags', () => {
  it('a live debugging round derives the legacy tag pair', () => {
    expect(
      deriveMemoryTags({
        interviewer: true,
        can_run_tests: true,
        time_limit_ms: null,
        starts_from: 'repo',
        submit: 'iterate',
      }),
    ).toEqual(['has_existing_code', 'live_interviewer']);
  });
});

describe('target store', () => {
  it('round-trips and lists in creation order', () => {
    const root = scratch();
    saveTarget(root, { id: 'b-target', label: 'B', description: '', specs: [], created: '2026-08-02' });
    saveTarget(root, { id: 'a-target', label: 'A', description: '', specs: [], created: '2026-08-01' });
    expect(loadTarget(root, 'b-target')?.label).toBe('B');
    expect(loadTarget(root, 'missing')).toBeNull();
    expect(listTargets(root).map((t) => t.label)).toEqual(['A', 'B']);
  });
});

describe('slugify', () => {
  it('produces filesystem-safe ids', () => {
    expect(slugify('Palantir SWE (new grad)!')).toBe('palantir-swe-new-grad');
    expect(slugify('***')).toBe('target');
  });
});
