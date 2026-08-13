/**
 * The experiment runner.
 *
 *   search ──► out/search.json ──► judge ──► out/verdicts.json ──┐
 *                    │                                            ├──► report.md
 *                    └──────────► fetch ──► out/fetch.json ──────┘
 *
 * Phases are separate subcommands writing to disk between them, for the same
 * reason the rest of this repo keeps authoritative state on disk: the search
 * phase costs real money and real minutes, and re-running the judge — the
 * part most likely to need a rubric tweak — must not re-run retrieval.
 * Deleting a file in out/ is how you re-run one phase.
 *
 * Usage (from repo root; .env supplies all three keys):
 *   npx tsx spikes/exa-vs-planner-search/run.ts all
 *   npx tsx spikes/exa-vs-planner-search/run.ts judge    # just re-judge
 *   npx tsx spikes/exa-vs-planner-search/run.ts report
 *
 * out/ is gitignored (`spikes/ ** /out/`), so raw retrieval dumps never land
 * in git.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { NEEDS, QUERIES, type Query } from './queries.js';
import { ENGINES, fetchFor, searchFor, type Engine, type FetchProbe, type SearchRun } from './engines.js';
import { judgeNeed, type Verdict } from './judge.js';
import { enrich, type Contents } from './enrich.js';
import { renderReport } from './report.js';
import { loadKeys, requireKey } from './env.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const OUT = path.join(HERE, 'out');

loadKeys(path.join(ROOT, '.env'));

function read<T>(name: string): T | null {
  const f = path.join(OUT, name);
  return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as T) : null;
}
function write(name: string, data: unknown): void {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(path.join(OUT, name), JSON.stringify(data, null, 2));
}

/** Small concurrency cap — enough to keep the run quick, low enough to stay
 *  clear of Exa/Firecrawl per-second limits and the Opus bucket. */
async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]!);
      }
    }),
  );
  return out;
}

// ---- phase 1: retrieval ----

interface SearchArtifact {
  at: string;
  runs: SearchRun[];
}

/** Incremental: only (query, engine) pairs not already on disk are issued.
 *  Adding the natural-language arm must not re-pay for the keyword arm — and
 *  re-running it would also silently re-roll a live index underneath a
 *  comparison whose whole point is that only the query wording changed. */
async function phaseSearch(client: Anthropic): Promise<SearchArtifact> {
  const existing = read<SearchArtifact>('search.json') ?? { at: new Date().toISOString(), runs: [] };
  const have = new Set(existing.runs.map((r) => `${r.queryId}|${r.engine}`));
  const jobs: { q: Query; engine: Engine }[] = QUERIES.flatMap((q) =>
    ENGINES.map((engine) => ({ q, engine })),
  ).filter(({ q, engine }) => !have.has(`${q.runId}|${engine}`));

  if (jobs.length === 0) {
    console.log(`[search] all ${existing.runs.length} runs present — skipping. Delete out/search.json to re-run.`);
    return existing;
  }
  console.log(`[search] ${existing.runs.length} runs on disk, issuing ${jobs.length} missing`);
  const fresh = await pool(jobs, 4, async ({ q, engine }) => {
    const run = await searchFor(engine, client, q.runId, q.q);
    console.log(
      `  ${engine.padEnd(10)} ${q.runId.padEnd(26)} ${String(run.hits.length).padStart(2)} hits ${String(run.ms).padStart(6)}ms` +
        (run.error ? `  ERROR ${run.error.slice(0, 90)}` : ''),
    );
    return run;
  });
  const artifact = { at: new Date().toISOString(), runs: [...existing.runs, ...fresh] };
  write('search.json', artifact);
  return artifact;
}

// ---- phase 1b: neutral text enrichment (see enrich.ts for why) ----

async function phaseEnrich(search: SearchArtifact): Promise<Contents> {
  const existing = read<Contents>('contents.json') ?? { text: {}, source: {} };
  const all = [...new Set(search.runs.flatMap((r) => r.hits.map((h) => h.url)))].filter(Boolean);
  // Incremental: a second query form surfaces new URLs, and re-fetching the
  // ones already graded would churn text under settled verdicts.
  const urls = all.filter((u) => !(u in existing.text));
  if (urls.length === 0) {
    console.log(`[enrich] all ${all.length} urls already have text — skipping.`);
    return existing;
  }
  console.log(
    `[enrich] ${Object.keys(existing.text).length} urls on disk, fetching ${urls.length} new (serial; this is the slow phase)`,
  );
  const fresh = await enrich(urls, {
    onProgress: (done, total, url, via) => {
      if (done % 10 === 0 || via === 'none') {
        console.log(`  ${String(done).padStart(3)}/${total}  ${via.padEnd(9)} ${url.slice(0, 80)}`);
      }
    },
  });
  const contents: Contents = {
    text: { ...existing.text, ...fresh.text },
    source: { ...existing.source, ...fresh.source },
  };
  const unread = Object.values(fresh.source).filter((s) => s === 'none').length;
  console.log(`[enrich] done — ${unread}/${urls.length} of the new urls unreadable by both extractors`);
  write('contents.json', contents);
  return contents;
}

// ---- phase 2: blind judging ----

interface VerdictArtifact {
  at: string;
  byQuery: Record<string, Verdict[]>;
}

async function phaseJudge(
  client: Anthropic,
  search: SearchArtifact,
  contents: Contents,
): Promise<VerdictArtifact> {
  const existing = read<VerdictArtifact>('verdicts.json');
  if (existing) {
    console.log('[judge] out/verdicts.json exists — skipping. Delete it to re-judge.');
    return existing;
  }
  console.log(`[judge] ${NEEDS.length} needs (union of ${QUERIES.length} runs), blind, graded on neutral text`);
  const byQuery: Record<string, Verdict[]> = {};
  const results = await pool(NEEDS, 3, async (need) => {
    // Union across BOTH query forms and all engines, so each page is graded
    // exactly once per information need.
    const hits = search.runs
      .filter((r) => r.queryId.startsWith(`${need.id}::`))
      .flatMap((r) => r.hits);
    const verdicts = await judgeNeed(client, need, hits, contents.text);
    console.log(`  ${need.id.padEnd(16)} ${String(verdicts.length).padStart(3)} graded`);
    return [need.id, verdicts] as const;
  });
  for (const [id, v] of results) byQuery[id] = v;
  const artifact = { at: new Date().toISOString(), byQuery };
  write('verdicts.json', artifact);
  return artifact;
}

// ---- phase 3: extractability ----

interface FetchArtifact {
  at: string;
  probes: FetchProbe[];
}

/** Probe the URLs that MATTER: the pages the judge called official or
 *  firsthand. Those are what the evidence hierarchy wants to read and the
 *  ones most likely to sit behind a refusal. Probing aggregator SEO pages
 *  would inflate every engine's success rate with pages nobody needs.
 *  One URL per host so a single chatty domain cannot dominate the rate. */
async function phaseFetch(
  client: Anthropic,
  search: SearchArtifact,
  verdicts: VerdictArtifact,
): Promise<FetchArtifact> {
  const existing = read<FetchArtifact>('fetch.json');
  if (existing) {
    console.log('[fetch] out/fetch.json exists — skipping. Delete it to re-probe.');
    return existing;
  }
  const tierOf = new Map<string, string>();
  for (const vs of Object.values(verdicts.byQuery)) {
    for (const v of vs) tierOf.set(v.url, v.tier);
  }
  const allUrls = [...new Set(search.runs.flatMap((r) => r.hits.map((h) => h.url)))].filter(Boolean);
  const wanted = allUrls.filter((u) => {
    const t = tierOf.get(u);
    return t === 'official' || t === 'firsthand';
  });

  const seenHost = new Set<string>();
  const urls: string[] = [];
  for (const u of wanted) {
    let host = '';
    try {
      host = new URL(u).hostname.replace(/^www\./, '');
    } catch {
      continue;
    }
    if (seenHost.has(host)) continue;
    seenHost.add(host);
    urls.push(u);
    if (urls.length >= 18) break;
  }

  console.log(`[fetch] probing ${urls.length} official/firsthand URLs (one per host) x ${ENGINES.length} engines`);
  const probes = await pool(urls, 3, async (url) => {
    const results = await Promise.all(ENGINES.map((e) => fetchFor(e, client, url)));
    const host = new URL(url).hostname.replace(/^www\./, '');
    console.log(
      `  ${host.padEnd(26)} ` +
        results.map((p) => `${p.engine}=${p.ok ? `ok(${p.chars})` : `FAIL(${(p.reason ?? '').slice(0, 24)})`}`).join('  '),
    );
    return results;
  });
  const artifact = { at: new Date().toISOString(), probes: probes.flat() };
  write('fetch.json', artifact);
  return artifact;
}

// ---- main ----

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? 'all';
  requireKey('ANTHROPIC_API_KEY');
  if (cmd !== 'report') {
    requireKey('EXA_API_KEY');
    requireKey('FIRECRAWL_API_KEY');
  }
  const client = new Anthropic({ timeout: 300_000, maxRetries: 2 });

  if (cmd === 'search') {
    await phaseSearch(client);
    return;
  }

  const search = await phaseSearch(client);
  if (cmd === 'enrich') {
    await phaseEnrich(search);
    return;
  }

  const contents = await phaseEnrich(search);
  if (cmd === 'judge') {
    await phaseJudge(client, search, contents);
    return;
  }

  const verdicts = await phaseJudge(client, search, contents);
  if (cmd === 'fetch') {
    await phaseFetch(client, search, verdicts);
    return;
  }

  const fetches =
    cmd === 'report'
      ? (read<FetchArtifact>('fetch.json') ?? { at: '', probes: [] })
      : await phaseFetch(client, search, verdicts);

  const md = renderReport(search.runs, verdicts.byQuery, fetches.probes);
  mkdirSync(OUT, { recursive: true });
  writeFileSync(path.join(OUT, 'report.md'), md);
  console.log('\n' + md);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
