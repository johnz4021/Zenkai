/**
 * Planner tests exercise the SEAMS, never the model (repo convention):
 * the proposal gate, the turn gate, the conversation store's crash
 * tolerance, and the turn loop with an injected fake model
 * (JudgeSessionOptions precedent).
 */
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { saveTarget, type Target } from './intake.js';
import {
  appendTurns, conversationPath, gatePlannerTurn, gateProposal, latestProposal,
  loadConversation, renderConversation, renderPlannerSplit, runPlannerTurn,
  type PlannerModel, type PlannerTurn,
} from './planner.js';

const dirs: string[] = [];
const scratch = () => {
  const d = mkdtempSync(path.join(tmpdir(), 'ip-planner-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const ROUND = {
  id: 'stripe-debugging', label: 'Stripe debugging round', interviewer: true,
  can_run_tests: true, time_limit_minutes: 45, starts_from: 'repo' as const,
  submit: 'iterate' as const, check_kind: 'one_failing_test' as const,
  rationale: 'Recruiter email names the round and its length.', unsupported: '',
};

const target = (over: Partial<Target> = {}): Target => ({
  id: 'stripe-x1', label: 'Stripe', description: 'Stripe backend loop',
  specs: [], created: '2026-08-06', ...over,
});

describe('gateProposal', () => {
  it('gates rounds through the shared vocabulary gate, carrying dates', () => {
    const p = gateProposal({ rounds: [{ ...ROUND, date: '2026-08-18' }] });
    expect(p.drafts).toHaveLength(1);
    expect(p.drafts[0]?.spec.date).toBe('2026-08-18');
    expect(p.drafts[0]?.spec.memory_tags).toContain('has_existing_code');
  });

  it('a garbled date sinks that draft, not its siblings', () => {
    const p = gateProposal({ rounds: [{ ...ROUND, date: 'Aug 18th' }, { ...ROUND, id: 'r2', label: 'R2' }] });
    expect(p.drafts).toHaveLength(1);
    expect(p.drafts[0]?.spec.id).toBe('r2');
  });

  it('every draft failing throws; empty rounds throws', () => {
    expect(() => gateProposal({ rounds: [{ ...ROUND, starts_from: 'cloud' }] })).toThrow(/every draft failed/);
    expect(() => gateProposal({ rounds: [] })).toThrow(/without rounds/);
  });

  it('duplicate ids throw; sources filter to valid verdicts; conflict needs both sides', () => {
    expect(() => gateProposal({ rounds: [ROUND, ROUND] })).toThrow(/duplicate/);
    const p = gateProposal({
      rounds: [ROUND],
      sources: [
        { url: 'https://stripe.com/blog', verdict: 'agrees', note: 'runs in a real repo' },
        { url: 'https://x.test', verdict: 'maybe' },
        { verdict: 'thin' },
      ],
      conflict: { yours: 'the email says 90 minutes', theirs: 'a guide says 60', source_url: 'https://g.test' },
      summary: 'Two rounds, browser editor.',
    });
    expect(p.sources).toEqual([{ url: 'https://stripe.com/blog', verdict: 'agrees', note: 'runs in a real repo' }]);
    expect(p.conflict?.source_url).toBe('https://g.test');
    expect(p.summary).toBe('Two rounds, browser editor.');
    const noConflict = gateProposal({ rounds: [ROUND], conflict: { yours: 'x' } });
    expect(noConflict.conflict).toBeUndefined();
  });

  it('questions: 2-4 options enforced, max 3 questions', () => {
    const q = (id: string) => ({ id, question: 'Editor contents?', options: [{ label: 'repo' }, { label: 'blank' }], why: 'shape' });
    expect(gateProposal({ rounds: [ROUND], questions: [q('a')] }).questions).toHaveLength(1);
    expect(() => gateProposal({ rounds: [ROUND], questions: [{ ...q('a'), options: [{ label: 'one' }] }] })).toThrow(/options/);
    expect(() => gateProposal({ rounds: [ROUND], questions: [q('a'), q('b'), q('c'), q('d')] })).toThrow(/max 3/);
  });
});

describe('gatePlannerTurn', () => {
  it('concatenates prose, counts searches, collects result urls, extracts the proposal', () => {
    const reply = gatePlannerTurn([
      { type: 'text', text: 'The 90-minute round is unsettled.' },
      { type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'stripe practical round' } },
      { type: 'web_search_tool_result', tool_use_id: 's1', content: [
        { type: 'web_search_result', url: 'https://stripe.com/jobs', title: 'Jobs' },
        { type: 'web_search_result', url: 'https://stripe.com/jobs', title: 'dup' },
      ] },
      { type: 'text', text: 'Proposing what the email settles.' },
      { type: 'tool_use', id: 't1', name: 'propose_rounds', input: { rounds: [ROUND] } },
    ] as never);
    expect(reply.prose).toBe('The 90-minute round is unsettled.\n\nProposing what the email settles.');
    expect(reply.searched).toEqual({ queries: 1, urls: ['https://stripe.com/jobs'] });
    expect(reply.proposal?.drafts).toHaveLength(1);
  });

  it('a server-tool ERROR result (object content) does not crash the gate', () => {
    const reply = gatePlannerTurn([
      { type: 'text', text: 'Search failed; proceeding from your material.' },
      { type: 'web_search_tool_result', tool_use_id: 's1', content: { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' } },
    ] as never);
    expect(reply.searched.urls).toEqual([]);
    expect(reply.proposal).toBeNull();
  });
});

describe('conversation store', () => {
  it('round-trips turns and tolerates a torn tail line', () => {
    const root = scratch();
    saveTarget(root, target());
    const turn: PlannerTurn = { role: 'user', at: '2026-08-06T00:00:00Z', content: [{ type: 'text', text: 'hi' }] };
    appendTurns(root, 'stripe-x1', [turn]);
    appendFileSync(conversationPath(root, 'stripe-x1'), '{"role":"assistant","at":"2026-'); // crash mid-append
    const loaded = loadConversation(root, 'stripe-x1');
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.content[0]?.text).toBe('hi');
  });
});

describe('renderConversation', () => {
  it('drops tool_result ack turns, keeps prose/proposal/search, surfaces attachments', () => {
    const turns: PlannerTurn[] = [
      { role: 'user', at: 't0', content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aa' } },
        { type: 'text', text: 'kickoff' },
      ] },
      { role: 'assistant', at: 't1', content: [
        { type: 'text', text: 'One question.' },
        { type: 'tool_use', id: 'x', name: 'propose_rounds', input: { rounds: [ROUND] } },
      ] },
      { role: 'user', at: 't2', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'Recorded' }] },
    ];
    const rendered = renderConversation(turns);
    expect(rendered).toHaveLength(2);
    expect(rendered[0]?.attachments).toHaveLength(1);
    expect(rendered[1]?.proposal?.drafts).toHaveLength(1);
    expect(latestProposal(turns)?.drafts[0]?.spec.id).toBe('stripe-debugging');
  });
});

describe('renderPlannerSplit', () => {
  it('splits at the marker and interpolates the kickoff', () => {
    const { system, kickoff } = renderPlannerSplit(
      path.join(__dirname, '..', '..', 'prompts', 'planner.md'),
      target({ interview_date: '2026-09-04', context: 'recruiter email text' }),
    );
    expect(system).toContain('Evidence hierarchy');
    expect(system).not.toContain('{{DESCRIPTION}}');
    expect(kickoff).toContain('Stripe backend loop');
    expect(kickoff).toContain('loop ends 2026-09-04');
    expect(kickoff).toContain('recruiter email text');
  });
});

describe('runPlannerTurn (fake model)', () => {
  const propose = (id: string) => ({
    type: 'tool_use', id: 'tu1', name: 'propose_rounds', input: { rounds: [{ ...ROUND, id }] },
  });

  it('kickoff turn: attachments + interpolated intake reach the model; propose gets a tool_result ack', async () => {
    const root = scratch();
    const t = target({ attachments: [{ name: 'preview.png', media_type: 'image/png', file: 'attachments/1-preview.png' }] });
    saveTarget(root, t);
    const adir = path.join(root, 'targets', t.id, 'attachments');
    mkdirSync(adir, { recursive: true });
    writeFileSync(path.join(adir, '1-preview.png'), Buffer.from([1, 2, 3]));

    const seen: unknown[] = [];
    const model: PlannerModel = async (params) => {
      seen.push(params);
      return {
        content: [{ type: 'text', text: 'The email settles it.' }, propose('r1')] as never,
        stop_reason: 'tool_use',
      };
    };
    const result = await runPlannerTurn({
      root, target: t,
      templatePath: path.join(__dirname, '..', '..', 'prompts', 'planner.md'),
      model,
    });
    expect(result.reply.proposal?.drafts[0]?.spec.id).toBe('r1');

    const sent = (seen[0] as { messages: { role: string; content: Record<string, unknown>[] }[] }).messages;
    expect(sent[0]?.content[0]?.type).toBe('image');
    expect(String(sent[0]?.content[1]?.text)).toContain('Stripe backend loop');

    // Persisted: kickoff user turn, assistant turn, tool_result ack.
    const stored = loadConversation(root, t.id);
    expect(stored.map((x) => x.role)).toEqual(['user', 'assistant', 'user']);
    expect(stored[2]?.content[0]?.type).toBe('tool_result');
  });

  it('pause_turn resumes with the partial content appended', async () => {
    const root = scratch();
    const t = target();
    saveTarget(root, t);
    let calls = 0;
    const model: PlannerModel = async (params) => {
      calls++;
      if (calls === 1) {
        return { content: [{ type: 'server_tool_use', id: 's', name: 'web_search', input: {} }] as never, stop_reason: 'pause_turn' };
      }
      // The resumed request must carry the paused assistant turn.
      const last = params.messages[params.messages.length - 1] as { role: string };
      expect(last.role).toBe('assistant');
      return { content: [{ type: 'text', text: 'done' }] as never, stop_reason: 'end_turn' };
    };
    const result = await runPlannerTurn({
      root, target: t,
      templatePath: path.join(__dirname, '..', '..', 'prompts', 'planner.md'),
      model,
    });
    expect(calls).toBe(2);
    expect(result.reply.prose).toBe('done');
    // Both the paused fragment and the final turn persist for legal replay.
    expect(loadConversation(root, t.id).map((x) => x.role)).toEqual(['user', 'assistant', 'assistant']);
  });

  it('a gate failure persists NOTHING (idempotent retry)', async () => {
    const root = scratch();
    const t = target();
    saveTarget(root, t);
    const model: PlannerModel = async () => ({
      content: [{ type: 'tool_use', id: 'x', name: 'propose_rounds', input: { rounds: [] } }] as never,
      stop_reason: 'tool_use',
    });
    await expect(
      runPlannerTurn({ root, target: t, templatePath: path.join(__dirname, '..', '..', 'prompts', 'planner.md'), model }),
    ).rejects.toThrow(/without rounds/);
    expect(loadConversation(root, t.id)).toEqual([]);
  });

  it('a follow-up message continues the persisted conversation', async () => {
    const root = scratch();
    const t = target();
    saveTarget(root, t);
    appendTurns(root, t.id, [
      { role: 'user', at: 't0', content: [{ type: 'text', text: 'kickoff' }] },
      { role: 'assistant', at: 't1', content: [{ type: 'text', text: 'reply' }] },
    ]);
    const model: PlannerModel = async (params) => {
      expect(params.messages).toHaveLength(3);
      return { content: [{ type: 'text', text: 'noted' }] as never, stop_reason: 'end_turn' };
    };
    const result = await runPlannerTurn({
      root, target: t, userMessage: 'the OA moved to the 18th',
      templatePath: path.join(__dirname, '..', '..', 'prompts', 'planner.md'),
      model,
    });
    expect(result.reply.prose).toBe('noted');
    expect(loadConversation(root, t.id)).toHaveLength(4);
  });
});
