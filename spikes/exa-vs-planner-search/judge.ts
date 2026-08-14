/**
 * The blind result judge.
 *
 *   anthropic hits ─┐
 *                   ├─► dedupe by URL ─► deterministic shuffle ─► one judge
 *   exa hits ───────┘        │                                     call per
 *                            │                                     query
 *                    (engine label stripped)                          │
 *                                                                     ▼
 *                                          {tier, specificity, usable} per URL
 *                                                     │
 *                              re-attached to whichever engine(s) returned it
 *
 * Why blind. The interesting result is a ranking preference, and a judge that
 * can see "this one came from Exa" will find reasons to prefer whichever
 * engine the experiment is nominally about. Stripping the label and shuffling
 * on a URL hash (not Math.random, so a re-run judges the same order) removes
 * that. Deduping by URL matters too: the engines overlap, and judging a
 * shared URL twice would let judge noise masquerade as an engine difference.
 *
 * Why THESE labels. They are not generic relevance — they are the four tiers
 * of prompts/planner.md's evidence hierarchy, which is the only thing the
 * planner actually acts on:
 *
 *   official     tier 3, strongest public: the company's own careers page
 *   firsthand    tier 3, but a named person recounting THEIR OWN loop
 *   aggregator   tier 3/4 boundary: prep-site content marketing, laundered
 *   wrong_entity actively harmful — a different company with a similar name
 *   offtopic     not about this loop's process at all
 *
 * A retrieval win that raises `aggregator` count is not a win. The planner
 * is instructed to grade public sources honestly as "thin" and to never
 * override the candidate, so more laundered listicles is more noise the
 * candidate learns to distrust. What changes a RoundSpec is `usable`.
 */

import type Anthropic from '@anthropic-ai/sdk';
import type { Need } from './queries.js';
import type { SearchHit } from './engines.js';

export type Tier = 'official' | 'firsthand' | 'aggregator' | 'wrong_entity' | 'offtopic';

export interface Verdict {
  url: string;
  tier: Tier;
  /** 0 none · 1 vague ("expect coding rounds") · 2 names a round form ·
   *  3 names form AND a capability the RoundSpec vocabulary encodes
   *  (timed, existing repo vs blank, tests runnable, one-shot vs iterate). */
  specificity: 0 | 1 | 2 | 3;
  /** Would a careful planner change or confirm a round draft on this page
   *  alone? The bottom-line metric — everything else is diagnosis. */
  usable: boolean;
  why: string;
}

const JUDGE_TOOL = {
  name: 'grade_results',
  description: 'Grade every search result for this query. One entry per result, same order as given.',
  input_schema: {
    type: 'object' as const,
    properties: {
      verdicts: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            n: { type: 'integer', description: 'The result number as shown.' },
            tier: {
              type: 'string',
              enum: ['official', 'firsthand', 'aggregator', 'wrong_entity', 'offtopic'],
            },
            specificity: { type: 'integer', description: '0-3, per the rubric.' },
            usable: {
              type: 'boolean',
              description: 'Would a planner change or confirm a round shape on this page alone?',
            },
            why: { type: 'string', description: 'One clause. Cite the concrete thing that decided it.' },
          },
          required: ['n', 'tier', 'specificity', 'usable', 'why'],
        },
      },
    },
    required: ['verdicts'],
  },
};

const RUBRIC = `You are grading web search results that an interview-prep planner retrieved, so it can decide the SHAPE of a practice round to generate: is it a timed online assessment or a live pair-programming round; does the candidate start from an existing repo (debug/extend) or a blank file; can they run tests; is it graded once at the end or iteratively.

Grade each result on three axes.

TIER — what kind of evidence this page is:
- official: the hiring company's OWN page (careers site, engineering blog, jobs portal, their own "how we hire").
- firsthand: a named individual recounting THEIR OWN interview at this company — Blind/Reddit/Medium/LeetCode-discuss posts, personal blogs. Must be a specific person's specific loop, not a roundup.
- aggregator: third-party interview-prep content marketing. Prep sites, "Top N questions", AI-interview-tool blogs, guide farms, recruiter-content sites. These restate and launder other people's reports.
- wrong_entity: about a DIFFERENT company, role, or organization than the query names. A same-named but unrelated business is wrong_entity, not offtopic. This is the most damaging label — say so plainly when you use it.
- offtopic: real page, but not about this company's interview process (a generic language quiz, a bare job listing with no process detail, a jobs aggregator).

SPECIFICITY — how concretely it describes a round FORM:
- 0: says nothing about round format.
- 1: vague ("there is a technical screen", "expect coding questions").
- 2: names an actual exercise form ("debug an unfamiliar codebase", "implement from documentation", "60-minute HackerRank").
- 3: names the form AND at least one enforceable capability: a time limit, starting from an existing repo vs blank, whether tests can be run, one-shot vs iterate, proctored vs not.

USABLE — true only if a careful planner could change or confirm a round draft on this page alone. An aggregator that genuinely names the round form can be usable. A firsthand post that only says "it was hard" is not.

Be strict. Most prep-site pages describe every company the same way; that is exactly the noise being measured. Judge the page from its title, URL, and text — do not assume content that is not shown.`;

/** Deterministic order from the URL, so re-running judges the same sequence
 *  and any judge variance is not confounded with ordering. */
function shuffleKey(url: string): number {
  let h = 2166136261;
  for (let i = 0; i < url.length; i++) {
    h ^= url.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export async function judgeNeed(
  client: Anthropic,
  need: Need,
  hits: SearchHit[],
  /** Neutral, independently-fetched page text keyed by URL. Supplying this
   *  is what makes the comparison fair: engine-native snippets differ in
   *  length by an order of magnitude (Exa ~1,200 chars of index text,
   *  Firecrawl a ~200-char description, Anthropic nothing readable), and
   *  grading on them measured snippet availability rather than ranking.
   *  See enrich.ts for the confound this fixes. */
  contents?: Record<string, string>,
  /** `reverse` flips the presentation order. The order is otherwise a fixed
   *  function of the URL, which controls it across passes — but "controlled"
   *  is not "harmless", so reliability runs use this to separate model
   *  sampling noise from position effects. */
  opts: { reverse?: boolean } = {},
): Promise<Verdict[]> {
  // Dedupe by URL, keeping the longest engine-native snippet as a fallback
  // for URLs the enricher could not read.
  const byUrl = new Map<string, SearchHit>();
  for (const h of hits) {
    if (!h.url) continue;
    const prev = byUrl.get(h.url);
    if (!prev || h.snippet.length > prev.snippet.length) byUrl.set(h.url, h);
  }
  const unique = [...byUrl.values()].sort((a, b) => shuffleKey(a.url) - shuffleKey(b.url));
  if (opts.reverse) unique.reverse();
  if (unique.length === 0) return [];

  const rendered = unique
    .map((h, i) => {
      const neutral = (contents?.[h.url] ?? '').trim();
      const body = neutral || h.snippet.trim();
      const snip = body
        ? `\n   text: ${body.replace(/\s+/g, ' ').slice(0, 1_800)}`
        : '\n   text: (page could not be fetched by any extractor — grade from title and URL, and be explicit in `why` that you could not read it)';
      return `${i + 1}. ${h.title}\n   ${h.url}${snip}`;
    })
    .join('\n\n');

  // The need is stated ONCE, in neutral prose, and the query strings that
  // produced these results are withheld. Usability is a property of the page,
  // not of the phrasing that found it — showing the judge "amazon.jobs …
  // official" alongside a result from that domain would let query wording
  // leak into the grade, and the whole point of the two-form design is that
  // wording is the variable under test.
  const msg = await client.messages.create({
    model: 'claude-opus-5',
    max_tokens: 8_000,
    output_config: { effort: 'high' },
    system: RUBRIC,
    tools: [JUDGE_TOOL as never],
    tool_choice: { type: 'tool', name: JUDGE_TOOL.name },
    messages: [
      {
        role: 'user',
        content:
          `The planner was researching: ${need.company}\n` +
          `What it needed to find out: ${need.natural}\n\n` +
          `Grade all ${unique.length} results.\n\n${rendered}`,
      },
    ],
  });

  const call = (msg.content as unknown as Record<string, unknown>[]).find(
    (b) => b.type === 'tool_use' && b.name === JUDGE_TOOL.name,
  );
  if (!call) throw new Error(`judge: no tool call for ${need.id}`);
  const raw = (call.input as { verdicts?: unknown[] }).verdicts ?? [];

  const out: Verdict[] = [];
  for (const v of raw as Record<string, unknown>[]) {
    const n = Number(v.n);
    const hit = unique[n - 1];
    if (!hit) continue;
    const spec = Math.max(0, Math.min(3, Number(v.specificity) || 0)) as 0 | 1 | 2 | 3;
    out.push({
      url: hit.url,
      tier: String(v.tier) as Tier,
      specificity: spec,
      usable: Boolean(v.usable),
      why: String(v.why ?? '').slice(0, 240),
    });
  }
  return out;
}
