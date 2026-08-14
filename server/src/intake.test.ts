/**
 * Intake is the LLM's entry point into the vocabulary, so what gets tested
 * is the SEAM: flat draft → RoundSpec with derived tags, gated mechanically.
 * Model calls never happen here (repo convention).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { deriveMemoryTags } from '@interview-prep/shared';
import { attachmentBlocks, draftToSpec, listTargets, loadTarget, saveTarget, slugify } from './intake.js';

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

  it('a DECLINED round skips the coherence gate — the decline is the point', () => {
    // Live failure 2026-08-08: the planner declined Datadog's behavioral
    // session, the vocabulary gate sank the draft, and the panel silently
    // lacked the row the model's prose said was there. A declined round is
    // never generated, scheduled, or run.
    const behavioral = {
      ...oaDraft,
      id: 'datadog-behavioral',
      label: 'Datadog behavioral',
      check_kind: 'diff_present' as const, // incoherent — nothing to check
      unsupported: '45 minutes of conversation with no code to run',
    };
    const { spec, unsupported } = draftToSpec(behavioral);
    expect(unsupported).toMatch(/no code/);
    expect(spec.label).toBe('Datadog behavioral');
    // An undeclined incoherent shape still fails loudly. (diff_present
    // without files_changed stopped being the example: that requirement
    // moved to checkManifest so inference can author review rounds at all —
    // QA 2026-08-13. can_run_tests=false against a test-based kind remains
    // genuinely incoherent at spec time.)
    expect(() =>
      draftToSpec({ ...behavioral, unsupported: '', check_kind: 'all_failing', can_run_tests: false }),
    ).toThrow(/vocabulary gate/);
  });

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

  it('surface passes through only when the model asserted it', () => {
    // Absent must stay absent — a written-out surface:'undefined' or a
    // defaulted value would freeze today's derivation into every stored spec.
    expect('surface' in draftToSpec(oaDraft).spec.capabilities).toBe(false);
    const explicit = draftToSpec({ ...oaDraft, surface: 'ide' as const });
    expect(explicit.spec.capabilities.surface).toBe('ide');
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

describe('draftToSpec tolerates model-typed "optional strings" (live failure)', () => {
  const base = {
    id: 'x', label: 'X round', interviewer: false, can_run_tests: true,
    time_limit_minutes: 60, starts_from: 'blank' as const, submit: 'one_shot' as const,
    check_kind: 'all_failing' as const, rationale: 'r', unsupported: '',
  };
  it('null emphasis, numeric-string minutes, array unsupported', () => {
    const d = draftToSpec({ ...base, emphasis: null, time_limit_minutes: '60' } as never);
    expect(d.spec.emphasis).toBeUndefined();
    expect(d.spec.capabilities.time_limit_ms).toBe(60 * 60_000);
    const d2 = draftToSpec({ ...base, unsupported: ['needs a canvas'] } as never);
    expect(d2.unsupported).toBe('needs a canvas');
  });
});

describe('attachmentBlocks', () => {
  it('maps images and PDFs to typed blocks, PDFs with citations enabled', () => {
    const root = scratch();
    const t = {
      id: 't1', label: 'T', description: '', specs: [], created: '2026-08-06',
      attachments: [
        { name: 'preview.png', media_type: 'image/png', file: 'attachments/1-preview.png' },
        { name: 'guide.pdf', media_type: 'application/pdf', file: 'attachments/2-guide.pdf' },
      ],
    };
    saveTarget(root, t);
    const dir = path.join(root, 'targets', 't1', 'attachments');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, '1-preview.png'), Buffer.from([0x89, 0x50]));
    writeFileSync(path.join(dir, '2-guide.pdf'), Buffer.from('%PDF-1.4'));

    const blocks = attachmentBlocks(root, t);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ type: 'image', source: { type: 'base64', media_type: 'image/png' } });
    expect(blocks[1]).toMatchObject({
      type: 'document',
      title: 'guide.pdf',
      citations: { enabled: true },
      source: { type: 'base64', media_type: 'application/pdf' },
    });
    // Real bytes made the round trip, not a path or mojibake.
    expect((blocks[0] as { source: { data: string } }).source.data).toBe(Buffer.from([0x89, 0x50]).toString('base64'));
  });

  it('a missing file degrades to a text note instead of sinking the call', () => {
    const root = scratch();
    const t = {
      id: 't2', label: 'T', description: '', specs: [], created: '2026-08-06',
      attachments: [{ name: 'gone.png', media_type: 'image/png', file: 'attachments/1-gone.png' }],
    };
    saveTarget(root, t);
    const blocks = attachmentBlocks(root, t);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.type).toBe('text');
    expect(String((blocks[0] as { text: string }).text)).toContain('gone.png');
  });

  it('a target with no attachments yields no blocks', () => {
    const root = scratch();
    const t = { id: 't3', label: 'T', description: '', specs: [], created: '2026-08-06' };
    saveTarget(root, t);
    expect(attachmentBlocks(root, t)).toEqual([]);
  });
});
