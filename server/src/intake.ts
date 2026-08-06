/**
 * Target intake — the front door of the season program.
 *
 *   candidate describes a round ──► inferRoundSpec (constrained tool call)
 *                                        │ draft + rationale
 *                                        ▼
 *                              human confirms / edits   ◄── ALWAYS
 *                                        │
 *                                        ▼
 *                              target.json specs[] ──► generation
 *                                        ▲
 *   candidate pastes new info ──► adapt (diff, approved) — append-only
 *
 * The draft is never trusted: validateRoundSpec gates it mechanically, tags
 * are derived in code, and nothing reaches generation without the candidate
 * confirming. A wrong draft costs one edit; a wrong session costs 45 minutes.
 *
 * Intake is the first coaching interaction, not a form (CEO review): the
 * questions it asks — what did the recruiter say, what have you found — are
 * the research a good mentor would make you do anyway.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { RoundSpec } from '@interview-prep/shared';
import { deriveMemoryTags, validateRoundSpec } from '@interview-prep/shared';

export interface Target {
  id: string;
  label: string;
  /** ISO date of the interview, when known — the queue paces against it. */
  interview_date?: string;
  /** What the candidate said about the round(s), verbatim. */
  description: string;
  /** Pasted reference material: recruiter email, a found question, notes. */
  context?: string;
  /** Binary reference material (screenshots, PDFs) stored under the target
   *  dir and sent to the model as typed content blocks — the firsthand
   *  evidence class (an assessment preview the candidate SAW) that a
   *  text-flattened context could never carry. `file` is relative to the
   *  target dir. */
  attachments?: { name: string; media_type: string; file: string }[];
  /** Confirmed round shapes. Only confirmed specs generate problems.
   *  APPEND-ONLY once items reference them: adaptation adds specs and
   *  re-points future items; it never edits or removes one, so history
   *  keeps describing what actually ran. */
  specs: RoundSpec[];
  /** Applied adaptations, newest last — the audit trail the timeline
   *  renders ("Aug 5 — new: LLD round · 4 rounds re-shaped") and the
   *  recovery record reconcileAdaptation repairs from. See adapt.ts. */
  adaptations?: import('./adapt.js').AdaptRecord[];
  created: string;
}

export function targetDir(root: string, id: string): string {
  return path.join(root, 'targets', id);
}

export function saveTarget(root: string, target: Target): void {
  const dir = targetDir(root, target.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'target.json'), JSON.stringify(target, null, 2));
}

export function loadTarget(root: string, id: string): Target | null {
  const file = path.join(targetDir(root, id), 'target.json');
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8')) as Target;
}

/** Media types the intake accepts as binary attachments. The allowlist is
 *  the gate: anything else is rejected at /api/target, never written. */
export const ATTACHMENT_MEDIA_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf',
]);
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENTS = 5;

/** A stored attachment → the typed content block a model call sends.
 *  Images become image blocks; PDFs become document blocks with citations
 *  enabled, so a claim like "your screenshot shows a 90:00 timer" is
 *  auditable back to the page it came from. A missing or unreadable file
 *  degrades to a text note — one bad attachment must not sink the call. */
export function attachmentBlocks(
  root: string,
  target: Target,
): Record<string, unknown>[] {
  return (target.attachments ?? []).map((a) => {
    let data: string;
    try {
      data = readFileSync(path.join(targetDir(root, target.id), a.file)).toString('base64');
    } catch {
      return { type: 'text', text: `(attachment "${a.name}" is missing on disk)` };
    }
    if (a.media_type === 'application/pdf') {
      return {
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data },
        title: a.name,
        citations: { enabled: true },
      };
    }
    return { type: 'image', source: { type: 'base64', media_type: a.media_type, data } };
  });
}

export function listTargets(root: string): Target[] {
  const base = path.join(root, 'targets');
  if (!existsSync(base)) return [];
  return readdirSync(base)
    .map((id) => loadTarget(root, id))
    .filter((t): t is Target => t !== null)
    .sort((a, b) => a.created.localeCompare(b.created));
}

export function slugify(label: string): string {
  return (
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'target'
  );
}

// ---- spec inference ----

export interface SpecDraft {
  spec: RoundSpec;
  /** Why the model chose this shape — shown at confirm time. */
  rationale: string;
  /** Non-empty when the round asks for something the environment lacks
   *  (e.g. a system-design canvas). Declining honestly beats a bad session. */
  unsupported?: string;
}

export type SpecInferrer = (description: string, context: string) => Promise<SpecDraft>;

/** The tool schema mirrors RoundSpec minus tags (derived in code) and minus
 *  anything open-vocabulary the model could damage. Enums keep the model
 *  inside the capability space; validateRoundSpec re-proves it after. */
const DRAFT_TOOL = {
  name: 'draft_round_spec',
  description: 'Draft the capability spec for the described interview round.',
  input_schema: {
    type: 'object' as const,
    properties: {
      id: { type: 'string', description: 'kebab-case slug for this round shape' },
      label: { type: 'string', description: 'Short human label, e.g. "Palantir learning round"' },
      interviewer: { type: 'boolean' },
      can_run_tests: { type: 'boolean' },
      time_limit_minutes: {
        type: ['number', 'null'],
        description: 'null unless the round is explicitly timed',
      },
      starts_from: { type: 'string', enum: ['repo', 'blank', 'diff'] },
      submit: { type: 'string', enum: ['iterate', 'one_shot'] },
      surface: {
        type: 'string',
        enum: ['ide', 'panes'],
        description:
          'Only when the description names the editing surface (e.g. "HackerRank editor" → panes, "in an IDE / real repo environment" → ide). Omit otherwise — the default derivation from starts_from is usually right.',
      },
      check_kind: {
        type: 'string',
        enum: ['one_failing_test', 'all_failing', 'all_passing', 'diff_present'],
      },
      max_source_files: {
        type: 'number',
        description:
          'Only when the description pins the problem size in files ("one file", "a single page of code" → 1). Omit otherwise.',
      },
      emphasis: {
        type: 'string',
        description: 'Generation emphasis from the description, e.g. "likely concurrency". Empty if none.',
      },
      rationale: { type: 'string', description: '2-3 sentences: why this shape fits the description.' },
      unsupported: {
        type: 'string',
        description:
          'Empty string normally. If the round fundamentally needs something outside the vocabulary (a design canvas, multi-day work), say what — the product declines honestly instead of running a wrong session.',
      },
    },
    required: [
      'id', 'label', 'interviewer', 'can_run_tests', 'time_limit_minutes',
      'starts_from', 'submit', 'check_kind', 'rationale', 'unsupported',
    ],
  },
};

export interface DraftToolOutput {
  id: string;
  label: string;
  interviewer: boolean;
  can_run_tests: boolean;
  time_limit_minutes: number | null;
  starts_from: RoundSpec['capabilities']['starts_from'];
  submit: RoundSpec['capabilities']['submit'];
  surface?: RoundSpec['capabilities']['surface'];
  check_kind: RoundSpec['check']['kind'];
  max_source_files?: number;
  emphasis?: string;
  /** ISO date this round happens, ONLY when the material states it. */
  date?: string;
  rationale: string;
  unsupported: string;
}

/** A model's "optional string" arrives as null, a number, or an array
 *  often enough that assuming string crashes the seam (seen live: emphasis
 *  as null through the claude -p path). Coerce; the vocabulary gate still
 *  decides validity. */
function asText(v: unknown): string {
  if (typeof v === 'string') return v.trim();
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return v.map((x) => String(x)).join('; ').trim();
  return String(v).trim();
}

/** Flat tool output → RoundSpec, tags derived, gate applied. Exported for
 *  tests and for the claude -p fallback (same shape, parsed from JSON). */
export function draftToSpec(out: DraftToolOutput): SpecDraft {
  const minutes =
    out.time_limit_minutes === null || out.time_limit_minutes === undefined
      ? null
      : Number(out.time_limit_minutes);
  const capabilities = {
    interviewer: out.interviewer,
    can_run_tests: out.can_run_tests,
    time_limit_ms: minutes === null || Number.isNaN(minutes) ? null : Math.round(minutes * 60_000),
    starts_from: out.starts_from,
    submit: out.submit,
    // Present only when the model asserted it; absent lets resolveSurface derive.
    ...(out.surface ? { surface: out.surface } : {}),
  };
  const emphasis = asText(out.emphasis);
  const maxFiles = Number(out.max_source_files);
  const date = asText(out.date);
  const spec: RoundSpec = {
    id: slugify(asText(out.id) || asText(out.label)),
    label: asText(out.label),
    capabilities,
    check: {
      kind: out.check_kind,
      ...(Number.isInteger(maxFiles) && maxFiles >= 1 ? { max_source_files: maxFiles } : {}),
    },
    memory_tags: deriveMemoryTags(capabilities),
    ...(emphasis ? { emphasis } : {}),
    // The vocabulary gate below validates the format; a garbled date is an
    // inference failure, never silent data (same rule as /api/target).
    ...(date ? { date } : {}),
  };
  const failures = validateRoundSpec(spec);
  if (failures.length > 0) {
    throw new Error(`inferred spec failed the vocabulary gate: ${failures.join('; ')}`);
  }
  const unsupported = asText(out.unsupported);
  return {
    spec,
    rationale: asText(out.rationale),
    ...(unsupported ? { unsupported } : {}),
  };
}

function buildInferencePrompt(templatePath: string, description: string, context: string): string {
  return readFileSync(templatePath, 'utf8')
    .replace(/\{\{DESCRIPTION\}\}/g, description)
    .replace(/\{\{CONTEXT\}\}/g, context || '(none provided)');
}

export function apiSpecInferrer(templatePath: string, model = 'claude-sonnet-5'): SpecInferrer {
  return async (description, context) => {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({ timeout: 60_000 });
    const msg = await client.messages.create({
      model,
      max_tokens: 2_000,
      messages: [{ role: 'user', content: buildInferencePrompt(templatePath, description, context) }],
      tools: [DRAFT_TOOL],
      tool_choice: { type: 'tool', name: DRAFT_TOOL.name },
    });
    const call = msg.content.find(
      (b): b is Extract<typeof b, { type: 'tool_use' }> => b.type === 'tool_use',
    );
    if (!call) throw new Error('spec inference returned no tool call');
    return draftToSpec(call.input as DraftToolOutput);
  };
}

export function claudePSpecInferrer(templatePath: string, model = 'sonnet'): SpecInferrer {
  return (description, context) =>
    new Promise<SpecDraft>((resolve, reject) => {
      const prompt =
        buildInferencePrompt(templatePath, description, context) +
        '\n\nReply with ONLY a JSON object with keys: id, label, interviewer, can_run_tests, time_limit_minutes (number or null), starts_from, submit, check_kind, emphasis, rationale, unsupported.';
      const child = spawn('claude', ['-p', prompt, '--output-format', 'text', '--model', model], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      child.stdout.on('data', (d) => (stdout += d));
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error('spec inference timed out'));
      }, 120_000);
      child.on('close', () => {
        clearTimeout(timer);
        try {
          const match = stdout.match(/\{[\s\S]*\}/);
          if (!match) throw new Error('no JSON in inference output');
          resolve(draftToSpec(JSON.parse(match[0]) as DraftToolOutput));
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

export function pickSpecInferrer(templatePath: string): SpecInferrer {
  return process.env.ANTHROPIC_API_KEY
    ? apiSpecInferrer(templatePath)
    : claudePSpecInferrer(templatePath);
}
