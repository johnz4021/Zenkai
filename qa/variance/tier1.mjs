// Tier-1 variance funnel: the 30 selected adversarial briefs through the
// REAL clarifier (:3321), concurrency 3. Records everything the funnel
// decides: drafts, shapes, bindings, gaps, degradation.
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const corpus = JSON.parse(readFileSync(path.join(here, 'corpus.json'), 'utf8'));
const ranked = JSON.parse(readFileSync(path.join(here, 'ranked.json'), 'utf8'));
const byId = Object.fromEntries(corpus.map((b) => [b.id, b]));
const out = path.join(here, 'tier1-results.jsonl');
writeFileSync(out, '');

const queue = ranked.selected.map((s) => s.id).filter((id) => byId[id]);
let active = 0, done = 0;

async function runOne(id) {
  const b = byId[id];
  const t0 = Date.now();
  const row = { id, ms: 0 };
  try {
    const res = await fetch('' + (process.env.QA_APP_URL ?? 'http://localhost:3321') + '/api/practice/clarify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ description: b.description, ...(b.context ? { context: b.context } : {}) }),
      signal: AbortSignal.timeout(180_000),
    });
    row.status = res.status;
    const d = await res.json();
    row.ms = Date.now() - t0;
    row.degraded = d.degraded ?? null;
    row.error = d.error ?? null;
    row.brief = (d.brief || '').slice(0, 200);
    row.drafts = (d.drafts || []).map((x) => ({
      id: x.spec?.id,
      task: x.task ?? null,
      caps: x.spec?.capabilities,
      check: x.spec?.check,
      part_count: x.part_count ?? null,
      named: x.named_problems ?? null,
      source: x.source ? { slug: x.source.slug, parts: (x.source.parts || []).map((p) => p.slug) } : null,
      unsupported: x.unsupported ?? null,
    }));
    row.gaps = (d.gaps || []).map((g) => ({ id: g.id, status: g.status, q: (g.question || '').slice(0, 80) }));
  } catch (e) {
    row.ms = Date.now() - t0;
    row.exception = String(e).slice(0, 200);
  }
  appendFileSync(out, JSON.stringify(row) + '\n');
  done++;
  console.log(`[${done}/${queue.length}] ${id} → ${row.exception ? 'EXC' : row.status} (${row.drafts?.length ?? 0} drafts, ${Math.round(row.ms / 1000)}s)`);
}

async function pump() {
  const workers = Array.from({ length: 3 }, async () => {
    while (queue.length) {
      const id = queue.shift();
      await runOne(id);
    }
  });
  await Promise.all(workers);
  console.log('tier1 complete');
}
await pump();
