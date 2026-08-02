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

/**
 * Recover a usable URL from what models actually emit.
 *
 * Measured, not guessed: a live Ramp probe retrieved genuinely useful
 * round detail and reported ZERO findings, because the gate required a
 * literal ^https?:// and dropped everything else in silence. Scheme-less
 * hosts, markdown links, and `source`/`link` key aliases are all common.
 * Recovering them is not loosening the citation rule — every survivor is
 * still an auditable URL; we just stop discarding the ones we have.
 */
export function normalizeCitation(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  let s = v.trim();
  if (!s) return null;
  // [label](url) or a bare (url)
  const md = s.match(/\((https?:\/\/[^\s)]+)\)/) ?? s.match(/\]\(([^\s)]+)\)/);
  if (md?.[1]) s = md[1];
  s = s.replace(/^<|>$/g, '').replace(/[.,;]+$/, '').trim();
  if (/^https?:\/\//i.test(s)) return s;
  // Bare host/path — require a dotted host so prose never becomes a "URL".
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i.test(s)) return `https://${s}`;
  return null;
}

export function parseResearchOutput(raw: string): ResearchResult {
  const match = extractFirstJsonObject(raw);
  if (!match) throw new Error('no JSON in research output');
  const o = JSON.parse(match) as { summary?: unknown; findings?: unknown };
  if (typeof o.summary !== 'string') throw new Error('missing summary');
  const findings = Array.isArray(o.findings)
    ? o.findings
        .map((f) => {
          const x = f as { claim?: unknown; url?: unknown; source?: unknown; link?: unknown };
          const claim = typeof x.claim === 'string' ? x.claim.trim() : '';
          const url = normalizeCitation(x.url ?? x.source ?? x.link);
          return claim && url ? { claim, url } : null;
        })
        // A claim without a real citation is exactly the thing this agent
        // exists to prevent — drop it rather than pass it along.
        .filter((f): f is { claim: string; url: string } => f !== null)
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
