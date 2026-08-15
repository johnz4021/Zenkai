// Tier-2 variance builds: the assigned briefs through REAL generation on
// :3321, concurrency 2, with heal-layer attribution parsed from build logs.
import { existsSync, readFileSync, appendFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const W = path.resolve(here, '..', '..');
const { deriveMemoryTags } = await import(path.join(W, 'shared', 'src', 'index.ts'));

const corpus = JSON.parse(readFileSync(path.join(here, 'corpus.json'), 'utf8'));
const ranked = JSON.parse(readFileSync(path.join(here, 'ranked.json'), 'utf8'));
const tier1 = Object.fromEntries(
  readFileSync(path.join(here, 'tier1-results.jsonl'), 'utf8').trim().split('\n')
    .map((l) => JSON.parse(l)).map((r) => [r.id, r]),
);
const byId = Object.fromEntries(corpus.map((b) => [b.id, b]));
const out = path.join(here, 'tier2-results.jsonl');
writeFileSync(out, '');

const jobs = ranked.build_assignment.filter((b) => (b.venue ?? 'local') === 'local');
console.log(`${jobs.length} local builds queued`);

function specFor(draft) {
  return {
    id: draft.id,
    label: draft.id,
    capabilities: draft.caps,
    check: draft.check,
    memory_tags: deriveMemoryTags(draft.caps),
  };
}

async function build(job) {
  const t1 = tier1[job.id];
  const draft = t1?.drafts?.[0];
  const brief = byId[job.id];
  const repId = `rep-var-${job.id.slice(0, 24).replace(/[^a-z0-9-]/g, '')}`;
  const row = { id: job.id, kind: job.kind, rep: repId };
  if (!draft) {
    row.outcome = 'no-tier1-draft';
    appendFileSync(out, JSON.stringify(row) + '\n');
    return;
  }
  const body = {
    rep_id: repId,
    task: draft.task ?? undefined,
    description: brief.description.slice(0, 30_000),
    ...(brief.context ? { context: brief.context.slice(0, 200_000) } : {}),
    spec: specFor(draft),
    ...(job.kind === 'sourced' && draft.source
      ? { source_refs: (draft.source.parts?.length ? draft.source.parts : [draft.source.slug]) }
      : {}),
  };
  const t0 = Date.now();
  const res = await fetch('' + (process.env.QA_APP_URL ?? 'http://localhost:3321') + '/api/practice', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const resp = await res.json();
  if (res.status !== 200) {
    row.outcome = 'door-refused';
    row.door = { status: res.status, body: resp };
    appendFileSync(out, JSON.stringify(row) + '\n');
    console.log(`${job.id}: door ${res.status} ${JSON.stringify(resp).slice(0, 120)}`);
    return;
  }
  const dir = path.join(W, 'reps', repId, 'problem');
  // Poll to terminal state (validated / failed), 25-minute ceiling per build
  // (attempt + repair + auto-retry can stack).
  while (Date.now() - t0 < 25 * 60_000) {
    if (existsSync(path.join(dir, '.validated')) || existsSync(path.join(dir, '.failed'))) break;
    await new Promise((r) => setTimeout(r, 10_000));
  }
  row.minutes = Math.round((Date.now() - t0) / 6000) / 10;
  row.validated = existsSync(path.join(dir, '.validated'));
  row.failed = existsSync(path.join(dir, '.failed'));
  // Heal attribution from the (possibly rotated) logs.
  const logs = ['', '.1', '.2'].map((s) => `${path.join(W, 'reps', repId, 'problem')}.build${s}.log`)
    .filter(existsSync).map((p) => readFileSync(p, 'utf8')).join('\n---ROTATED---\n');
  row.heal = {
    attempts: 1 + (logs.match(/---ROTATED---/g) ?? []).length,
    repair_ran: logs.includes('[repair] one repair pass'),
    stripped: logs.includes('stripped') && logs.includes('expectation'),
    in_band: /is_error|error_max_turns/.test(logs),
    validate_failures: [...logs.matchAll(/"failures": \[([^\]]*)\]/g)].map((m) => m[1].slice(0, 160)),
  };
  row.outcome = row.validated ? 'ready' : row.failed ? 'failed' : 'timeout';
  appendFileSync(out, JSON.stringify(row) + '\n');
  console.log(`${job.id}: ${row.outcome} in ${row.minutes}m (attempts ${row.heal.attempts}, repair ${row.heal.repair_ran})`);
}

const queue = [...jobs];
await Promise.all(Array.from({ length: 2 }, async () => {
  while (queue.length) await build(queue.shift());
}));
console.log('tier2 local complete');
