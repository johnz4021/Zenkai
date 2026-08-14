/**
 * The report — pure over the three artifacts. No I/O, no clock, no randomness.
 *
 *   SearchRun[] + verdicts + FetchProbe[] ──► markdown tables
 *
 * The headline number is USABLE@5, not any tier count. The planner reads a
 * handful of results per turn and renders the outcome as ONE prose sentence
 * with inline links, so what matters is whether the top of the list contains
 * something that changes a round draft. An engine that returns more
 * aggregator pages has improved nothing — prompts/planner.md already tells
 * the model to grade those honestly as "thin", so extra listicles are extra
 * noise the candidate learns to distrust.
 *
 * Every table splits big-company from obscure-company rows, because the
 * stored conversations show those are two different failures: for Palantir
 * and Amazon the current path returns plausible-but-laundered guides, while
 * for a 20-person startup it returns a DIFFERENT COMPANY. A pooled average
 * would hide the second failure inside the first.
 */

import { NEEDS, FORMS, type QueryForm } from './queries.js';
import { ENGINES, type SearchRun, type FetchProbe, type Engine } from './engines.js';
import type { Verdict, Tier } from './judge.js';

const TIERS: Tier[] = ['official', 'firsthand', 'aggregator', 'wrong_entity', 'offtopic'];

function pct(n: number, d: number): string {
  return d === 0 ? '—' : `${((100 * n) / d).toFixed(0)}%`;
}
function num(n: number, digits = 2): string {
  return Number.isFinite(n) ? n.toFixed(digits) : '—';
}
function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
}
function median(xs: number[]): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((p, q) => p - q);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}
function host(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

interface Row {
  hits: number;
  usable: number;
  usableAt5: number;
  at5: number;
  spec: number[];
  tiers: Record<Tier, number>;
  ms: number[];
}

function emptyRow(): Row {
  return {
    hits: 0,
    usable: 0,
    usableAt5: 0,
    at5: 0,
    spec: [],
    tiers: { official: 0, firsthand: 0, aggregator: 0, wrong_entity: 0, offtopic: 0 },
    ms: [],
  };
}

/** Split a runId back into its need and query form. */
export function parseRunId(runId: string): { need: string; form: QueryForm } {
  const [need, form] = runId.split('::');
  return { need: need ?? runId, form: (form as QueryForm) ?? 'keyword' };
}

function tally(
  runs: SearchRun[],
  byQuery: Record<string, Verdict[]>,
  keep: (needId: string) => boolean,
  form?: QueryForm,
): Record<Engine, Row> {
  const rows = Object.fromEntries(ENGINES.map((e) => [e, emptyRow()])) as Record<Engine, Row>;
  for (const run of runs) {
    const { need, form: runForm } = parseRunId(run.queryId);
    if (!keep(need)) continue;
    if (form && runForm !== form) continue;
    const verdicts = new Map((byQuery[need] ?? []).map((v) => [v.url, v]));
    const row = rows[run.engine];
    if (!row) continue;
    row.ms.push(run.ms);
    for (const hit of run.hits) {
      const v = verdicts.get(hit.url);
      if (!v) continue;
      row.hits++;
      row.tiers[v.tier]++;
      row.spec.push(v.specificity);
      if (v.usable) row.usable++;
      if (hit.rank <= 5) {
        row.at5++;
        if (v.usable) row.usableAt5++;
      }
    }
  }
  return rows;
}

/** The 2x3 that answers "is this about engines or about phrasing?".
 *
 *  The keyword form is what planner.ts emits today — lexical, quoted, stacked
 *  nouns, written for a keyword index. The natural form states the same need
 *  as a description of the page being sought, which is what neural retrieval
 *  is built for. Same needs, same judge, same neutral text; only the wording
 *  of the query changes. If an engine's ranking moves with the form, the
 *  earlier single-form result was measuring the PROMPT, not the ENGINE. */
function formMatrix(
  runs: SearchRun[],
  byQuery: Record<string, Verdict[]>,
  obscure: Set<string>,
): string {
  const lines = [
    '### usable@5 by query form — the fair-fight table',
    '',
    "`keyword` is the phrasing planner.ts ships today (written for a keyword index). `natural` states the same need as a description of the wanted page (what neural retrieval expects). Nothing else differs.",
    '',
    `| segment | form | ${ENGINES.join(' | ')} |`,
    `| --- | --- | ${ENGINES.map(() => '---').join(' | ')} |`,
  ];
  const segments: [string, (id: string) => boolean][] = [
    ['all needs', () => true],
    ['big companies', (id) => !obscure.has(id)],
    ['obscure (Phia)', (id) => obscure.has(id)],
  ];
  for (const [label, keep] of segments) {
    for (const form of FORMS) {
      const rows = tally(runs, byQuery, keep, form);
      const cells = ENGINES.map((e) => {
        const r = rows[e]!;
        return `${pct(r.usableAt5, r.at5)} <span title="${r.usableAt5}/${r.at5}">(${r.usableAt5}/${r.at5})</span>`;
      });
      lines.push(`| ${form === FORMS[0] ? label : ''} | \`${form}\` | ${cells.join(' | ')} |`);
    }
  }
  lines.push('');

  // The delta each engine gains (or loses) from the rewrite, pooled.
  lines.push(`| rewrite effect (all needs) | ${ENGINES.join(' | ')} |`, `| --- | ${ENGINES.map(() => '---').join(' | ')} |`);
  const kw = tally(runs, byQuery, () => true, 'keyword');
  const nat = tally(runs, byQuery, () => true, 'natural');
  const deltas = ENGINES.map((e) => {
    const a = kw[e]!;
    const b = nat[e]!;
    const ra = a.at5 ? (100 * a.usableAt5) / a.at5 : NaN;
    const rb = b.at5 ? (100 * b.usableAt5) / b.at5 : NaN;
    if (!Number.isFinite(ra) || !Number.isFinite(rb)) return '—';
    const d = rb - ra;
    return `${d >= 0 ? '+' : ''}${d.toFixed(0)}pp`;
  });
  lines.push(`| natural − keyword | ${deltas.join(' | ')} |`, '');
  return lines.join('\n');
}

function scoreTable(title: string, rows: Record<Engine, Row>, baseline: Engine = 'anthropic'): string {
  const head = `| metric | ${ENGINES.map((e) => (e === baseline ? `${e} *(current)*` : e)).join(' | ')} |`;
  const sep = `| --- | ${ENGINES.map(() => '---').join(' | ')} |`;
  const lines = [`### ${title}`, '', head, sep];

  const cell = (fn: (r: Row) => string) => ENGINES.map((e) => fn(rows[e]!)).join(' | ');

  lines.push(`| **usable@5** | ${cell((r) => `${r.usableAt5}/${r.at5} (${pct(r.usableAt5, r.at5)})`)} |`);
  const base = rows[baseline]!;
  const baseRate = base.at5 ? (100 * base.usableAt5) / base.at5 : NaN;
  lines.push(
    `| ↳ vs current | ${ENGINES.map((e) => {
      if (e === baseline) return '—';
      const r = rows[e]!;
      const rate = r.at5 ? (100 * r.usableAt5) / r.at5 : NaN;
      if (!Number.isFinite(rate) || !Number.isFinite(baseRate)) return '—';
      const d = rate - baseRate;
      return `${d >= 0 ? '+' : ''}${d.toFixed(0)}pp`;
    }).join(' | ')} |`,
  );
  lines.push(`| usable@all | ${cell((r) => `${r.usable}/${r.hits} (${pct(r.usable, r.hits)})`)} |`);
  lines.push(`| mean specificity (0-3) | ${cell((r) => num(mean(r.spec)))} |`);
  for (const t of TIERS) {
    const label = t === 'wrong_entity' ? '**wrong_entity**' : t;
    lines.push(`| ${label} | ${cell((r) => `${r.tiers[t]} (${pct(r.tiers[t], r.hits)})`)} |`);
  }
  lines.push(`| results returned | ${cell((r) => String(r.hits))} |`);
  lines.push(`| median latency | ${cell((r) => `${num(median(r.ms), 0)}ms`)} |`);
  lines.push('');
  return lines.join('\n');
}

function overlapTable(runs: SearchRun[]): string {
  const pairs: [Engine, Engine][] = [];
  for (let i = 0; i < ENGINES.length; i++) {
    for (let j = i + 1; j < ENGINES.length; j++) pairs.push([ENGINES[i]!, ENGINES[j]!]);
  }
  const lines = [
    '### Result overlap (Jaccard on URLs)',
    '',
    'Low overlap means the engines are genuinely looking at different corpora, not re-ranking the same one.',
    '',
    `| query | ${pairs.map(([a, b]) => `${a}∩${b}`).join(' | ')} |`,
    `| --- | ${pairs.map(() => '---').join(' | ')} |`,
  ];
  const urlsFor = (needId: string, e: Engine) =>
    new Set(
      runs
        .filter((r) => parseRunId(r.queryId).need === needId && r.engine === e)
        .flatMap((r) => r.hits.map((h) => h.url)),
    );
  for (const q of NEEDS) {
    const cells = pairs.map(([a, b]) => {
      const A = urlsFor(q.id, a);
      const B = urlsFor(q.id, b);
      const shared = [...A].filter((u) => B.has(u)).length;
      const union = new Set([...A, ...B]).size;
      return union ? `${(shared / union).toFixed(2)} (${shared})` : '—';
    });
    lines.push(`| ${q.id} | ${cells.join(' | ')} |`);
  }
  lines.push('');
  return lines.join('\n');
}

/** The pages only one engine found AND the judge called usable. This is the
 *  concrete answer to "what would we actually gain", as opposed to a rate. */
function uniqueWinsTable(runs: SearchRun[], byQuery: Record<string, Verdict[]>): string {
  const lines = [
    '### Exclusive usable finds',
    '',
    'Pages the judge marked `usable` that **only one engine** returned. This is the concrete gain, not a rate.',
    '',
    '| engine | tier | spec | query | url | why |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  let any = false;
  for (const q of NEEDS) {
    const verdicts = new Map((byQuery[q.id] ?? []).map((v) => [v.url, v]));
    const byEngine = new Map<Engine, Set<string>>();
    for (const e of ENGINES) {
      byEngine.set(
        e,
        new Set(
          runs
            .filter((r) => parseRunId(r.queryId).need === q.id && r.engine === e)
            .flatMap((r) => r.hits.map((h) => h.url)),
        ),
      );
    }
    for (const e of ENGINES) {
      for (const url of byEngine.get(e)!) {
        const others = ENGINES.filter((x) => x !== e).some((x) => byEngine.get(x)!.has(url));
        if (others) continue;
        const v = verdicts.get(url);
        if (!v?.usable) continue;
        any = true;
        lines.push(`| ${e} | ${v.tier} | ${v.specificity} | ${q.id} | ${host(url)} | ${v.why.replace(/\|/g, '/')} |`);
      }
    }
  }
  if (!any) lines.push('| — | | | | _no exclusive usable finds_ | |');
  lines.push('');
  return lines.join('\n');
}

function fetchTable(probes: FetchProbe[]): string {
  if (probes.length === 0) return '### Extractability\n\n_(fetch phase not run)_\n';
  const lines = [
    '### Extractability — can the page actually be read?',
    '',
    'Search rank is worthless if the page cannot be opened. `planner.ts` already renders a "paste it instead" nudge for these failures.',
    '',
  ];
  for (const eng of ENGINES) {
    const p = probes.filter((x) => x.engine === eng);
    const ok = p.filter((x) => x.ok);
    lines.push(
      `- **${eng}**: ${ok.length}/${p.length} readable (${pct(ok.length, p.length)}) · median ${num(median(ok.map((x) => x.chars)), 0)} chars · median ${num(median(p.map((x) => x.ms)), 0)}ms`,
    );
  }
  lines.push('', `| host | ${ENGINES.join(' | ')} |`, `| --- | ${ENGINES.map(() => '---').join(' | ')} |`);
  for (const url of [...new Set(probes.map((p) => p.url))]) {
    const cells = ENGINES.map((e) => {
      const p = probes.find((x) => x.url === url && x.engine === e);
      if (!p) return '—';
      return p.ok ? `${p.chars} ch` : `**fail** · ${(p.reason ?? '').slice(0, 40)}`;
    });
    lines.push(`| ${host(url)} | ${cells.join(' | ')} |`);
  }
  lines.push('');
  return lines.join('\n');
}

/** The caveats a reader needs in order to not over-trust the tables. The
 *  first one is not a footnote — it is the reason the headline number is
 *  what it is, and an earlier version of this report said the opposite. */
function caveats(): string {
  return [
    '### Method caveats',
    '',
    '**The first run of this experiment produced the opposite result, and it was wrong.** ' +
      'Graded on engine-native snippets, Exa led `usable@5` by +22pp. That gap was an artifact: ' +
      "Anthropic's `web_search` returns `encrypted_content` — readable by the model, opaque to this harness — " +
      'so its results reached the judge as bare title+URL, while Exa supplied ~1,200 characters of index text. ' +
      'The judge is instructed not to assume unseen content, so "no snippet" collapsed almost mechanically to ' +
      '"not usable": Anthropic scored 12/30 (40%) on URLs that happened to have text and **0/56 on URLs that did not**. ' +
      'Every URL is now graded from the same independently-fetched text (`enrich.ts`), so the only thing that ' +
      'varies across arms is which URLs each engine returned.',
    '',
    '- **Latency is not like-for-like.** The `anthropic` figure is a full `messages.create` round-trip on ' +
      '`claude-opus-5` — the search is a server tool inside a model turn, so it includes model time. Exa and ' +
      'Firecrawl figures are bare HTTP. Read it as "what the planner turn pays", not "how fast the index is".',
    '- **Firecrawl fetch was re-probed serially.** Three URLs first failed with `Rate limit exceeded` under this ' +
      "harness's own concurrency; all three succeeded when serialized. Those are corrected, so its extraction rate " +
      'reflects capability rather than harness pressure.',
    '- **n is small.** 9 queries, 2 of them for the obscure company. Treat the big-company columns as a solid ' +
      'signal and the obscure-company columns as directional.',
    '- **The judge is a single `claude-opus-5` pass** with no second rater, so per-page calls carry noise. ' +
      'Aggregate rates are more trustworthy than any individual row.',
    '',
  ].join('\n');
}

function notes(runs: SearchRun[]): string {
  const lines: string[] = [];
  const exaTypes = runs
    .filter((r) => r.engine === 'exa')
    .map((r) => String((r.meta as Record<string, unknown> | undefined)?.resolvedSearchType ?? ''))
    .filter(Boolean);
  if (exaTypes.length) {
    const counts = new Map<string, number>();
    for (const t of exaTypes) counts.set(t, (counts.get(t) ?? 0) + 1);
    lines.push(`- Exa \`type: auto\` resolved to: ${[...counts].map(([t, n]) => `${t} x${n}`).join(', ')}`);
  }
  const bad = runs.filter((r) => r.error);
  for (const r of bad) lines.push(`- **engine failure** \`${r.engine}\` / \`${r.queryId}\`: ${r.error}`);
  if (!lines.length) return '';
  return ['### Notes', '', ...lines, ''].join('\n');
}

export function renderReport(
  runs: SearchRun[],
  byQuery: Record<string, Verdict[]>,
  probes: FetchProbe[],
): string {
  const obscure = new Set(NEEDS.filter((q) => q.obscure).map((q) => q.id));
  const graded = Object.values(byQuery).reduce((n, v) => n + v.length, 0);

  return [
    '# Exa vs Firecrawl vs `web_search_20260209` for planner research',
    '',
    `${NEEDS.length} real information needs (mined from \`targets/*/conversation.jsonl\`), each issued in ` +
      `${FORMS.length} query forms against ${ENGINES.length} engines. ${graded} gradings by \`claude-opus-5\` — ` +
      'deduped per need, shuffled on a URL hash, engine label and query wording both withheld from the judge.',
    '',
    "Grading axes are the tiers of `prompts/planner.md`'s evidence hierarchy, not generic relevance. " +
      '`usable` = a careful planner could change or confirm a round draft on this page alone.',
    '',
    formMatrix(runs, byQuery, obscure),
    scoreTable('All runs, both query forms pooled', tally(runs, byQuery, () => true)),
    scoreTable('Big companies (Palantir, Amazon — 7 needs)', tally(runs, byQuery, (id) => !obscure.has(id))),
    scoreTable('Obscure company (Phia — 2 needs)', tally(runs, byQuery, (id) => obscure.has(id))),
    uniqueWinsTable(runs, byQuery),
    overlapTable(runs),
    fetchTable(probes),
    caveats(),
    notes(runs),
  ]
    .filter(Boolean)
    .join('\n');
}
