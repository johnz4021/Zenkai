/**
 * Round blueprints — the recipe half of a round's definition.
 *
 *   spec (closed ruler) ──┐
 *                          ├──► targets/<id>/blueprints/<spec_id>.md
 *   candidate's words  ────┘         │ (drafted once at intake, edited by
 *                                    │  adaptation, hand-editable anytime)
 *                                    ▼
 *                      generate-for's round brief, verbatim
 *
 * Why it exists (the Palantir size-loss case, 2026-08-05, pinned in
 * docs/problem-generation.md): the spec's only recipe capacity was one
 * optional emphasis string, which lost to hardcoded generation constants —
 * "one page of Python" produced 11 files under a superseded spec. The
 * blueprint is a full prompt the generator treats as the round description,
 * with the user's learnings appended verbatim so nothing is ever laundered
 * away through a single LLM call again.
 *
 * One blueprint per spec; a spec is an EXERCISE FORM (debugging-a-file vs
 * implement-from-docs are two specs on one target). targets/ is gitignored,
 * so history is explicit: writes snapshot the previous version to
 * <spec_id>.prev.md and adaptation appends to learnings.md.
 *
 * Module shape copied from plan-topics.ts: mechanical gate that throws,
 * buildPrompt, forced tool call, claude -p fallback, pickX on API key.
 * Failure degrades to no file — generation falls back to the legacy brief.
 */

import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { RoundSpec } from '@interview-prep/shared';
import { resolveSurface } from '@interview-prep/shared';

/** The load-bearing section set. gateBlueprint requires every one, and the
 *  starter skeletons in prompts/blueprints/ carry exactly these — a test
 *  pins that the library and this list cannot drift apart. */
export const REQUIRED_HEADINGS = [
  '## What this round is',
  '## Environment',
  '## Repo shape',
  '## What the candidate does',
  '## Difficulty calibration',
  '## Topic guidance',
  '## Learnings log',
] as const;

/** Mechanical gate on drafted/edited blueprint markdown. Throws with the
 *  reason — callers degrade (drafter: no file; adapt: drop the edit). */
export function gateBlueprint(markdown: unknown): string {
  const md = typeof markdown === 'string' ? markdown : String(markdown ?? '');
  if (md.trim().length < 600) {
    throw new Error(`blueprint: too thin (${md.trim().length} chars, need >= 600)`);
  }
  for (const h of REQUIRED_HEADINGS) {
    if (!md.includes(h)) throw new Error(`blueprint: missing required section "${h}"`);
  }
  return md;
}

// ---- disk layout ----

export function blueprintDir(root: string, targetId: string): string {
  return path.join(root, 'targets', targetId, 'blueprints');
}

export function blueprintPath(root: string, targetId: string, specId: string): string {
  return path.join(blueprintDir(root, targetId), `${specId}.md`);
}

export function loadBlueprint(root: string, targetId: string, specId: string): string | null {
  try {
    return readFileSync(blueprintPath(root, targetId, specId), 'utf8');
  } catch {
    return null;
  }
}

export function draftingMarkerPath(root: string, targetId: string, specId: string): string {
  return path.join(blueprintDir(root, targetId), `.drafting-${specId}`);
}

/** Write a blueprint, snapshotting any existing version to <spec_id>.prev.md
 *  first. targets/ has no git history, so this single-level undo is the
 *  only history a blueprint gets. */
export function writeBlueprintWithBackup(
  root: string,
  targetId: string,
  specId: string,
  markdown: string,
): void {
  const file = blueprintPath(root, targetId, specId);
  mkdirSync(path.dirname(file), { recursive: true });
  if (existsSync(file)) {
    copyFileSync(file, path.join(path.dirname(file), `${specId}.prev.md`));
  }
  writeFileSync(file, markdown);
}

/**
 * The raw "what I learned" material, verbatim and dated, appended BEFORE any
 * LLM interprets it. The old flow kept only a 280-char excerpt after one
 * lossy adapt call — anything the model dropped was unrecoverable. This file
 * is the guarantee that nothing the candidate learned is ever laundered away.
 */
export function appendLearnings(root: string, targetId: string, material: string, now: number): void {
  const file = path.join(root, 'targets', targetId, 'learnings.md');
  mkdirSync(path.dirname(file), { recursive: true });
  const entry = `## ${new Date(now).toISOString()}\n\n${material.trim()}\n\n`;
  writeFileSync(file, (existsSync(file) ? readFileSync(file, 'utf8') : '# Learnings\n\n') + entry);
}

/**
 * Extract one `## Heading` section's body from blueprint markdown, or null
 * when absent. Used for the OPTIONAL "## Interviewer engagement" section —
 * deliberately NOT in REQUIRED_HEADINGS: blueprints drafted before it
 * existed (and stale adapt previews) must keep passing the gate.
 */
export function extractSection(markdown: string, heading: string): string | null {
  const lines = markdown.split('\n');
  const start = lines.findIndex((l) => l.trim() === heading);
  if (start === -1) return null;
  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i]!)) break;
    body.push(lines[i]!);
  }
  const text = body.join('\n').replace(/<!--[\s\S]*?-->/g, '').trim();
  return text || null;
}

// ---- skeleton selection ----

/** Which starter skeleton a spec drafts from. Keyword match on the spec's
 *  own words first; capability shape as the fallback. Returns a basename
 *  under prompts/blueprints/ — a test existence-checks every branch. */
export function pickSkeletonFile(spec: RoundSpec): string {
  const words = `${spec.label} ${spec.emphasis ?? ''}`.toLowerCase();
  if (/hackerrank|codesignal|\boa\b|online assessment/.test(words)) return 'oa-hackerrank-classic.md';
  if (/lld|low.level|class design|implement.*(class|api)/.test(words)) return 'lld-build.md';
  if (/learning|unfamiliar|collab/.test(words)) return 'learning-round.md';
  if (/debug/.test(words)) return 'debugging-round.md';
  const caps = spec.capabilities;
  if (spec.check.kind === 'one_failing_test') return 'debugging-round.md';
  if (spec.check.kind === 'all_failing') {
    return resolveSurface(caps) === 'panes' ? 'oa-hackerrank-classic.md' : 'lld-build.md';
  }
  return 'learning-round.md';
}

// ---- the round brief composition (used by cli.ts generate-for) ----

export interface BriefInputs {
  spec: RoundSpec;
  /** loadBlueprint() output — null falls back to the legacy brief. */
  blueprint: string | null;
  plannedTitle?: string;
  description?: string;
  context?: string;
}

/**
 * What fills {{ROUND_BRIEF}}. With a blueprint: the blueprint IS the round
 * description, plus the planned-title commitment — description/context are
 * deliberately NOT re-appended (the drafter already folded them in;
 * re-adding them recreates the conflicting-prose problem this feature
 * exists to kill). Without: the legacy five-part brief, byte-for-byte.
 */
export function composeRoundBrief(inp: BriefInputs): string {
  const titleLine = inp.plannedTitle
    ? `Planned title for THIS problem (build exactly this system, and set the manifest "title" to it): ${inp.plannedTitle}`
    : '';
  if (inp.blueprint) {
    return [inp.blueprint.trim(), titleLine].filter(Boolean).join('\n\n');
  }
  return [
    `Round: ${inp.spec.label}.`,
    titleLine,
    inp.spec.emphasis ? `Emphasis: ${inp.spec.emphasis}.` : '',
    inp.description ? `The candidate describes it as: ${inp.description}` : '',
    inp.context ? `Reference material from the candidate:\n${inp.context}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

// ---- the drafter ----

export type BlueprintDrafter = (input: {
  spec: RoundSpec;
  description: string;
  context: string;
  skeleton: string;
}) => Promise<string>;

function buildPrompt(
  templatePath: string,
  input: { spec: RoundSpec; description: string; context: string; skeleton: string },
): string {
  return readFileSync(templatePath, 'utf8')
    .replace(/\{\{SPEC_JSON\}\}/g, JSON.stringify(input.spec))
    .replace(/\{\{DESCRIPTION\}\}/g, input.description || '(none provided)')
    .replace(/\{\{CONTEXT\}\}/g, input.context || '(none provided)')
    .replace(/\{\{SKELETON\}\}/g, input.skeleton);
}

const BLUEPRINT_TOOL = {
  name: 'write_blueprint',
  description: 'Write the complete round blueprint markdown.',
  input_schema: {
    type: 'object' as const,
    properties: {
      markdown: { type: 'string', description: 'The full blueprint, starting at the first # heading.' },
    },
    required: ['markdown'],
  },
};

export function apiBlueprintDrafter(templatePath: string, model = 'claude-sonnet-5'): BlueprintDrafter {
  return async (input) => {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({ timeout: 120_000 });
    const msg = await client.messages.create({
      model,
      max_tokens: 4_000,
      messages: [{ role: 'user', content: buildPrompt(templatePath, input) }],
      tools: [BLUEPRINT_TOOL],
      tool_choice: { type: 'tool', name: BLUEPRINT_TOOL.name },
    });
    const call = msg.content.find(
      (b): b is Extract<typeof b, { type: 'tool_use' }> => b.type === 'tool_use',
    );
    if (!call) throw new Error('blueprint: no tool call');
    // Nested-field lesson (plan-topics): the API validates the top level
    // only — coerce before gating.
    return gateBlueprint((call.input as { markdown: unknown }).markdown);
  };
}

export function claudePBlueprintDrafter(templatePath: string, model = 'sonnet'): BlueprintDrafter {
  return (input) =>
    new Promise<string>((resolve, reject) => {
      const prompt =
        buildPrompt(templatePath, input) +
        '\n\nReply with ONLY the blueprint markdown, starting at the first # heading.';
      const child = spawn('claude', ['-p', prompt, '--output-format', 'text', '--model', model], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      child.stdout.on('data', (d) => (stdout += d));
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error('blueprint: timed out'));
      }, 150_000);
      child.on('close', () => {
        clearTimeout(timer);
        try {
          // Strip a code-fence wrapper if the model added one.
          const md = stdout.replace(/^\s*```(?:markdown)?\s*\n?/, '').replace(/\n?```\s*$/, '');
          resolve(gateBlueprint(md));
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

export function pickBlueprintDrafter(templatePath: string): BlueprintDrafter {
  return process.env.ANTHROPIC_API_KEY
    ? apiBlueprintDrafter(templatePath)
    : claudePBlueprintDrafter(templatePath);
}
