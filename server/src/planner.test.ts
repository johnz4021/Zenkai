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
  appendTurns, conversationPath, gatePlannerTurn, gateProposal, gateQuestion, latestProposal,
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

  it('duplicate ids throw; summary carries', () => {
    expect(() => gateProposal({ rounds: [ROUND, ROUND] })).toThrow(/duplicate/);
    const p = gateProposal({ rounds: [ROUND], summary: 'Two rounds, browser editor.' });
    expect(p.summary).toBe('Two rounds, browser editor.');
  });

  it('evidence_tier rides the round through the shared gate; a bad tier sinks only that draft', () => {
    const p = gateProposal({ rounds: [{ ...ROUND, evidence_tier: 'firsthand' }] });
    expect(p.drafts[0]?.spec.evidence_tier).toBe('firsthand');
    const mixed = gateProposal({
      rounds: [{ ...ROUND, evidence_tier: 'gospel' }, { ...ROUND, id: 'r2', label: 'R2', evidence_tier: 'secondhand' }],
    });
    expect(mixed.drafts).toHaveLength(1);
    expect(mixed.drafts[0]?.spec.evidence_tier).toBe('secondhand');
  });

  it('pace_per_week clamps to 1-7 and rounds; garbage is dropped', () => {
    expect(gateProposal({ rounds: [ROUND], pace_per_week: 4 }).pace_per_week).toBe(4);
    expect(gateProposal({ rounds: [ROUND], pace_per_week: 12 }).pace_per_week).toBe(7);
    expect(gateProposal({ rounds: [ROUND], pace_per_week: 0.2 }).pace_per_week).toBe(1);
    expect(gateProposal({ rounds: [ROUND], pace_per_week: 'daily' }).pace_per_week).toBeUndefined();
  });
});

describe('gatePlannerTurn', () => {
  it('concatenates prose, skips server-tool blocks silently, extracts the proposal', () => {
    const reply = gatePlannerTurn([
      { type: 'text', text: 'The 90-minute round is unsettled.' },
      { type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'stripe practical round' } },
      { type: 'web_search_tool_result', tool_use_id: 's1', content: [
        { type: 'web_search_result', url: 'https://stripe.com/jobs', title: 'Jobs' },
      ] },
      { type: 'text', text: 'Proposing what the email settles.' },
      { type: 'tool_use', id: 't1', name: 'propose_rounds', input: { rounds: [ROUND] } },
    ] as never);
    expect(reply.prose).toBe('The 90-minute round is unsettled.\n\nProposing what the email settles.');
    expect(reply.prose).not.toContain('stripe.com/jobs'); // retrieval reads as prose links the MODEL writes, never a widget
    expect(reply.proposal?.drafts).toHaveLength(1);
  });

  it('a server-tool ERROR result (object content) does not crash the gate', () => {
    const reply = gatePlannerTurn([
      { type: 'text', text: 'Search failed; proceeding from your material.' },
      { type: 'web_search_tool_result', tool_use_id: 's1', content: { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' } },
    ] as never);
    expect(reply.prose).toContain('Search failed');
    expect(reply.proposal).toBeNull();
  });
});

describe('gateQuestion — the ask_user option picker', () => {
  const Q = { question: 'Which language?', options: [{ label: 'Python' }, { label: 'Java', detail: 'matches the stubs' }], recommended: 'Python' };

  it('gates a well-formed question, keeping details and the recommendation', () => {
    const q = gateQuestion(Q);
    expect(q.options).toHaveLength(2);
    expect(q.options[1]?.detail).toBe('matches the stubs');
    expect(q.recommended).toBe('Python');
  });

  it('options out of 2-4 throw; an empty question throws', () => {
    expect(() => gateQuestion({ ...Q, options: [{ label: 'only' }] })).toThrow(/2-4 options/);
    expect(() => gateQuestion({ ...Q, options: Array.from({ length: 5 }, (_, i) => ({ label: 'o' + i })) })).toThrow(/2-4 options/);
    expect(() => gateQuestion({ ...Q, question: '' })).toThrow(/without a question/);
  });

  it('a recommendation naming no real option is dropped, not fatal', () => {
    expect(gateQuestion({ ...Q, recommended: 'Rust' }).recommended).toBeUndefined();
  });

  it('rides an assistant turn next to prose; more than 2 per turn throws', () => {
    const ask = (id: string) => ({ type: 'tool_use', id, name: 'ask_user', input: Q });
    const reply = gatePlannerTurn([{ type: 'text', text: 'Two things.' }, ask('a')] as never);
    expect(reply.questions).toHaveLength(1);
    expect(reply.questions[0]?.question).toBe('Which language?');
    expect(() => gatePlannerTurn([ask('a'), ask('b'), ask('c')] as never)).toThrow(/max 2/);
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

  it('an ask_user call is acked and rendered with tappable options', async () => {
    const root = scratch();
    const t = target();
    saveTarget(root, t);
    let calls = 0;
    const model: PlannerModel = async () => {
      calls++;
      if (calls === 1) {
        return {
          content: [
            { type: 'text', text: 'Which language will the rounds be in?' },
            { type: 'tool_use', id: 'ask1', name: 'ask_user', input: { question: 'Which language?', options: [{ label: 'Python' }, { label: 'Java' }], recommended: 'Python' } },
          ] as never,
          stop_reason: 'tool_use',
        };
      }
      // The continuation after the ack: the model narrates, turn ends.
      return { content: [{ type: 'text', text: 'Tap one, or type.' }] as never, stop_reason: 'end_turn' };
    };
    const result = await runPlannerTurn({
      root, target: t,
      templatePath: path.join(__dirname, '..', '..', 'prompts', 'planner.md'),
      model,
    });
    expect(calls).toBe(2);
    expect(result.reply.questions[0]?.options.map((o) => o.label)).toEqual(['Python', 'Java']);
    // The ask turn keeps its options in the render even though the
    // narration bubble follows it (the client keeps them live until a
    // user message answers them).
    const askTurn = result.turns.find((x) => x.questions);
    expect(askTurn?.questions?.[0]?.recommended).toBe('Python');
    // The ack persists so the stored conversation replays legally.
    const stored = loadConversation(root, t.id);
    expect(stored.map((x) => x.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(stored[2]?.content[0]?.type).toBe('tool_result');
    expect(String(stored[2]?.content[0]?.content)).toContain('tappable');
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
      if (seen.length === 1) {
        return {
          content: [{ type: 'text', text: 'The email settles it.' }, propose('r1')] as never,
          stop_reason: 'tool_use',
        };
      }
      return { content: [{ type: 'text', text: 'The proposal is on the panel.' }] as never, stop_reason: 'end_turn' };
    };
    const result = await runPlannerTurn({
      root, target: t,
      templatePath: path.join(__dirname, '..', '..', 'prompts', 'planner.md'),
      model,
    });
    expect(result.reply.proposal?.drafts[0]?.spec.id).toBe('r1');
    // The gate sees the WHOLE turn: proposal from the first message, prose
    // from both.
    expect(result.reply.prose).toContain('The email settles it.');
    expect(result.reply.prose).toContain('on the panel');

    const sent = (seen[0] as { messages: { role: string; content: Record<string, unknown>[] }[] }).messages;
    expect(sent[0]?.content[0]?.type).toBe('image');
    expect(String(sent[0]?.content[1]?.text)).toContain('Stripe backend loop');

    // Persisted: kickoff, assistant (tool), ack, assistant (narration).
    const stored = loadConversation(root, t.id);
    expect(stored.map((x) => x.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
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

  it('threads the code-execution container id across a resumed turn', async () => {
    // The 2026-02-09 server tools run in a container; resuming a turn with
    // a pending server tool use 400s without the id (live failure, 2026-08-08).
    const root = scratch();
    const t = target();
    saveTarget(root, t);
    const seen: (string | undefined)[] = [];
    let calls = 0;
    const model: PlannerModel = async (params) => {
      seen.push(params.container);
      calls++;
      if (calls === 1) {
        return {
          content: [{ type: 'server_tool_use', id: 's1', name: 'web_fetch', input: {} }] as never,
          stop_reason: 'pause_turn',
          container: 'ctr_abc123',
        };
      }
      return { content: [{ type: 'text', text: 'done' }] as never, stop_reason: 'end_turn', container: 'ctr_abc123' };
    };
    await runPlannerTurn({ root, target: t, templatePath: path.join(__dirname, '..', '..', 'prompts', 'planner.md'), model });
    expect(seen).toEqual([undefined, 'ctr_abc123']);
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

describe('kickoff rendering — prompt plumbing never reaches the candidate', () => {
  it('a kickoff turn with display renders the candidate words, not the template', () => {
    const turns: PlannerTurn[] = [{
      role: 'user', at: 't0', display: 'Palantir learning round, async debugging',
      content: [{ type: 'text', text: "I'm preparing for: Palantir\n\n<<<CANDIDATE_MATERIAL\nstuff\nCANDIDATE_MATERIAL>>>" }],
    }];
    const r = renderConversation(turns);
    expect(r[0]?.prose).toBe('Palantir learning round, async debugging');
    expect(r[0]?.prose).not.toContain('CANDIDATE_MATERIAL');
  });

  it('a LEGACY kickoff (no display) gets its scaffolding stripped', () => {
    const raw = "I'm preparing for: Palantir (loop ends 2026-08-07)\n\n<<<CANDIDATE_MATERIAL\nlearning round, futures in python\nCANDIDATE_MATERIAL>>>\n\nReference material I collected (also see any attached images/PDFs above):\n\n<<<CANDIDATE_MATERIAL\n(none)\nCANDIDATE_MATERIAL>>>";
    const turns: PlannerTurn[] = [{ role: 'user', at: 't0', content: [{ type: 'text', text: raw }] }];
    const r = renderConversation(turns);
    expect(r[0]?.prose).toBe('learning round, futures in python');
  });
});
