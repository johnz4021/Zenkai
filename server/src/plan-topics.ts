/**
 * Plan-topic naming — one cheap LLM call at plan build that names every
 * planned round (design decision D-impl, 2026-07-31).
 *
 * Why it exists: future queue items have no generated problem yet, so
 * without names the timeline renders as N copies of the spec label — the
 * exact twelve-identical-rows failure the redesign kills. Named up front,
 * the future reads as a plan; and each title is fed into that item's later
 * generation brief, so the problem built matches the promise (the title is
 * a COMMITMENT to generation, not decoration).
 *
 * Failure degrades to no titles (quiet rows) — naming never blocks a queue.
 */

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

export type TopicNamer = (roundBrief: string, count: number) => Promise<string[]>;

// Filler is banned as a TERMINAL pattern, not as vocabulary: "practice
// session 1" is filler; "Session cache — concurrent key invalidation" is a
// legitimate system (live false positive that quiet-rowed a whole spec).
const BANNED = /\b(round|problem|practice|session|drill)s?\s*#?\d*\s*$|\d+\s*$/i;

/** Mechanical gate on the model's titles: exactly N, 3-8 words, pairwise
 *  distinct, none of the banned filler. Throws with the reason — the caller
 *  degrades to quiet rows rather than shipping bad names. */
export function gateTopics(titles: unknown, count: number): string[] {
  if (!Array.isArray(titles)) throw new Error('topics: not an array');
  const clean = titles.map((t) => String(t).trim()).filter(Boolean);
  if (clean.length !== count) throw new Error(`topics: expected ${count}, got ${clean.length}`);
  const seen = new Set<string>();
  for (const t of clean) {
    const words = t.split(/\s+/).length;
    if (words < 3 || words > 8) throw new Error(`topics: "${t}" is ${words} words (need 3-8)`);
    if (BANNED.test(t)) throw new Error(`topics: "${t}" uses banned filler`);
    const key = t.toLowerCase();
    if (seen.has(key)) throw new Error(`topics: duplicate "${t}"`);
    seen.add(key);
  }
  return clean;
}

function buildPrompt(templatePath: string, roundBrief: string, count: number): string {
  return readFileSync(templatePath, 'utf8')
    .replace(/\{\{ROUND_BRIEF\}\}/g, roundBrief)
    .replace(/\{\{COUNT\}\}/g, String(count));
}

const TOPICS_TOOL = {
  name: 'name_topics',
  description: 'Name the practice rounds in the plan.',
  input_schema: {
    type: 'object' as const,
    properties: {
      titles: { type: 'array', items: { type: 'string' }, description: 'Exactly the requested number of titles, easiest first.' },
    },
    required: ['titles'],
  },
};

export function apiTopicNamer(templatePath: string, model = 'claude-haiku-4-5-20251001'): TopicNamer {
  return async (roundBrief, count) => {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({ timeout: 60_000 });
    const msg = await client.messages.create({
      model,
      max_tokens: 1_000,
      messages: [{ role: 'user', content: buildPrompt(templatePath, roundBrief, count) }],
      tools: [TOPICS_TOOL],
      tool_choice: { type: 'tool', name: TOPICS_TOOL.name },
    });
    const call = msg.content.find(
      (b): b is Extract<typeof b, { type: 'tool_use' }> => b.type === 'tool_use',
    );
    if (!call) throw new Error('topics: no tool call');
    // Nested-field lesson from the judge: the API validates the top level
    // only — a stringified array still arrives as a string.
    let titles = (call.input as { titles: unknown }).titles;
    if (typeof titles === 'string') titles = JSON.parse(titles.match(/\[[\s\S]*\]/)?.[0] ?? '[]');
    return gateTopics(titles, count);
  };
}

export function claudePTopicNamer(templatePath: string, model = 'haiku'): TopicNamer {
  return (roundBrief, count) =>
    new Promise<string[]>((resolve, reject) => {
      const prompt =
        buildPrompt(templatePath, roundBrief, count) +
        '\n\nReply with ONLY a JSON array of title strings.';
      const child = spawn('claude', ['-p', prompt, '--output-format', 'text', '--model', model], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      child.stdout.on('data', (d) => (stdout += d));
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error('topics: timed out'));
      }, 90_000);
      child.on('close', () => {
        clearTimeout(timer);
        try {
          const match = stdout.match(/\[[\s\S]*\]/);
          if (!match) throw new Error('topics: no JSON array in output');
          resolve(gateTopics(JSON.parse(match[0]), count));
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

export function pickTopicNamer(templatePath: string): TopicNamer {
  return process.env.ANTHROPIC_API_KEY
    ? apiTopicNamer(templatePath)
    : claudePTopicNamer(templatePath);
}
