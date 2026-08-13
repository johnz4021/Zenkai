/**
 * The three retrieval paths under test, behind one interface.
 *
 *   query ──┬──► anthropicSearch()  web_search_20260209  (what planner.ts ships)
 *           ├──► exaSearch()        POST api.exa.ai/search        (neural index)
 *           └──► firecrawlSearch()  POST api.firecrawl.dev/v2/search
 *                                          │
 *                              SearchHit[] (title, url, snippet, rank)
 *
 *   url   ──┬──► anthropicFetch()   web_fetch_20260209
 *           ├──► exaFetch()         POST api.exa.ai/contents
 *           └──► firecrawlFetch()   POST api.firecrawl.dev/v2/scrape
 *
 * Why both halves are measured separately. SEARCH is the ranking question
 * ("does the engine surface the firsthand account or the SEO farm?"). FETCH
 * is a different question with a different answer: planner.ts already carries
 * a FETCH_REASONS table and an `unreadable` render path because web_fetch
 * refuses many of the sites where firsthand interview reports live, and the
 * candidate's own pasted links are exactly the ones that fail (2026-08-08).
 * An engine can win one and lose the other — measured on 2026-08-13, Exa
 * ranks differently but extracts WORSE than web_fetch (131 chars of
 * palantir.com/careers vs 1,635), while Firecrawl extracts far more than
 * either (4,109 on the same page, 15,400 on a Blind thread) yet refuses
 * Reddit outright. Pooling the two halves into one "which is better" number
 * would hide all of that.
 *
 * Policy parity. All three get the same glassdoor.com exclusion. Anthropic
 * and Exa take it as a request parameter; Firecrawl's search has no
 * equivalent, so it is filtered client-side — same policy, enforced at the
 * nearest available layer, never left to a prompt.
 */

import type Anthropic from '@anthropic-ai/sdk';
import { BLOCKED_DOMAINS } from './queries.js';
import { requireKey } from './env.js';

export type Engine = 'anthropic' | 'exa' | 'firecrawl';
export const ENGINES: Engine[] = ['anthropic', 'exa', 'firecrawl'];

export interface SearchHit {
  engine: Engine;
  rank: number;
  title: string;
  url: string;
  /** Text the engine hands back WITH the result. Anthropic's web_search
   *  returns `encrypted_content` the model can read but we cannot, so this is
   *  empty there — recorded honestly rather than scored as "no content", and
   *  the judge is told to grade those from title and URL. */
  snippet: string;
}

export interface SearchRun {
  engine: Engine;
  queryId: string;
  hits: SearchHit[];
  ms: number;
  /** Kept rather than dropped, so a failure shows up in the report instead of
   *  silently shrinking the N. */
  error?: string;
  /** Engine-specific extras worth reporting (Exa's resolved search type,
   *  Anthropic's billed usage). */
  meta?: Record<string, unknown>;
}

function blocked(url: string): boolean {
  return BLOCKED_DOMAINS.some((d) => {
    try {
      const h = new URL(url).hostname.replace(/^www\./, '');
      return h === d || h.endsWith(`.${d}`);
    } catch {
      return false;
    }
  });
}

// ---- Anthropic: web_search_20260209, exactly as planner.ts declares it ----

/** One forced search. We read the raw `web_search_tool_result` block rather
 *  than the model's prose, so this measures the ENGINE, not opus's summary.
 *
 *  Thinking stays ON at low effort deliberately: with thinking disabled,
 *  Opus 5 can emit a tool call as plain text — the turn succeeds, the search
 *  never runs, and the run would look like a retrieval failure rather than a
 *  harness bug. */
export async function anthropicSearch(
  client: Anthropic,
  queryId: string,
  query: string,
): Promise<SearchRun> {
  const started = Date.now();
  try {
    const msg = await client.messages.create({
      model: 'claude-opus-5',
      max_tokens: 4_000,
      output_config: { effort: 'low' },
      tools: [
        {
          type: 'web_search_20260209',
          name: 'web_search',
          max_uses: 1,
          blocked_domains: BLOCKED_DOMAINS,
        } as never,
      ],
      messages: [
        {
          role: 'user',
          content:
            `Run exactly one web search with this exact query string, then stop and say "done".\n\n` +
            `Query: ${query}`,
        },
      ],
    });

    const hits: SearchHit[] = [];
    let error: string | undefined;
    for (const block of msg.content as unknown as Record<string, unknown>[]) {
      if (block.type !== 'web_search_tool_result') continue;
      const content = block.content;
      if (!Array.isArray(content)) {
        error = `web_search error: ${JSON.stringify(content).slice(0, 200)}`;
        continue;
      }
      for (const r of content as Record<string, unknown>[]) {
        const url = String(r.url ?? '');
        if (!url || blocked(url)) continue;
        hits.push({
          engine: 'anthropic',
          rank: hits.length + 1,
          title: String(r.title ?? ''),
          url,
          snippet: '', // encrypted_content — readable by the model, not by us
        });
      }
    }
    return {
      engine: 'anthropic',
      queryId,
      hits,
      ms: Date.now() - started,
      ...(error ? { error } : {}),
      meta: { usage: msg.usage },
    };
  } catch (e) {
    return {
      engine: 'anthropic',
      queryId,
      hits: [],
      ms: Date.now() - started,
      error: String(e).slice(0, 300),
    };
  }
}

// ---- Exa ----

const EXA_BASE = 'https://api.exa.ai';

/** `type: 'auto'` lets Exa pick neural vs keyword per query — the setting a
 *  real integration would ship, so it is the one worth measuring. The
 *  resolved choice is recorded in `meta` so the report can say which mode
 *  actually ran on these round-form queries. Contents come inline: for Exa,
 *  search and extract are one call, which is itself part of the comparison. */
export async function exaSearch(
  queryId: string,
  query: string,
  opts: { type?: 'auto' | 'neural' | 'keyword' | 'fast'; numResults?: number } = {},
): Promise<SearchRun> {
  const started = Date.now();
  try {
    const res = await fetch(`${EXA_BASE}/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': requireKey('EXA_API_KEY') },
      body: JSON.stringify({
        query,
        type: opts.type ?? 'auto',
        numResults: opts.numResults ?? 10,
        excludeDomains: BLOCKED_DOMAINS,
        contents: { text: { maxCharacters: 1_200 } },
      }),
    });
    const body = (await res.json()) as Record<string, unknown>;
    if (!res.ok) {
      return {
        engine: 'exa',
        queryId,
        hits: [],
        ms: Date.now() - started,
        error: `HTTP ${res.status}: ${JSON.stringify(body).slice(0, 300)}`,
      };
    }
    const results = (body.results ?? []) as Record<string, unknown>[];
    const hits: SearchHit[] = [];
    for (const r of results) {
      const url = String(r.url ?? '');
      if (!url || blocked(url)) continue;
      hits.push({
        engine: 'exa',
        rank: hits.length + 1,
        title: String(r.title ?? ''),
        url,
        snippet: String(r.text ?? '').slice(0, 1_200),
      });
    }
    return {
      engine: 'exa',
      queryId,
      hits,
      ms: Date.now() - started,
      meta: { resolvedSearchType: body.resolvedSearchType ?? '', costDollars: body.costDollars ?? null },
    };
  } catch (e) {
    return {
      engine: 'exa',
      queryId,
      hits: [],
      ms: Date.now() - started,
      error: String(e).slice(0, 300),
    };
  }
}

// ---- Firecrawl ----

const FIRECRAWL_BASE = 'https://api.firecrawl.dev/v2';

function firecrawlHeaders(): Record<string, string> {
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${requireKey('FIRECRAWL_API_KEY')}`,
  };
}

/** Search only — no `scrapeOptions`. Scraping every result would be a
 *  different (and far more expensive) product than the other two arms, and
 *  would confound ranking with extraction. This measures the ranking; the
 *  fetch phase measures the extraction, which is where Firecrawl's real
 *  claim lies. Its `description` field is the result snippet. */
export async function firecrawlSearch(
  queryId: string,
  query: string,
  opts: { limit?: number } = {},
): Promise<SearchRun> {
  const started = Date.now();
  try {
    const res = await fetch(`${FIRECRAWL_BASE}/search`, {
      method: 'POST',
      headers: firecrawlHeaders(),
      body: JSON.stringify({ query, limit: opts.limit ?? 10 }),
    });
    const body = (await res.json()) as Record<string, unknown>;
    if (!res.ok || body.success === false) {
      return {
        engine: 'firecrawl',
        queryId,
        hits: [],
        ms: Date.now() - started,
        error: `HTTP ${res.status}: ${JSON.stringify(body.error ?? body).slice(0, 300)}`,
      };
    }
    const data = (body.data ?? {}) as Record<string, unknown>;
    const web = (data.web ?? []) as Record<string, unknown>[];
    const hits: SearchHit[] = [];
    for (const r of web) {
      const url = String(r.url ?? '');
      // Glassdoor has no request-level exclusion on this endpoint, so the
      // same policy is enforced here rather than trusted to a prompt.
      if (!url || blocked(url)) continue;
      hits.push({
        engine: 'firecrawl',
        rank: hits.length + 1,
        title: String(r.title ?? ''),
        url,
        snippet: String(r.description ?? '').slice(0, 1_200),
      });
    }
    return { engine: 'firecrawl', queryId, hits, ms: Date.now() - started };
  } catch (e) {
    return {
      engine: 'firecrawl',
      queryId,
      hits: [],
      ms: Date.now() - started,
      error: String(e).slice(0, 300),
    };
  }
}

// ---- fetch / extractability ----

export interface FetchProbe {
  engine: Engine;
  url: string;
  ok: boolean;
  chars: number;
  /** The engine's own failure code, kept verbatim — planner.ts already maps
   *  Anthropic's codes to candidate-facing prose in FETCH_REASONS, and the
   *  other two would need the same treatment to be shippable. */
  reason?: string;
  ms: number;
}

/** web_fetch only fetches URLs already present in the conversation, so the
 *  URL is stated in the user turn. */
export async function anthropicFetch(client: Anthropic, url: string): Promise<FetchProbe> {
  const started = Date.now();
  try {
    const msg = await client.messages.create({
      model: 'claude-opus-5',
      max_tokens: 2_000,
      output_config: { effort: 'low' },
      tools: [
        {
          type: 'web_fetch_20260209',
          name: 'web_fetch',
          max_uses: 1,
          blocked_domains: BLOCKED_DOMAINS,
        } as never,
      ],
      messages: [{ role: 'user', content: `Fetch this page then reply "done": ${url}` }],
    });
    for (const block of msg.content as unknown as Record<string, unknown>[]) {
      if (block.type !== 'web_fetch_tool_result') continue;
      const c = block.content as Record<string, unknown> | undefined;
      const code = typeof c?.error_code === 'string' ? c.error_code : '';
      if (code) {
        return { engine: 'anthropic', url, ok: false, chars: 0, reason: code, ms: Date.now() - started };
      }
      const doc = c?.content as Record<string, unknown> | undefined;
      const text = typeof doc?.text === 'string' ? doc.text : JSON.stringify(doc ?? {});
      return { engine: 'anthropic', url, ok: true, chars: text.length, ms: Date.now() - started };
    }
    return {
      engine: 'anthropic',
      url,
      ok: false,
      chars: 0,
      reason: 'no_fetch_attempted',
      ms: Date.now() - started,
    };
  } catch (e) {
    return {
      engine: 'anthropic',
      url,
      ok: false,
      chars: 0,
      reason: String(e).slice(0, 120),
      ms: Date.now() - started,
    };
  }
}

export async function exaFetch(url: string): Promise<FetchProbe> {
  const started = Date.now();
  try {
    const res = await fetch(`${EXA_BASE}/contents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': requireKey('EXA_API_KEY') },
      body: JSON.stringify({ urls: [url], text: true }),
    });
    const body = (await res.json()) as Record<string, unknown>;
    if (!res.ok) {
      return { engine: 'exa', url, ok: false, chars: 0, reason: `http_${res.status}`, ms: Date.now() - started };
    }
    const results = (body.results ?? []) as Record<string, unknown>[];
    const text = String(results[0]?.text ?? '');
    // Exa reports per-URL failures in a `statuses` array rather than a
    // non-2xx, so an empty body is a failure regardless of how it is framed.
    if (!text.trim()) {
      const statuses = JSON.stringify(body.statuses ?? body.error ?? '').slice(0, 120);
      return { engine: 'exa', url, ok: false, chars: 0, reason: statuses || 'empty_text', ms: Date.now() - started };
    }
    return { engine: 'exa', url, ok: true, chars: text.length, ms: Date.now() - started };
  } catch (e) {
    return { engine: 'exa', url, ok: false, chars: 0, reason: String(e).slice(0, 120), ms: Date.now() - started };
  }
}

export async function firecrawlFetch(url: string): Promise<FetchProbe> {
  const started = Date.now();
  try {
    const res = await fetch(`${FIRECRAWL_BASE}/scrape`, {
      method: 'POST',
      headers: firecrawlHeaders(),
      body: JSON.stringify({ url, formats: ['markdown'], onlyMainContent: true }),
    });
    const body = (await res.json()) as Record<string, unknown>;
    const data = (body.data ?? {}) as Record<string, unknown>;
    const md = String(data.markdown ?? '');
    if (!res.ok || body.success === false || !md.trim()) {
      const reason = String(body.error ?? body.details ?? `http_${res.status}`).slice(0, 120);
      return { engine: 'firecrawl', url, ok: false, chars: 0, reason, ms: Date.now() - started };
    }
    return { engine: 'firecrawl', url, ok: true, chars: md.length, ms: Date.now() - started };
  } catch (e) {
    return { engine: 'firecrawl', url, ok: false, chars: 0, reason: String(e).slice(0, 120), ms: Date.now() - started };
  }
}

export function searchFor(engine: Engine, client: Anthropic, queryId: string, query: string): Promise<SearchRun> {
  if (engine === 'anthropic') return anthropicSearch(client, queryId, query);
  if (engine === 'exa') return exaSearch(queryId, query);
  return firecrawlSearch(queryId, query);
}

export function fetchFor(engine: Engine, client: Anthropic, url: string): Promise<FetchProbe> {
  if (engine === 'anthropic') return anthropicFetch(client, url);
  if (engine === 'exa') return exaFetch(url);
  return firecrawlFetch(url);
}
