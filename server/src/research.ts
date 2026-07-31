/**
 * Round research — an agent that looks up what a company's round actually
 * looks like, from PUBLIC sources, and returns claims WITH citations.
 *
 * Two hard rules (CEO review decision 9 + the hallucination rule):
 *   - No Glassdoor scraping: login-walled, TOS-hostile, brittle. Search is
 *     restricted to open sources (Blind, LeetCode discuss, GitHub, blogs).
 *   - NOTHING from research reaches spec inference or generation without
 *     the candidate confirming it. A hallucinated round detail is worse
 *     than none, because it produces a confidently wrong round the
 *     candidate cannot audit. Citations exist so they CAN audit.
 *
 * Degrades cleanly: zero findings is a valid result, and paste-only intake
 * works without this entirely.
 */

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

export interface ResearchResult {
  summary: string;
  findings: { claim: string; url: string }[];
}

export type Researcher = (label: string, description: string) => Promise<ResearchResult>;

/**
 * First BALANCED JSON object in the text. A greedy `\{[\s\S]*\}` died on the
 * first live run: the model fenced its JSON and kept talking, so the match
 * spanned from the first `{` to a `}` well past the object's end. Depth
 * tracking (string- and escape-aware) instead of regex.
 */
export function extractFirstJsonObject(raw: string): string | null {
  const start = raw.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    if (ch === '}') {
      depth--;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  return null;
}

export function parseResearchOutput(raw: string): ResearchResult {
  const match = extractFirstJsonObject(raw);
  if (!match) throw new Error('no JSON in research output');
  const o = JSON.parse(match) as { summary?: unknown; findings?: unknown };
  if (typeof o.summary !== 'string') throw new Error('missing summary');
  const findings = Array.isArray(o.findings)
    ? o.findings
        .filter(
          (f): f is { claim: string; url: string } =>
            typeof (f as { claim?: unknown }).claim === 'string' &&
            typeof (f as { url?: unknown }).url === 'string' &&
            /^https?:\/\//.test((f as { url: string }).url),
        )
        // A claim without a real citation is exactly the thing this agent
        // exists to prevent — drop it rather than pass it along.
        .slice(0, 12)
    : [];
  return { summary: o.summary.trim(), findings };
}

export function claudePResearcher(templatePath: string, model = 'sonnet'): Researcher {
  return (label, description) =>
    new Promise<ResearchResult>((resolve, reject) => {
      const prompt = readFileSync(templatePath, 'utf8')
        .replace(/\{\{LABEL\}\}/g, label)
        .replace(/\{\{DESCRIPTION\}\}/g, description || '(none)');
      const child = spawn(
        'claude',
        [
          '-p', prompt,
          '--output-format', 'text',
          '--model', model,
          // Search only — the researcher writes nothing and runs nothing.
          '--allowedTools', 'WebSearch,WebFetch',
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let stdout = '';
      child.stdout.on('data', (d) => (stdout += d));
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error('research timed out'));
      }, 240_000);
      child.on('close', () => {
        clearTimeout(timer);
        try {
          resolve(parseResearchOutput(stdout));
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
