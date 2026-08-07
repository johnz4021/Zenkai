/**
 * The planner — a CONVERSATION, not a form.
 *
 *   intake (form = first message) ──► planner turn ──► prose + proposal
 *          candidate replies, corrects, answers ──► revised proposal
 *                                     │
 *                     /api/accept-spec (unchanged confirm gate)
 *
 * Three disciplines carried over from the rest of the codebase:
 *   - Every model output passes a pure, exported gate (gatePlannerTurn)
 *     before anything else sees it; drafts pass the SAME vocabulary gate as
 *     single-shot inference (draftToSpec → validateRoundSpec).
 *   - The conversation is append-only JSONL on disk (TraceStore's rules:
 *     sole writer, replay tolerates a torn tail line). Killing the app never
 *     loses a conversation, and an abandoned intake becomes RESUMABLE
 *     instead of the orphan rows that litter targets/ today.
 *   - The model function is injectable (judge.ts precedent) — tests never
 *     call the API.
 *
 * Research happens INSIDE the turn via server-side web_search/web_fetch.
 * Glassdoor is blocked mechanically (blocked_domains), not by prompt prose:
 * the deleted research.ts banned it in a comment the model could drift
 * from; a request-level block cannot drift. Evidence hierarchy (firsthand >
 * secondhand > public > priors) lives in prompts/planner.md.
 *
 * Requires ANTHROPIC_API_KEY: server tools and typed content blocks do not
 * exist on the claude -p path. Without a key the client shows a notice —
 * conversational planning has no degraded mode (design D1, 2026-08-07).
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { attachmentBlocks, draftToSpec, targetDir, type DraftToolOutput, type SpecDraft, type Target } from './intake.js';
import { ROUND_FIELDS, coerceArray } from './clarify.js';

// ---- conversation store (targets/<id>/conversation.jsonl) ----

export interface PlannerTurn {
  role: 'user' | 'assistant';
  at: string;
  /** Verbatim API content blocks. Assistant turns keep tool_use /
   *  server_tool_use / thinking blocks intact — the API requires unmodified
   *  replay, and the stored form IS the replay form. */
  content: Record<string, unknown>[];
  /** What the CANDIDATE should see for this turn, when it differs from the
   *  model-facing content. The kickoff turn is the interpolated prompt
   *  template (fences, headers, "(none)" placeholders) — rendering that
   *  verbatim put prompt plumbing on the user's own screen. */
  display?: string;
}

export function conversationPath(root: string, targetId: string): string {
  return path.join(targetDir(root, targetId), 'conversation.jsonl');
}

export function loadConversation(root: string, targetId: string): PlannerTurn[] {
  const file = conversationPath(root, targetId);
  if (!existsSync(file)) return [];
  const turns: PlannerTurn[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      turns.push(JSON.parse(line) as PlannerTurn);
    } catch {
      // Torn tail from a crash mid-append: the turn is lost, the
      // conversation is not (trace-store.ts rule).
    }
  }
  return turns;
}

export function appendTurns(root: string, targetId: string, turns: PlannerTurn[]): void {
  mkdirSync(targetDir(root, targetId), { recursive: true });
  appendFileSync(
    conversationPath(root, targetId),
    turns.map((t) => JSON.stringify(t)).join('\n') + '\n',
  );
}

// ---- research source policy ----

/** Login-walled / TOS-hostile sources, blocked at the REQUEST level. A
 *  blocklist (not an allowlist) because the most valuable public sources —
 *  each company's own careers and engineering pages — cannot be enumerated
 *  in advance. Guidance toward official sources lives in the prompt; the
 *  hard "never" lives here. */
export const BLOCKED_SOURCE_DOMAINS = ['glassdoor.com'];

// ---- the propose_rounds tool ----

const PROPOSE_TOOL = {
  name: 'propose_rounds',
  description:
    'Propose or revise the round shapes for this loop. Call whenever your best understanding changes; the candidate confirms in a gate before anything is generated.',
  input_schema: {
    type: 'object' as const,
    properties: {
      rounds: {
        type: 'array',
        description: 'One entry PER DISTINCT ROUND. At least 1 once any coherent shape exists.',
        items: {
          type: 'object',
          properties: ROUND_FIELDS,
          required: ['id', 'label', 'interviewer', 'can_run_tests', 'time_limit_minutes', 'starts_from', 'submit', 'check_kind', 'rationale', 'unsupported'],
        },
      },
      pace_per_week: {
        type: 'number',
        description:
          'Practice rounds per week, 1-7, derived from the candidate\'s answer to the daily-time question. Omit until they have answered.',
      },
      summary: {
        type: 'string',
        description: 'Settled facts of the loop, written for the generation blueprints. Include once the shape is settled; omit while things are still moving.',
      },
    },
    required: ['rounds'],
  },
};

// ---- pure gate over one assistant turn ----

export interface PlannerProposal {
  drafts: SpecDraft[];
  /** Practice rounds/week from the time-budget conversation; sizes the queue. */
  pace_per_week?: number;
  summary?: string;
}

export interface PlannerReply {
  /** Concatenated text blocks — what the candidate reads. Questions,
   *  retrieval reports, and conflicts all live HERE as prose (Cowork
   *  grammar, design D1 2026-08-07): the chat has no widgets. */
  prose: string;
  /** The gated proposal, when the model called propose_rounds this turn. */
  proposal: PlannerProposal | null;
}

function text(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/** Gate the propose_rounds input. Same leniency as gateClarify: one
 *  incoherent draft is dropped with a warning, it does not sink coherent
 *  siblings; ALL drafts failing throws. */
export function gateProposal(raw: unknown): PlannerProposal {
  const o = raw as Record<string, unknown>;
  const rounds = coerceArray(o.rounds ?? []);
  if (rounds.length === 0) throw new Error('planner: proposal without rounds');
  if (rounds.length > 6) throw new Error(`planner: ${rounds.length} rounds (max 6)`);
  const drafts: SpecDraft[] = [];
  const dropped: string[] = [];
  for (const r of rounds) {
    try {
      drafts.push(draftToSpec(r as DraftToolOutput));
    } catch (e) {
      dropped.push(String(e).slice(0, 120));
    }
  }
  if (drafts.length === 0) throw new Error(`planner: every draft failed the gate: ${dropped.join(' | ')}`);
  if (dropped.length > 0) console.warn(`[planner] dropped ${dropped.length} incoherent draft(s): ${dropped.join(' | ')}`);
  const ids = new Set(drafts.map((d) => d.spec.id));
  if (ids.size !== drafts.length) throw new Error('planner: duplicate round ids');

  const paceRaw = Number(o.pace_per_week);
  const pace = Number.isFinite(paceRaw) ? Math.min(7, Math.max(1, Math.round(paceRaw))) : undefined;

  const summary = text(o.summary);
  return { drafts, ...(pace !== undefined ? { pace_per_week: pace } : {}), ...(summary ? { summary } : {}) };
}

/** One assistant turn's content blocks → what the candidate sees. Pure.
 *  Server-tool blocks (search/fetch results) are skipped silently — the
 *  model reports retrieval in prose with inline links; the chat renders no
 *  trace widget. */
export function gatePlannerTurn(content: Record<string, unknown>[]): PlannerReply {
  let prose = '';
  let proposal: PlannerProposal | null = null;
  for (const block of content) {
    if (block.type === 'text' && typeof block.text === 'string') {
      prose += (prose ? '\n\n' : '') + block.text.trim();
    } else if (block.type === 'tool_use' && block.name === PROPOSE_TOOL.name) {
      proposal = gateProposal(block.input);
    }
  }
  return { prose, proposal };
}

// ---- turn rendering for the client (replay + live) ----

export interface RenderedTurn {
  role: 'user' | 'assistant';
  at: string;
  prose: string;
  proposal?: PlannerProposal;
  /** Names of binary attachments carried by this turn (kickoff only). */
  attachments?: string[];
}

/** Legacy kickoff turns (stored before `display` existed) carry the raw
 *  prompt template. Strip its scaffolding — fences, section headers, empty
 *  placeholders — so old conversations render like new ones. */
export function stripKickoffScaffolding(text: string): string {
  return text
    .replace(/^<<<CANDIDATE_MATERIAL$/gm, '')
    .replace(/^CANDIDATE_MATERIAL>>>$/gm, '')
    .replace(/^I'm preparing for: .*$/m, '')
    .replace(/^Reference material I collected.*$/m, '')
    .replace(/^\(none\)$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Conversation → display shape. Tool plumbing (tool_result acks) and
 *  empty-prose turns are dropped; the LATEST proposal wins (the gate shows
 *  one current proposal, not a history of superseded ones — the client
 *  takes the last rendered turn that carries one). */
export function renderConversation(turns: PlannerTurn[]): RenderedTurn[] {
  const out: RenderedTurn[] = [];
  for (const t of turns) {
    if (t.role === 'user') {
      const prose = t.display ?? stripKickoffScaffolding(
        t.content
          .filter((b) => b.type === 'text' && typeof b.text === 'string')
          .map((b) => String(b.text))
          .join('\n\n'),
      );
      const attachments = t.content
        .filter((b) => b.type === 'image' || b.type === 'document')
        .map((b, i) => String((b as { title?: unknown }).title ?? `image ${i + 1}`));
      if (!prose && attachments.length === 0) continue; // tool_result ack turns
      out.push({ role: 'user', at: t.at, prose, ...(attachments.length ? { attachments } : {}) });
    } else {
      let reply: PlannerReply;
      try {
        reply = gatePlannerTurn(t.content);
      } catch {
        continue; // a turn whose stored proposal no longer gates renders as nothing
      }
      if (!reply.prose && !reply.proposal) continue;
      out.push({
        role: 'assistant',
        at: t.at,
        prose: reply.prose,
        ...(reply.proposal ? { proposal: reply.proposal } : {}),
      });
    }
  }
  return out;
}

// ---- the turn loop ----

const KICKOFF_MARKER = '<<<KICKOFF>>>';

export function renderPlannerSplit(
  templatePath: string,
  target: Target,
): { system: string; kickoff: string } {
  // The leading HTML comment documents the template for humans; the model
  // never needs it (and the placeholder names inside it must not reach the
  // system prompt).
  const raw = readFileSync(templatePath, 'utf8').replace(/^<!--[\s\S]*?-->\s*/, '');
  const idx = raw.indexOf(KICKOFF_MARKER);
  if (idx === -1) throw new Error('planner.md is missing the KICKOFF marker');
  const system = raw.slice(0, idx).trim();
  const kickoff = raw
    .slice(idx + KICKOFF_MARKER.length)
    .replace(/\{\{LABEL\}\}/g, target.label)
    .replace(/\{\{DATE\}\}/g, target.interview_date ? ` (loop ends ${target.interview_date})` : '')
    .replace(/\{\{DESCRIPTION\}\}/g, target.description || '(no description yet)')
    .replace(/\{\{CONTEXT\}\}/g, target.context || '(none)')
    .trim();
  return { system, kickoff };
}

/** Injectable model call — one API request. Tests fake this. */
export type PlannerModel = (params: {
  system: Record<string, unknown>[];
  messages: { role: string; content: unknown }[];
  tools: Record<string, unknown>[];
}) => Promise<{ content: Record<string, unknown>[]; stop_reason: string | null }>;

export function apiPlannerModel(model = 'claude-opus-5'): PlannerModel {
  return async (params) => {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    // Research turns run long (opus + web search); never the SDK's silent
    // 10-minute default (interviewer.ts rule).
    const client = new Anthropic({ timeout: 180_000, maxRetries: 1 });
    const msg = await client.messages.create({
      model,
      max_tokens: 8_000,
      system: params.system as never,
      messages: params.messages as never,
      tools: params.tools as never,
    });
    return {
      content: msg.content as unknown as Record<string, unknown>[],
      stop_reason: msg.stop_reason,
    };
  };
}

export interface PlannerTurnResult {
  reply: PlannerReply;
  /** Rendered tail (this turn's user + assistant), for the client. */
  turns: RenderedTurn[];
}

export async function runPlannerTurn(opts: {
  root: string;
  target: Target;
  templatePath: string;
  userMessage?: string;
  model?: PlannerModel;
}): Promise<PlannerTurnResult> {
  const { root, target, templatePath } = opts;
  const model = opts.model ?? apiPlannerModel();
  const { system, kickoff } = renderPlannerSplit(templatePath, target);

  const persisted = loadConversation(root, target.id);
  const pending: PlannerTurn[] = [];

  if (persisted.length === 0) {
    // Kickoff: attachments first (stable prefix, and the model reads them
    // before the words about them), then the interpolated intake. The
    // candidate sees their own words (display), never the template.
    pending.push({
      role: 'user',
      at: new Date().toISOString(),
      content: [
        ...attachmentBlocks(root, target),
        { type: 'text', text: kickoff },
      ],
      display: target.description || target.label,
    });
  } else if (opts.userMessage?.trim()) {
    pending.push({
      role: 'user',
      at: new Date().toISOString(),
      content: [{ type: 'text', text: opts.userMessage.trim() }],
    });
  } else {
    throw new Error('planner: nothing to say (no message and the conversation already started)');
  }

  const systemBlocks: Record<string, unknown>[] = [
    { type: 'text', text: system, cache_control: { type: 'ephemeral' } },
  ];
  const tools: Record<string, unknown>[] = [
    { type: 'web_search_20260209', name: 'web_search', max_uses: 5, blocked_domains: BLOCKED_SOURCE_DOMAINS },
    { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 3, blocked_domains: BLOCKED_SOURCE_DOMAINS },
    PROPOSE_TOOL,
  ];

  // Cache breakpoint on the tail of the persisted history: each turn re-reads
  // the (attachment-heavy) prefix at cache-read prices instead of full price.
  const history = persisted.map((t, i) => {
    if (i !== persisted.length - 1 || t.content.length === 0) {
      return { role: t.role, content: t.content };
    }
    const content = t.content.slice(0, -1);
    const last = { ...t.content[t.content.length - 1], cache_control: { type: 'ephemeral' } };
    return { role: t.role, content: [...content, last] };
  });

  // The loop: pause_turn resumes server tools; a propose_rounds call gets
  // its tool_result ack and ends the turn (the proposal IS the payload).
  let replyContent: Record<string, unknown>[] = [];
  for (let i = 0; i < 5; i++) {
    const msg = await model({
      system: systemBlocks,
      messages: [
        ...history,
        ...pending.map((t) => ({ role: t.role, content: t.content })),
      ],
      tools,
    });
    if (msg.stop_reason === 'pause_turn') {
      // Server tool hit its iteration limit mid-thought; append and resume.
      pending.push({ role: 'assistant', at: new Date().toISOString(), content: msg.content });
      continue;
    }
    replyContent = msg.content;
    pending.push({ role: 'assistant', at: new Date().toISOString(), content: msg.content });
    const propose = msg.content.find((b) => b.type === 'tool_use' && b.name === PROPOSE_TOOL.name);
    if (propose && msg.stop_reason === 'tool_use') {
      // Ack the client tool so the stored conversation replays legally; the
      // turn is over — the candidate reads the proposal, not a follow-up.
      pending.push({
        role: 'user',
        at: new Date().toISOString(),
        content: [{
          type: 'tool_result',
          tool_use_id: String((propose as { id?: unknown }).id ?? ''),
          content: 'Recorded — the candidate now sees this proposal in the confirm gate.',
        }],
      });
    }
    break;
  }
  if (replyContent.length === 0) {
    throw new Error('planner: the turn never completed (pause_turn limit exceeded)');
  }

  // Gate BEFORE persisting: a turn that fails the gate is a model failure
  // the caller retries; nothing half-broken lands on disk.
  const reply = gatePlannerTurn(replyContent);
  appendTurns(root, target.id, pending);
  return { reply, turns: renderConversation(pending) };
}

/** Settled-facts summary written at accept time; the blueprint drafter
 *  appends it to {{CONTEXT}}. Empty when planning went through the classic
 *  wizard (no conversation, no summary). */
export function plannerSummary(root: string, targetId: string): string {
  try {
    return readFileSync(path.join(targetDir(root, targetId), 'planner-summary.md'), 'utf8').trim();
  } catch {
    return '';
  }
}

/** Latest proposal across the whole conversation — what the confirm gate
 *  shows on resume, and where accept-spec reads the summary from. */
export function latestProposal(turns: PlannerTurn[]): PlannerProposal | null {
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i]!;
    if (t.role !== 'assistant') continue;
    try {
      const reply = gatePlannerTurn(t.content);
      if (reply.proposal) return reply.proposal;
    } catch {
      /* superseded shape */
    }
  }
  return null;
}
