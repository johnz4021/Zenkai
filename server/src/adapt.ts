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
import { gateBlueprint } from './blueprint.js';
import { draftToSpec, type DraftToolOutput, type SpecDraft, type Target } from './intake.js';
import type { Queue, QueueItem } from './queue.js';

export interface AdaptDraft extends SpecDraft {
  /** Existing spec id this round replaces for FUTURE items, or null when
   *  it is an additional round. The superseded spec itself is never
   *  edited or removed (append-only). */
  supersedes: string | null;
  /** The new round's complete blueprint markdown — a new exercise form
   *  arrives with its recipe, never as capabilities alone. */
  blueprint: string;
}

/** A refinement of an EXISTING spec's blueprint with no capability change —
 *  the common case: most learnings are recipe, not ruler. Specs stay
 *  append-only; blueprints are mutable-with-record (.prev.md + AdaptRecord). */
export interface BlueprintEdit {
  id: string;
  blueprint: string;
}

export interface AdaptOutcome {
  drafts: AdaptDraft[];
  blueprint_edits: BlueprintEdit[];
}

export interface AdaptDiff {
  /** Append-only: never contains an id already on the target. */
  new_specs: RoundSpec[];
  /** Spec ids this adapt retires for FUTURE items. Persisted into the
   *  record: retirement must outlive the adapt, or the next one
   *  resurrects a replaced round into the rotation (live bug, 2026-08-02:
   *  a second adapt re-pointed items back at the superseded live round). */
  superseded: string[];
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
  /** Blueprint files this adapt writes: new rounds' recipes and revisions
   *  of existing ones. Full markdown rides the diff because the client
   *  round-trips the approved diff verbatim to /api/adapt/apply. */
  blueprints: { spec_id: string; action: 'new' | 'revised'; markdown: string }[];
  /** One mechanical sentence for the log and the timeline line. */
  summary: string;
}

/** Target.adaptations[] entry — the audit trail and the recovery record. */
export interface AdaptRecord {
  at: string;
  material_excerpt: string;
  summary: string;
  new_spec_ids: string[];
  /** Retired-for-future spec ids — read by every LATER planAdaptation so
   *  supersession is permanent without ever editing the spec itself. */
  superseded?: string[];
  repointed: { item_id: string; from: string; to: string }[];
  flagged: string[];
  skipped: { item_id: string; reason: string }[];
  /** Spec ids whose blueprint file this adapt wrote. Optional: records
   *  from before blueprints existed keep parsing, and reconcileAdaptation
   *  ignores it by design. */
  blueprints_updated?: string[];
}

const EXCERPT_MAX = 280;

/** Specs retired by past adaptations — permanently out of the rotation,
 *  though still on the target for the history that ran under them. */
export function retiredSpecIds(target: Target): Set<string> {
  return new Set((target.adaptations ?? []).flatMap((r) => r.superseded ?? []));
}

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
export function gateAdapt(raw: unknown, existingSpecs: RoundSpec[], allSpecIds?: string[]): AdaptOutcome {
  const o = raw as { rounds?: unknown; blueprint_edits?: unknown };
  const rounds = coerceArray(o.rounds ?? []);
  if (rounds.length > 4) throw new Error(`adapt: ${rounds.length} rounds (max 4)`);
  // Two universes on purpose: `supersedes` must target an ACTIVE spec
  // (existingSpecs — what the model was shown), while id collisions are
  // checked against EVERY id that ever existed — a retired id can never
  // be reused, or its history would point at the wrong round.
  const existingIds = new Set(allSpecIds ?? existingSpecs.map((s) => s.id));
  const activeIds = new Set(existingSpecs.map((s) => s.id));
  const drafts: AdaptDraft[] = [];
  const dropped: string[] = [];
  for (const r of rounds) {
    try {
      const x = r as DraftToolOutput & { supersedes?: unknown; blueprint?: unknown };
      const supersedes =
        typeof x.supersedes === 'string' && x.supersedes.trim() ? x.supersedes.trim() : null;
      if (supersedes !== null && !activeIds.has(supersedes)) {
        throw new Error(`adapt: supersedes unknown spec "${supersedes}"`);
      }
      // A new exercise form arrives with its recipe — a draft without a
      // gate-passing blueprint is incoherent the same way a bad capability
      // is, and drops without sinking its siblings.
      const blueprint = gateBlueprint(x.blueprint);
      const draft = draftToSpec(x);
      if (existingIds.has(draft.spec.id)) {
        throw new Error(
          `adapt: draft id "${draft.spec.id}" collides with an existing spec — specs are append-only, use a new id`,
        );
      }
      drafts.push({ ...draft, supersedes, blueprint });
    } catch (e) {
      dropped.push(String(e).slice(0, 120));
    }
  }
  // Blueprint edits: recipe refinements to ACTIVE specs. Invalid entries
  // drop with a warn — an edit is never worth failing the whole adapt.
  const blueprint_edits: BlueprintEdit[] = [];
  for (const e of coerceArray(o.blueprint_edits ?? [])) {
    const x = e as { id?: unknown; blueprint?: unknown };
    try {
      const id = typeof x.id === 'string' ? x.id.trim() : '';
      if (!activeIds.has(id)) throw new Error(`edit targets unknown/retired spec "${id}"`);
      if (drafts.some((d) => d.supersedes === id)) {
        throw new Error(`edit targets "${id}" which this adapt also supersedes`);
      }
      blueprint_edits.push({ id, blueprint: gateBlueprint(x.blueprint) });
    } catch (err) {
      console.warn(`[adapt] dropped blueprint edit: ${String(err).slice(0, 120)}`);
    }
  }
  // Zero rounds AND zero edits is a VALID answer: "the material changes
  // nothing". But rounds that ALL failed the gate with no surviving edits
  // is model breakage, not a no-op — say so.
  if (rounds.length > 0 && drafts.length === 0 && blueprint_edits.length === 0) {
    throw new Error(`adapt: every draft failed the gate: ${dropped.join(' | ')}`);
  }
  if (dropped.length > 0) console.warn(`[adapt] dropped ${dropped.length} incoherent draft(s): ${dropped.join(' | ')}`);
  const ids = new Set(drafts.map((d) => d.spec.id));
  if (ids.size !== drafts.length) throw new Error('adapt: duplicate round ids');
  return { drafts, blueprint_edits };
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
export function planAdaptation(
  target: Target,
  queue: Queue,
  drafts: AdaptDraft[],
  blueprintEdits: BlueprintEdit[] = [],
): AdaptDiff {
  const editRows: AdaptDiff['blueprints'] = blueprintEdits.map((e) => ({
    spec_id: e.id,
    action: 'revised' as const,
    markdown: e.blueprint,
  }));
  // No drafts → the spec set is unchanged, so NOTHING re-points and the
  // round-robin must not run (a "nothing changed" paste must change
  // nothing; recipe-only edits change files, never the queue).
  if (drafts.length === 0) {
    return {
      new_specs: [], superseded: [], repointed: [], flagged: [], skipped: [],
      blueprints: editRows,
      summary: editRows.length
        ? `${editRows.length} blueprint${editRows.length === 1 ? '' : 's'} refined — rounds unchanged`
        : 'no changes — the plan already matches',
    };
  }
  const superseded = new Set(drafts.map((d) => d.supersedes).filter((s): s is string => s !== null));
  // Retirement is PERMANENT: specs superseded by any earlier adapt stay
  // out of the rotation, or adapt #2 quietly resurrects what adapt #1
  // replaced (this happened live — items round-robined back onto the old
  // live-interviewer round).
  const retired = new Set([
    ...(target.adaptations ?? []).flatMap((r) => r.superseded ?? []),
    ...superseded,
  ]);
  const activeSpecs = [
    ...target.specs.filter((s) => !retired.has(s.id)),
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
  // Ready items under a superseded spec get GENUINELY re-pointed to the
  // superseding round AND flagged stale. The old behavior (flag only) is
  // the pinned regression: the rebuild button regenerated the superseded
  // Palantir spec seven minutes after it was retired (2026-08-05), because
  // rebuild uses item.spec_id and nothing had changed it.
  const supersededBy = new Map(
    drafts.filter((d) => d.supersedes !== null).map((d) => [d.supersedes as string, d.spec]),
  );
  for (const item of queue.items) {
    if (item.status !== 'ready') continue;
    const to = supersededBy.get(item.spec_id);
    if (!to) continue;
    const n = (perSpecCount.get(to.id) ?? 0) + 1;
    perSpecCount.set(to.id, n);
    repointed.push({
      item_id: item.id,
      from_spec_id: item.spec_id,
      to_spec_id: to.id,
      new_label: `${to.label} — round ${n}`,
      old_title: item.planned_title ?? item.label,
    });
  }
  const flagged = queue.items
    .filter((i) => i.status === 'ready' && superseded.has(i.spec_id))
    .map((i) => i.id);
  const blueprints: AdaptDiff['blueprints'] = [
    ...drafts.map((d) => ({ spec_id: d.spec.id, action: 'new' as const, markdown: d.blueprint })),
    ...editRows,
  ];
  const newLabels = drafts.map((d) => d.spec.label).join(', ');
  const parts = [
    drafts.length ? `new: ${newLabels}` : '',
    repointed.length ? `${repointed.length} upcoming round${repointed.length === 1 ? '' : 's'} re-shaped` : '',
    flagged.length ? `${flagged.length} built problem${flagged.length === 1 ? '' : 's'} flagged for rebuild` : '',
    editRows.length ? `${editRows.length} blueprint${editRows.length === 1 ? '' : 's'} refined` : '',
  ].filter(Boolean);
  return {
    new_specs: drafts.map((d) => d.spec),
    superseded: [...superseded],
    repointed,
    flagged,
    skipped: [],
    blueprints,
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
    // ready is re-pointable too (with a stale flag): the built problem
    // still matches the OLD shape, and rebuild regenerates under
    // item.spec_id — leaving it un-repointed is how the rebuild button
    // regenerated a retired spec.
    if (!item || !(RESHAPEABLE.has(item.status) || item.status === 'ready')) {
      skipped.push({ item_id: r.item_id, reason: item ? `now ${item.status}` : 'no longer exists' });
      continue;
    }
    item.spec_id = r.to_spec_id;
    item.label = r.new_label;
    if (item.status === 'ready') item.stale = true;
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
    superseded: diff.superseded ?? [],
    repointed: applied,
    flagged: flaggedApplied,
    skipped,
    ...(diff.blueprints?.length
      ? { blueprints_updated: diff.blueprints.map((b) => b.spec_id) }
      : {}),
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

export type Adapter = (input: {
  /** ACTIVE specs only — what the model sees and may supersede. */
  specs: RoundSpec[];
  /** Every spec id that ever existed — the collision universe. */
  allSpecIds?: string[];
  /** Current blueprints for the active specs — what blueprint_edits revise. */
  blueprints?: { spec_id: string; markdown: string }[];
  material: string;
}) => Promise<AdaptOutcome>;

/** Token-growth guard: a blueprint is a page, not a book — cap what each
 *  contributes to the adapt prompt and say so visibly when it truncates. */
const BLUEPRINT_PROMPT_CAP = 8_000;

function renderBlueprints(bps: { spec_id: string; markdown: string }[] | undefined, specs: RoundSpec[]): string {
  return specs
    .map((s) => {
      const bp = bps?.find((b) => b.spec_id === s.id);
      const body = bp
        ? bp.markdown.length > BLUEPRINT_PROMPT_CAP
          ? bp.markdown.slice(0, BLUEPRINT_PROMPT_CAP) + '\n[truncated]'
          : bp.markdown
        : '(no blueprint yet)';
      return `### ${s.id}\n\n${body}`;
    })
    .join('\n\n');
}

function specLine(s: RoundSpec): string {
  const c = s.capabilities;
  return `- id: ${s.id} · "${s.label}" · ${c.interviewer ? 'live interviewer' : 'no interviewer (OA)'} · ${
    c.time_limit_ms ? Math.round(c.time_limit_ms / 60_000) + ' min' : 'untimed'
  } · starts from ${c.starts_from} · ${c.submit}${s.emphasis ? ` · emphasis: ${s.emphasis}` : ''}`;
}

function buildPrompt(templatePath: string, input: Parameters<Adapter>[0]): string {
  return readFileSync(templatePath, 'utf8')
    .replace(/\{\{CURRENT_ROUNDS\}\}/g, input.specs.map(specLine).join('\n'))
    .replace(/\{\{CURRENT_BLUEPRINTS\}\}/g, renderBlueprints(input.blueprints, input.specs))
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
            blueprint: {
              type: 'string',
              description:
                'The complete round blueprint markdown for this NEW round — every required section, concrete about shape/language/size. Required.',
            },
          },
          required: [
            'id', 'label', 'interviewer', 'can_run_tests', 'time_limit_minutes',
            'starts_from', 'submit', 'check_kind', 'rationale', 'unsupported', 'supersedes',
            'blueprint',
          ],
        },
      },
      blueprint_edits: {
        type: 'array',
        description:
          'Revisions of EXISTING rounds\' blueprints when the material refines HOW a round looks without changing its capabilities — the common case. Each entry is the round\'s COMPLETE revised blueprint with the new learning appended to its Learnings log. Empty when nothing to refine.',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Existing (active) spec id whose blueprint this revises.' },
            blueprint: { type: 'string', description: 'The complete revised blueprint markdown.' },
          },
          required: ['id', 'blueprint'],
        },
      },
    },
    required: ['rounds', 'blueprint_edits'],
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
    return gateAdapt(call.input, input.specs, input.allSpecIds);
  };
}

export function claudePAdapter(templatePath: string, model = 'sonnet'): Adapter {
  return (input) =>
    new Promise<AdaptOutcome>((resolve, reject) => {
      const prompt =
        buildPrompt(templatePath, input) +
        '\n\nReply with ONLY a JSON object: {"rounds": [{id, label, interviewer, can_run_tests, time_limit_minutes, starts_from, submit, check_kind, emphasis, rationale, unsupported, supersedes, blueprint}], "blueprint_edits": [{id, blueprint}]}';
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
          resolve(gateAdapt(JSON.parse(match[0]), input.specs, input.allSpecIds));
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
