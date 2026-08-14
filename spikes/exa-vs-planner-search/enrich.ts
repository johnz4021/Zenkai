/**
 * Neutral text enrichment — the fix for the snippet confound.
 *
 *   every unique URL ──► exa /contents ──(empty?)──► firecrawl /scrape
 *                              │
 *                     out/contents.json  {url: text}
 *                              │
 *                    judge grades EVERY url from THIS text
 *
 * Why this exists. The first run measured a +22pp usable@5 gap for Exa over
 * `web_search_20260209`, and the gap was an artifact of the harness, not of
 * ranking. Anthropic's web_search returns `encrypted_content` — readable by
 * the model, opaque to us — so its results reached the judge as bare
 * title+URL, while Exa supplied 1,200 characters of indexed text and
 * Firecrawl a ~200-character description. The judge is instructed not to
 * assume content it cannot see, so "no snippet" collapsed almost
 * mechanically to "not usable":
 *
 *     anthropic URLs judged WITH text     12/30  (40%)
 *     anthropic URLs judged WITHOUT text   0/56  ( 0%)
 *     exa       URLs judged WITH text     34/90  (38%)
 *
 * 40% vs 38% is no gap at all. The measured difference was snippet
 * availability, and three different snippet lengths across three engines
 * would have kept confounding it even after backfilling only the missing
 * ones. So every URL — including ones that already had a snippet — is graded
 * from the same independently-fetched text. What varies across arms is then
 * exactly one thing: WHICH URLS EACH ENGINE RETURNED. That is the ranking
 * question the experiment is actually asking.
 *
 * Exa first because it is ~115ms and cheap; Firecrawl as fallback because it
 * reads pages Exa returns empty for (teamblind: 6.1k vs 15.4k chars). A URL
 * neither can read is judged from title+URL and flagged, so it is visible
 * rather than silently scored as unusable.
 */

import type { FetchProbe } from './engines.js';
import { exaFetch, firecrawlFetch } from './engines.js';

export interface Contents {
  /** url -> extracted text ('' when both extractors failed). */
  text: Record<string, string>;
  /** url -> which extractor produced it, for the report's caveat section. */
  source: Record<string, 'exa' | 'firecrawl' | 'none'>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Serial with a small delay: Firecrawl 429s under this harness's own
 *  concurrency, and a rate-limit failure would masquerade as an unreadable
 *  page (it did, on the first fetch-phase run — three URLs came back
 *  "Rate limit exceeded" and all three succeeded when serialized). */
export async function enrich(
  urls: string[],
  opts: { maxChars?: number; onProgress?: (done: number, total: number, url: string, via: string) => void } = {},
): Promise<Contents> {
  const maxChars = opts.maxChars ?? 4_000;
  const out: Contents = { text: {}, source: {} };
  let done = 0;
  for (const url of urls) {
    let probe: FetchProbe = await exaFetch(url);
    let via: 'exa' | 'firecrawl' | 'none' = 'exa';
    let text = '';
    if (probe.ok && probe.chars > 200) {
      text = await exaText(url);
    }
    if (text.trim().length < 200) {
      await sleep(1_200);
      probe = await firecrawlFetch(url);
      if (probe.ok) {
        const md = await firecrawlText(url);
        if (md.trim().length > text.trim().length) {
          text = md;
          via = 'firecrawl';
        }
      }
    }
    if (!text.trim()) via = 'none';
    out.text[url] = text.replace(/\s+/g, ' ').slice(0, maxChars);
    out.source[url] = via;
    done++;
    opts.onProgress?.(done, urls.length, url, via);
    await sleep(250);
  }
  return out;
}

// The probe helpers above report only a length, so refetch the body once the
// extractor is chosen. Kept separate so engines.ts stays a pure probe surface.

async function exaText(url: string): Promise<string> {
  try {
    const res = await fetch('https://api.exa.ai/contents', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': process.env.EXA_API_KEY! },
      body: JSON.stringify({ urls: [url], text: true }),
    });
    const body = (await res.json()) as { results?: { text?: string }[] };
    return String(body.results?.[0]?.text ?? '');
  } catch {
    return '';
  }
}

async function firecrawlText(url: string): Promise<string> {
  try {
    const res = await fetch('https://api.firecrawl.dev/v2/scrape', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${process.env.FIRECRAWL_API_KEY!}`,
      },
      body: JSON.stringify({ url, formats: ['markdown'], onlyMainContent: true }),
    });
    const body = (await res.json()) as { data?: { markdown?: string } };
    return String(body.data?.markdown ?? '');
  } catch {
    return '';
  }
}
