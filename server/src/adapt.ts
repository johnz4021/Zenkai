/**
 * Plan adaptation — "add what you learned" (CEO review 2026-08-02).
 *
 * The step the manual workflow always had and the product never did: new
 * information (an invite email, OA problem titles, a friend's message)
 * arrives mid-season and the REMAINING plan re-shapes around it. This
 * replaced preemptive research, which retrieved base rates and got them
 * confidently wrong; adaptation only interprets material the candidate
 * supplies — the mode behind every win this product has actually had.
 *
 *   material ──► adapter (one call) ──► gateAdapt ──► planAdaptation
 *                                                          │ AdaptDiff
 *                                                          ▼
 *                                            candidate approves the diff   ◄── ALWAYS
 *                                                          │
 *                                                          ▼
 *                                     applyAdaptation ──► target.json, then queue.json
 *
 * Rules the shape enforces (review decisions D2/D3/D5/D6):
 *   - Preview writes NOTHING; only an approved diff is applied. No model
 *     output reaches the plan ungated — same discipline as every other
 *     writer in this codebase.
 *   - Specs are APPEND-ONLY. Adapting never edits or removes a RoundSpec;
 *     a new shape supersedes an old one only for future items. History
 *     (done rounds, their assessments) keeps pointing at the exact spec it
 *     ran under.
 *   - `pending`/`failed` items re-point freely; `ready` items are flagged
 *     stale and offered a rebuild — never mutated; `done`/`generating`/
 *     `skipped` are untouchable.
 *   - Every applied adapt appends an AdaptRecord: it explains the change
 *     on the timeline, and it lets reconcileAdaptation repair a half-
 *     applied write after a crash.
 */

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { RoundSpec } from '@interview-prep/shared';
import { coerceArray, ROUND_FIELDS } from './clarify.js';
import { draftToSpec, type DraftToolOutput, type SpecDraft, type Target } from './intake.js';
import type { Queue, QueueItem } from './queue.js';

export interface AdaptDraft extends SpecDraft {
  /** Existing spec id this round replaces for FUTURE items, or null when
   *  it is an additional round. The superseded spec itself is never
   *  edited or removed (append-only). */
  supersedes: string | null;
}

export interface AdaptDiff {
  /** Append-only: never contains an id already on the target. */
  new_specs: RoundSpec[];
  repointed: {
    item_id: string;
    from_spec_id: string;
    to_spec_id: string;
    new_label: string;
    old_title: string;
    /** Set by the topic namer at preview; absent = quiet row. */
    new_title?: string;
  }[];
  /** Ready items built under a superseded spec — offered a rebuild. */
  flagged: string[];
  /** Filled at apply time: re-points whose item moved on since preview. */
  skipped: { item_id: string; reason: string }[];
  /** One mechanical sentence for the log and the timeline line. */
  summary: string;
}

/** Target.adaptations[] entry — the audit trail and the recovery record. */
export interface AdaptRecord {
  at: string;
  material_excerpt: string;
  summary: string;
  new_spec_ids: string[];
  repointed: { item_id: string; from: string; to: string }[];
  flagged: string[];
  skipped: { item_id: string; reason: string }[];
}

const EXCERPT_MAX = 280;

/** Enough of the material to recognize the source later — never the whole
 *  message (it may be a real person's words; the plan is not an archive). */
export function excerptOf(material: string): string {
  return material.replace(/\s+/g, ' ').trim().slice(0, EXCERPT_MAX);
}

/**
 * Mechanical gate on the adapter's output, in the gateClarify style: each
 * round passes the same vocabulary gate as intake (draftToSpec), with
 * per-draft leniency — one incoherent draft never sinks its siblings.
 * Adapt-specific rules: `supersedes` must name a real existing spec (or
 * null), and a draft may not reuse an existing spec id — append-only means
 * a "changed" round arrives under a new id.
 */
export function gateAdapt(raw: unknown, existingSpecs: RoundSpec[]): AdaptDraft[] {
  const o = raw as { rounds?: unknown };
  const rounds = coerceArray(o.rounds ?? []);
  // Zero rounds is a VALID answer: "the material changes nothing". Forcing
  // a fake draft here would add a spec and churn the queue for a no-op.
  if (rounds.length === 0) return [];
  if (rounds.length > 4) throw new Error(`adapt: ${rounds.length} rounds (max 4)`);
  const existingIds = new Set(existingSpecs.map((s) => s.id));
  const drafts: AdaptDraft[] = [];
  const dropped: string[] = [];
  for (const r of rounds) {
    try {
      const x = r as DraftToolOutput & { supersedes?: unknown };
      const supersedes =
        typeof x.supersedes === 'string' && x.supersedes.trim() ? x.supersedes.trim() : null;
      if (supersedes !== null && !existingIds.has(supersedes)) {
        throw new Error(`adapt: supersedes unknown spec "${supersedes}"`);
      }
      const draft = draftToSpec(x);
      if (existingIds.has(draft.spec.id)) {
        throw new Error(
          `adapt: draft id "${draft.spec.id}" collides with an existing spec — specs are append-only, use a new id`,
        );
      }
      drafts.push({ ...draft, supersedes });
    } catch (e) {
      dropped.push(String(e).slice(0, 120));
    }
  }
  if (drafts.length === 0) throw new Error(`adapt: every draft failed the gate: ${dropped.join(' | ')}`);
  if (dropped.length > 0) console.warn(`[adapt] dropped ${dropped.length} incoherent draft(s): ${dropped.join(' | ')}`);
  const ids = new Set(drafts.map((d) => d.spec.id));
  if (ids.size !== drafts.length) throw new Error('adapt: duplicate round ids');
  return drafts;
}

const RESHAPEABLE = new Set<QueueItem['status']>(['pending', 'failed']);

/**
 * Mechanical diff: the active spec set is (existing specs not superseded)
 * + new specs, and re-shapeable items are re-assigned round-robin across
 * it — the same arithmetic as proposeQueue, so a plan adapted twice looks
 * like a plan built once with the final spec set. `failed` re-points like
 * pending (it has no validated problem to protect). Ready items under a
 * superseded spec are flagged, never moved. Pure; no I/O, no clock.
 */
export function planAdaptation(target: Target, queue: Queue, drafts: AdaptDraft[]): AdaptDiff {
  // No drafts → no diff. Never re-balance the queue as a side effect of a
  // no-op adapt: a "nothing changed" paste must change nothing.
  if (drafts.length === 0) {
    return { new_specs: [], repointed: [], flagged: [], skipped: [], summary: 'no changes — the plan already matches' };
  }
  const superseded = new Set(drafts.map((d) => d.supersedes).filter((s): s is string => s !== null));
  const activeSpecs = [
    ...target.specs.filter((s) => !superseded.has(s.id)),
    ...drafts.map((d) => d.spec),
  ];
  const repointed: AdaptDiff['repointed'] = [];
  const perSpecCount = new Map<string, number>();
  let slot = 0;
  for (const item of queue.items) {
    if (!RESHAPEABLE.has(item.status)) continue;
    const spec = activeSpecs[slot % activeSpecs.length]!;
    slot++;
    const n = (perSpecCount.get(spec.id) ?? 0) + 1;
    perSpecCount.set(spec.id, n);
    if (spec.id === item.spec_id) continue; // unchanged — not churn, not a diff row
    repointed.push({
      item_id: item.id,
      from_spec_id: item.spec_id,
      to_spec_id: spec.id,
      new_label: `${spec.label} — round ${n}`,
      old_title: item.planned_title ?? item.label,
    });
  }
  const flagged = queue.items
    .filter((i) => i.status === 'ready' && superseded.has(i.spec_id))
    .map((i) => i.id);
  const newLabels = drafts.map((d) => d.spec.label).join(', ');
  const parts = [
    drafts.length ? `new: ${newLabels}` : '',
    repointed.length ? `${repointed.length} upcoming round${repointed.length === 1 ? '' : 's'} re-shaped` : '',
    flagged.length ? `${flagged.length} built problem${flagged.length === 1 ? '' : 's'} flagged for rebuild` : '',
  ].filter(Boolean);
  return {
    new_specs: drafts.map((d) => d.spec),
    repointed,
    flagged,
    skipped: [],
    summary: parts.join(' · ') || 'no changes — the plan already matches',
  };
}

/**
 * Apply an APPROVED diff against a FRESHLY RE-LOADED queue. Returns new
 * objects; the caller writes target.json first (specs + record are the
 * commit marker), then queue.json. Any re-point whose item moved on since
 * the preview (e.g. the user hit generate meanwhile) is dropped and
 * recorded in `skipped` — never applied against a state it wasn't
 * computed for. Pure except for the injected `now`.
 */
export function applyAdaptation(
  target: Target,
  queue: Queue,
  diff: AdaptDiff,
  materialExcerpt: string,
  now: number,
): { target: Target; queue: Queue } {
  const nextTarget: Target = JSON.parse(JSON.stringify(target)) as Target;
  const nextQueue: Queue = JSON.parse(JSON.stringify(queue)) as Queue;
  const have = new Set(nextTarget.specs.map((s) => s.id));
  // Idempotent append — reconcileAdaptation may re-apply after a crash.
  for (const spec of diff.new_specs) {
    if (!have.has(spec.id)) nextTarget.specs.push(spec);
  }
  const applied: AdaptRecord['repointed'] = [];
  const skipped: AdaptDiff['skipped'] = [...diff.skipped];
  for (const r of diff.repointed) {
    const item = nextQueue.items.find((i) => i.id === r.item_id);
    if (!item || !RESHAPEABLE.has(item.status)) {
      skipped.push({ item_id: r.item_id, reason: item ? `now ${item.status}` : 'no longer exists' });
      continue;
    }
    item.spec_id = r.to_spec_id;
    item.label = r.new_label;
    // The old planned title promised the old shape; a stale promise is
    // worse than a quiet row.
    if (r.new_title) item.planned_title = r.new_title;
    else delete item.planned_title;
    applied.push({ item_id: r.item_id, from: r.from_spec_id, to: r.to_spec_id });
  }
  const flaggedApplied: string[] = [];
  for (const id of diff.flagged) {
    const item = nextQueue.items.find((i) => i.id === id);
    if (item && item.status === 'ready') {
      item.stale = true;
      flaggedApplied.push(id);
    } else {
      skipped.push({ item_id: id, reason: item ? `now ${item.status}` : 'no longer exists' });
    }
  }
  const record: AdaptRecord = {
    at: new Date(now).toISOString(),
    material_excerpt: excerptOf(materialExcerpt),
    summary: diff.summary,
    new_spec_ids: diff.new_specs.map((s) => s.id),
    repointed: applied,
    flagged: flaggedApplied,
    skipped,
  };
  nextTarget.adaptations = [...(nextTarget.adaptations ?? []), record];
  return { target: nextTarget, queue: nextQueue };
}

/**
 * Crash repair (D3): target.json (specs + record) is written before
 * queue.json, so a crash between the writes leaves a record claiming
 * re-points the queue doesn't show. Detect and re-apply from the record.
 * Only re-points are repaired — a lost stale flag is cosmetic and the
 * flag's spec context is gone by now, so re-flagging risks marking a
 * since-rebuilt item. Returns the repaired queue, or null when consistent.
 */
export function reconcileAdaptation(target: Target, queue: Queue): Queue | null {
  const record = target.adaptations?.[target.adaptations.length - 1];
  if (!record) return null;
  const specLabel = new Map(target.specs.map((s) => [s.id, s.label]));
  let repaired: Queue | null = null;
  for (const r of record.repointed) {
    const items = (repaired ?? queue).items;
    const item = items.find((i) => i.id === r.item_id);
    if (!item || item.spec_id !== r.from || !RESHAPEABLE.has(item.status)) continue;
    if (!specLabel.has(r.to)) continue; // record references a spec that never landed
    if (!repaired) repaired = JSON.parse(JSON.stringify(queue)) as Queue;
    const fresh = repaired.items.find((i) => i.id === r.item_id)!;
    fresh.spec_id = r.to;
    fresh.label = `${specLabel.get(r.to)}`;
    delete fresh.planned_title;
  }
  return repaired;
}

// ---- the adapter call (one reasoning call, mirroring clarify.ts) ----

export type Adapter = (input: { specs: RoundSpec[]; material: string }) => Promise<AdaptDraft[]>;

function specLine(s: RoundSpec): string {
  const c = s.capabilities;
  return `- id: ${s.id} · "${s.label}" · ${c.interviewer ? 'live interviewer' : 'no interviewer (OA)'} · ${
    c.time_limit_ms ? Math.round(c.time_limit_ms / 60_000) + ' min' : 'untimed'
  } · starts from ${c.starts_from} · ${c.submit}${s.emphasis ? ` · emphasis: ${s.emphasis}` : ''}`;
}

function buildPrompt(templatePath: string, input: Parameters<Adapter>[0]): string {
  return readFileSync(templatePath, 'utf8')
    .replace(/\{\{CURRENT_ROUNDS\}\}/g, input.specs.map(specLine).join('\n'))
    .replace(/\{\{MATERIAL\}\}/g, input.material);
}

const ADAPT_TOOL = {
  name: 'adapt_plan',
  description: 'Return the round shapes the new material implies.',
  input_schema: {
    type: 'object' as const,
    properties: {
      rounds: {
        type: 'array',
        description:
          'One entry PER DISTINCT ROUND the material implies. EMPTY is valid when the material changes nothing about the plan.',
        items: {
          type: 'object',
          properties: {
            ...ROUND_FIELDS,
            supersedes: {
              type: ['string', 'null'],
              description:
                'Existing spec id this round REPLACES for future practice, or null when it is an additional round.',
            },
          },
          required: [
            'id', 'label', 'interviewer', 'can_run_tests', 'time_limit_minutes',
            'starts_from', 'submit', 'check_kind', 'rationale', 'unsupported', 'supersedes',
          ],
        },
      },
    },
    required: ['rounds'],
  },
};

export function apiAdapter(templatePath: string, model = 'claude-sonnet-5'): Adapter {
  return async (input) => {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({ timeout: 90_000 });
    const msg = await client.messages.create({
      model,
      max_tokens: 3_000,
      messages: [{ role: 'user', content: buildPrompt(templatePath, input) }],
      tools: [ADAPT_TOOL],
      tool_choice: { type: 'tool', name: ADAPT_TOOL.name },
    });
    const call = msg.content.find(
      (b): b is Extract<typeof b, { type: 'tool_use' }> => b.type === 'tool_use',
    );
    if (!call) throw new Error('adapt: no tool call');
    return gateAdapt(call.input, input.specs);
  };
}

export function claudePAdapter(templatePath: string, model = 'sonnet'): Adapter {
  return (input) =>
    new Promise<AdaptDraft[]>((resolve, reject) => {
      const prompt =
        buildPrompt(templatePath, input) +
        '\n\nReply with ONLY a JSON object: {"rounds": [{id, label, interviewer, can_run_tests, time_limit_minutes, starts_from, submit, check_kind, emphasis, rationale, unsupported, supersedes}]}';
      const child = spawn('claude', ['-p', prompt, '--output-format', 'text', '--model', model], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      child.stdout.on('data', (d) => (stdout += d));
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error('adapt: timed out'));
      }, 150_000);
      child.on('close', () => {
        clearTimeout(timer);
        try {
          const match = stdout.match(/\{[\s\S]*\}/);
          if (!match) throw new Error('adapt: no JSON in output');
          resolve(gateAdapt(JSON.parse(match[0]), input.specs));
        } catch (e) {
          reject(e);
        }
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
}

export function pickAdapter(templatePath: string): Adapter {
  return process.env.ANTHROPIC_API_KEY ? apiAdapter(templatePath) : claudePAdapter(templatePath);
}
