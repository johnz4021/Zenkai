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

/**
 * The task taxonomy — what the candidate is asked to DO, one skeleton each.
 * Grounded in 2026 market research (plan 2026-08-12/13), not company quirks:
 * algorithmic OAs are still the volume format; debugging is the
 * fastest-growing round; practical builds with STAGED requirements are the
 * post-LeetCode replacement (Stripe/OpenAI class); comprehension of an
 * unfamiliar codebase is a Google-official 2026 format; extend-keep-green and
 * review-a-diff fill the all_passing / diff_present halves of the check-kind
 * space that previously fell into the learning catch-all.
 *
 * RECIPE-SIDE ON PURPOSE: task routes generation and nothing else. The
 * session runtime never reads it, the validator never proves it, memory never
 * counts it — so it stays OUT of RoundSpec (the two-artifact rule). It rides
 * in tool outputs, the rep record, and this resolver.
 */
export const ROUND_TASKS = [
  'algorithmic_set',
  'debug',
  'practical_build',
  'comprehend',
  'extend_keep_green',
  'review_diff',
] as const;
export type RoundTask = (typeof ROUND_TASKS)[number];

export const TASK_FILES: Record<RoundTask, string> = {
  algorithmic_set: 'oa-hackerrank-classic.md',
  debug: 'debugging-round.md',
  practical_build: 'lld-build.md',
  comprehend: 'learning-round.md',
  extend_keep_green: 'extend-keep-green.md',
  review_diff: 'review-a-diff.md',
};

/**
 * The capability fallback: a task derived from FACTS the spec already holds,
 * for specs with no stored hypothesis (legacy reps, the plans path until it
 * carries task). Known residual, stated honestly: blank+all_failing+panes
 * cannot distinguish algorithmic_set from practical_build — capability-
 * identical; only a hypothesis separates them. Defaults to the volume format.
 */
/** Which check kinds a task can honestly pair with. Deliberately permissive
 *  (plan risk #2): only impossible combos are out. A mismatch never sinks a
 *  draft — coerceTask falls back to the capability derivation. */
const TASK_CHECK_KINDS: Record<RoundTask, ReadonlyArray<RoundSpec['check']['kind']>> = {
  algorithmic_set: ['all_failing'],
  debug: ['one_failing_test'],
  // all_passing is legal here: a staged build whose part 1 ships working and
  // later waves extend it IS a practical build the model correctly named —
  // a live run said practical_build ("requirements escalate", its words) with
  // all_passing and the old single-pair table silently overrode the
  // classification to extend_keep_green (QA 2026-08-13).
  practical_build: ['all_failing', 'all_passing'],
  comprehend: ['one_failing_test', 'all_passing', 'all_failing'],
  extend_keep_green: ['all_passing'],
  review_diff: ['diff_present'],
};

/** The task hypothesis, trusted only when valid AND coherent with the
 *  check kind the draft itself carries; otherwise derived from capability
 *  facts. Never fatal — the same never-sink philosophy as affects/target.
 *  Lives here (not practice-clarify) since 2026-08-15 so every door —
 *  practice, wizard, planner — runs the ONE gate. */
export function coerceTask(raw: unknown, spec: RoundSpec): { task: RoundTask; coerced: boolean } {
  const t = String(raw ?? '').trim() as RoundTask;
  if ((ROUND_TASKS as readonly string[]).includes(t) && TASK_CHECK_KINDS[t].includes(spec.check.kind)) {
    return { task: t, coerced: false };
  }
  return { task: deriveTaskFromSpec(spec), coerced: true };
}

export function deriveTaskFromSpec(spec: RoundSpec): RoundTask {
  switch (spec.check.kind) {
    case 'one_failing_test': return 'debug';
    case 'all_passing': return 'extend_keep_green';
    case 'diff_present': return 'review_diff';
    case 'all_failing':
      return resolveSurface(spec.capabilities) === 'panes' ? 'algorithmic_set' : 'practical_build';
  }
}

/**
 * Which starter skeleton a spec drafts from. With a task hypothesis (made by
 * the model that READ the material — the clarifier), this is a total map
 * lookup; without one, the capability fallback above.
 *
 * The keyword layer that used to live here is DELETED, deliberately. It
 * routed on `label` — documented "display + file naming only" — and its rule
 * list was platform names (hackerrank, codesignal, leetcode…) tested before
 * the task words, so "Palantir OA (HackerRank, 3 parts)" short-circuited to
 * the algorithmic skeleton on the word HackerRank and a decomp-LLD round
 * misgenerated (2026-08-12). Platform is delivery, not task, and delivery
 * already lives in capabilities (deliveryNotes below). The
 * precomputed-verdicts rule applies: classification belongs in the model
 * with the full material; code does lookups.
 */
export function pickSkeletonFile(spec: RoundSpec, task?: RoundTask): string {
  return TASK_FILES[task ?? deriveTaskFromSpec(spec)];
}

/**
 * Delivery facts, derived from capabilities — code states the facts, the
 * drafter writes prose consistent with them. This is what lets any task ship
 * in any delivery (an LLD build inside an OA, a debug round in a live IDE
 * session) without a skeleton per combination, and why skeletons no longer
 * assert delivery at all.
 */
export function deliveryNotes(spec: RoundSpec): string {
  const caps = spec.capabilities;
  const surface = resolveSurface(caps) === 'panes'
    ? 'a browser panes editor (statement beside editor and test panel)'
    : 'a real IDE workspace (file tree and terminal)';
  const time = caps.time_limit_ms === null
    ? 'no fixed time limit'
    : `a single ${Math.round(caps.time_limit_ms / 60_000)}-minute clock`;
  const submitStyle = caps.submit === 'one_shot'
    ? `graded once at submit${caps.can_run_tests ? ' — the visible suite stays runnable while working' : ''}`
    : 'graded on how they work — the suite is their own tool';
  const interviewer = caps.interviewer
    ? 'a live interviewer listens and probes'
    : 'no interviewer — unproctored and autograded, like a real OA';
  const tests = caps.can_run_tests ? '' : '; executing code is not permitted in this round';
  return `Delivered in ${surface}; ${time}; ${submitStyle}; ${interviewer}${tests}.`;
}

// ---- the round brief composition (used by cli.ts generate-for) ----

export interface BriefInputs {
  spec: RoundSpec;
  /** loadBlueprint() output — null falls back to the legacy brief. */
  blueprint: string | null;
  plannedTitle?: string;
  description?: string;
  context?: string;
  /** The plan's frozen concept vocabulary (Target.topics). When present the
   *  brief instructs the generator to declare which it exercises in the
   *  manifest; the declaration is subset-filtered mechanically after the
   *  build, so an invented slug never reaches state. */
  topics?: { id: string; label: string }[];
}

/**
 * What fills {{ROUND_BRIEF}}. With a blueprint: the blueprint IS the round
 * description, plus the planned-title commitment — description/context are
 * deliberately NOT re-appended (the drafter already folded them in;
 * re-adding them recreates the conflicting-prose problem this feature
 * exists to kill). Without: the legacy five-part brief, byte-for-byte.
 */
export function composeRoundBrief(inp: BriefInputs): string {
  // The difficulty clause exists because a title can smuggle a difficulty
  // the recipe never chose: "Two sum — hash table lookup" (an easy) under a
  // "LeetCode-medium" blueprint made the generator split the difference
  // into an accidental hybrid (sess-1786643587196). The title commits WHAT
  // gets built; the round description alone calibrates HOW HARD.
  const titleLine = inp.plannedTitle
    ? `Planned title for THIS problem (build exactly this system, and set the manifest "title" to it): ${inp.plannedTitle} — the round description's difficulty calibration outranks any difficulty this title implies.`
    : '';
  // Season topics travel inside the brief (no template variable): the
  // generator declares which it exercised in the manifest, and the build
  // pipeline subset-filters the declaration against this same frozen list —
  // so the instruction and the enforcement share one source.
  const topicsLine = inp.topics?.length
    ? `This plan's concept topics: ${inp.topics.map((t) => t.id).join(', ')}. In the manifest, set "topics_exercised" to the subset (1-3) this problem genuinely tests — exact ids only, never new ones, and never mention topics anywhere the candidate can see.`
    : '';
  if (inp.blueprint) {
    return [inp.blueprint.trim(), titleLine, topicsLine].filter(Boolean).join('\n\n');
  }
  return [
    `Round: ${inp.spec.label}.`,
    titleLine,
    inp.spec.emphasis ? `Emphasis: ${inp.spec.emphasis}.` : '',
    inp.description ? `The candidate describes it as: ${inp.description}` : '',
    inp.context ? `Reference material from the candidate:\n${inp.context}` : '',
    topicsLine,
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
    // Delivery facts come from code so skeletons never assert them and the
    // drafter cannot contradict the spec (task/delivery split, 2026-08-13).
    .replace(/\{\{DELIVERY\}\}/g, deliveryNotes(input.spec))
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
