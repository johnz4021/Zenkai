/**
 * Judge reliability — does the metric survive its own noise?
 *
 *   verdicts.json (pass A) ─┐
 *   re-judge, same order ───┼──► per-URL agreement on usable / tier / spec
 *   re-judge, reversed ─────┘         │
 *                                     ▼
 *                    usable@5 per engine recomputed from EACH pass
 *                                     │
 *                          does the RANKING flip between passes?
 *
 * Why this exists, and why it is not optional. The headline gap in this spike
 * is 49/70 against 48/70 — ONE PAGE. A single-rater LLM judge with no measured
 * agreement cannot support a claim that fine, and reporting one without this
 * number is how a bake-off launders sampling noise into a recommendation.
 * The experiment already changed its answer twice under protocol edits; that
 * is direct evidence the metric is sensitive, and sensitivity is exactly what
 * has gone unquantified.
 *
 * Two extra passes, because two different things can move a verdict:
 *   - pass B (same order)      → pure model sampling variance
 *   - pass C (reversed order)  → position effects in a ~30-item list
 * The presentation order is a fixed function of the URL, so it is CONTROLLED
 * across passes but never validated as harmless. Reversing tests that.
 *
 * The number that decides whether anything in the report means anything is
 * not agreement itself — it is whether the engine RANKING is stable across
 * passes. If usable@5 reorders when only the judge is resampled, then every
 * between-engine claim in this spike is noise and should be withdrawn.
 *
 * Usage:  npx tsx spikes/exa-vs-planner-search/reliability.ts
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { NEEDS } from './queries.js';
import { ENGINES, type Engine, type SearchRun } from './engines.js';
import { judgeNeed, type Verdict } from './judge.js';
import { loadKeys, requireKey } from './env.js';
import { parseRunId } from './report.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'out');
loadKeys(path.resolve(HERE, '../../.env'));

type ByNeed = Record<string, Verdict[]>;

function read<T>(name: string): T {
  const f = path.join(OUT, name);
  if (!existsSync(f)) throw new Error(`missing ${f} — run the main harness first`);
  return JSON.parse(readFileSync(f, 'utf8')) as T;
}

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

/** usable@5 per engine, recomputed from one pass's verdicts. This is the
 *  quantity the whole report rests on, so it is what gets compared. */
function usableAt5(runs: SearchRun[], byNeed: ByNeed): Record<Engine, { hit: number; slots: number }> {
  const acc = Object.fromEntries(ENGINES.map((e) => [e, { hit: 0, slots: 0 }])) as Record<
    Engine,
    { hit: number; slots: number }
  >;
  for (const run of runs) {
    const { need } = parseRunId(run.queryId);
    const verdicts = new Map((byNeed[need] ?? []).map((v) => [v.url, v]));
    for (const hit of run.hits) {
      if (hit.rank > 5) continue;
      const v = verdicts.get(hit.url);
      if (!v) continue;
      acc[run.engine]!.slots++;
      if (v.usable) acc[run.engine]!.hit++;
    }
  }
  return acc;
}

/** Cohen's kappa for the binary `usable` call — raw agreement alone is
 *  misleading when one class dominates. */
function kappa(pairs: [boolean, boolean][]): number {
  const n = pairs.length;
  if (!n) return NaN;
  let both = 0, neither = 0, aOnly = 0, bOnly = 0;
  for (const [a, b] of pairs) {
    if (a && b) both++;
    else if (!a && !b) neither++;
    else if (a) aOnly++;
    else bOnly++;
  }
  const po = (both + neither) / n;
  const pA = (both + aOnly) / n;
  const pB = (both + bOnly) / n;
  const pe = pA * pB + (1 - pA) * (1 - pB);
  return pe === 1 ? NaN : (po - pe) / (1 - pe);
}

function compare(label: string, a: ByNeed, b: ByNeed, runs: SearchRun[]): string[] {
  const lines: string[] = [];
  const usablePairs: [boolean, boolean][] = [];
  let tierSame = 0, tierTotal = 0, specSame = 0, specAbs = 0;

  for (const need of NEEDS) {
    const A = new Map((a[need.id] ?? []).map((v) => [v.url, v]));
    for (const v of b[need.id] ?? []) {
      const prev = A.get(v.url);
      if (!prev) continue;
      usablePairs.push([prev.usable, v.usable]);
      tierTotal++;
      if (prev.tier === v.tier) tierSame++;
      if (prev.specificity === v.specificity) specSame++;
      specAbs += Math.abs(prev.specificity - v.specificity);
    }
  }
  const n = usablePairs.length;
  const agree = usablePairs.filter(([x, y]) => x === y).length;
  lines.push(
    `${label}  n=${n}` +
      `  usable agree ${((100 * agree) / n).toFixed(0)}% (kappa ${kappa(usablePairs).toFixed(2)})` +
      `  tier agree ${((100 * tierSame) / tierTotal).toFixed(0)}%` +
      `  spec exact ${((100 * specSame) / tierTotal).toFixed(0)}% (mean |Δ| ${(specAbs / tierTotal).toFixed(2)})`,
  );
  const u = usableAt5(runs, b);
  lines.push(
    `${' '.repeat(label.length)}  usable@5 → ` +
      ENGINES.map((e) => `${e} ${((100 * u[e]!.hit) / u[e]!.slots).toFixed(0)}% (${u[e]!.hit}/${u[e]!.slots})`).join('  '),
  );
  return lines;
}

async function main(): Promise<void> {
  requireKey('ANTHROPIC_API_KEY');
  const client = new Anthropic({ timeout: 300_000, maxRetries: 2 });
  const search = read<{ runs: SearchRun[] }>('search.json');
  const contents = read<{ text: Record<string, string> }>('contents.json');
  const passA = read<{ byQuery: ByNeed }>('verdicts.json').byQuery;

  const hitsFor = (needId: string) =>
    search.runs.filter((r) => r.queryId.startsWith(`${needId}::`)).flatMap((r) => r.hits);

  for (const [name, reverse] of [
    ['B (resample, same order)', false],
    ['C (resample, reversed order)', true],
  ] as const) {
    const file = `verdicts-${reverse ? 'C' : 'B'}.json`;
    if (existsSync(path.join(OUT, file))) {
      console.log(`[pass ${name}] ${file} exists — reusing`);
      continue;
    }
    console.log(`[pass ${name}] judging ${NEEDS.length} needs`);
    const byNeed: ByNeed = {};
    const res = await pool(NEEDS, 3, async (need) => {
      const v = await judgeNeed(client, need, hitsFor(need.id), contents.text, { reverse });
      console.log(`  ${need.id.padEnd(16)} ${String(v.length).padStart(3)} graded`);
      return [need.id, v] as const;
    });
    for (const [id, v] of res) byNeed[id] = v;
    writeFileSync(path.join(OUT, file), JSON.stringify({ byQuery: byNeed }, null, 2));
  }

  const passB = read<{ byQuery: ByNeed }>('verdicts-B.json').byQuery;
  const passC = read<{ byQuery: ByNeed }>('verdicts-C.json').byQuery;

  const out: string[] = ['', '=== JUDGE RELIABILITY ===', ''];
  const uA = usableAt5(search.runs, passA);
  out.push(
    `pass A (reported)          usable@5 → ` +
      ENGINES.map((e) => `${e} ${((100 * uA[e]!.hit) / uA[e]!.slots).toFixed(0)}% (${uA[e]!.hit}/${uA[e]!.slots})`).join('  '),
    '',
  );
  out.push(...compare('A vs B (sampling)', passA, passB, search.runs), '');
  out.push(...compare('A vs C (order)   ', passA, passC, search.runs), '');
  out.push(...compare('B vs C           ', passB, passC, search.runs), '');

  // The decision: does the engine ranking survive resampling the judge?
  const rank = (u: Record<Engine, { hit: number; slots: number }>) =>
    [...ENGINES].sort((x, y) => u[y]!.hit / u[y]!.slots - u[x]!.hit / u[x]!.slots).join(' > ');
  out.push(
    '',
    'engine ranking by usable@5, per pass:',
    `  A: ${rank(uA)}`,
    `  B: ${rank(usableAt5(search.runs, passB))}`,
    `  C: ${rank(usableAt5(search.runs, passC))}`,
    '',
  );
  const text = out.join('\n');
  writeFileSync(path.join(OUT, 'reliability.txt'), text);
  console.log(text);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
