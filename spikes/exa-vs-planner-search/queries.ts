/**
 * The query corpus — REAL needs, TWO query forms.
 *
 *   targets/<id>/conversation.jsonl ──► server_tool_use ──► keyword form (as shipped)
 *                                              │
 *                                              └──► natural form (hand-rewritten)
 *
 * Every `keyword` string below was actually issued by planner.ts against
 * `web_search_20260209` during a real intake on 2026-08. Using the live
 * distribution rather than queries written for the experiment is the point:
 * a synthetic corpus would measure how well each engine answers questions the
 * planner never asks.
 *
 * WHY A SECOND FORM EXISTS. The first version of this spike ran only the
 * keyword form and concluded Anthropic's web_search beat Exa. That conclusion
 * was confounded: those strings are keyword-engine queries — lexical hints
 * ("amazon.jobs", "official"), quoted phrases, stacked nouns — and Exa's
 * billing confirmed it ran NEURAL retrieval on all nine. Neural search is
 * built for a description of the page you want, so the comparison handed one
 * arm its home field and the other its worst case. Running both forms across
 * all three engines turns that confound into a measured variable: if the
 * ranking flips with query form, the finding is about PHRASING, not engines.
 *
 * Rewriting rule, applied strictly: the natural form may re-phrase the need
 * but may NOT add a fact the keyword form lacked. `phia` is the load-bearing
 * case — naming Phoebe Gates or the careers domain would disambiguate the
 * company and silently test the proposed entity-disambiguation fix instead of
 * the engines. So the natural form says "a startup called Phia" and nothing
 * more. Same information, different phrasing, no smuggled answers.
 *
 * Note the distribution: seven of nine name a specific ROUND FORM rather than
 * a company process, because the planner only searches when the candidate
 * named a round it cannot describe (prompts/planner.md, "Research — when to
 * look things up"). Two are for `phia`, a ~20-person startup, where the
 * stored results returned a hair salon and a health-insurance company.
 */

export type QueryForm = 'keyword' | 'natural';

export interface Need {
  /** Stable id for the information need; both forms share it, and the judge
   *  grades each URL once per need rather than once per form. */
  id: string;
  /** Verbatim from the stored conversation — the form that ships today. */
  keyword: string;
  /** Same need, phrased as a description of the page being sought. */
  natural: string;
  target: string;
  company: string;
  /** true when the company is small enough that entity confusion is a live
   *  risk (the failure the stored Phia results actually exhibit). */
  obscure: boolean;
}

export const NEEDS: Need[] = [
  {
    id: 'plt-learning-1',
    keyword: 'Palantir learning interview round format debugging unfamiliar codebase',
    natural:
      "A detailed description of what actually happens in Palantir's learning interview round, where the candidate works inside a codebase they have not seen before.",
    target: 'palantir-learning-round-msky11s8',
    company: 'Palantir',
    obscure: false,
  },
  {
    id: 'plt-learning-2',
    keyword: 'Palantir "learning interview" software engineer round format debugging documentation',
    natural:
      "Someone explaining the format of Palantir's learning interview for software engineers, including whether documentation is provided during the round.",
    target: 'palantir-learning-round-mskr76jp',
    company: 'Palantir',
    obscure: false,
  },
  {
    id: 'plt-learning-3',
    keyword: 'Palantir learning interview round debugging async',
    natural:
      "An account of Palantir's learning interview round in which the candidate had to debug asynchronous code.",
    target: 'palantir-learning-round-msksggoq',
    company: 'Palantir',
    obscure: false,
  },
  {
    id: 'plt-learning-4',
    keyword: 'Palantir learning interview round debugging async format',
    natural:
      "How long Palantir's learning interview round lasts and how the debugging exercise inside it is structured.",
    target: 'palantir-learning-round-msksggoq',
    company: 'Palantir',
    obscure: false,
  },
  {
    id: 'amzn-1',
    keyword: 'Amazon final round loop interview structure coding rounds leadership principles 2025',
    natural:
      "A breakdown of how Amazon's final round loop is structured, how many interviews it contains and what each one covers.",
    target: 'amazon-final-round-interview-msrsiegy',
    company: 'Amazon',
    obscure: false,
  },
  {
    id: 'amzn-2',
    keyword:
      'Amazon onsite loop interview structure software engineer coding rounds leadership principles',
    natural:
      "An explanation of what a software engineer's Amazon onsite loop consists of, round by round, and how coding and behavioral questions are split within each round.",
    target: 'amazon-final-round-interview-msrsiegy',
    company: 'Amazon',
    obscure: false,
  },
  {
    id: 'amzn-3',
    keyword:
      'amazon.jobs interview process software development engineer loop coding leadership principles official',
    natural:
      "Amazon's own official guidance telling software development engineer candidates how its interview process works.",
    target: 'amazon-final-round-interview-msrsiegy',
    company: 'Amazon',
    obscure: false,
  },
  {
    id: 'phia-1',
    keyword: 'Phia interview process online assessment engineer Node.js',
    natural:
      'What the software engineering interview process is like at a startup called Phia, including any online assessment candidates are given.',
    target: 'phia-msiik6jn',
    company: 'Phia (the AI-commerce startup, jobs.ashbyhq.com/phia)',
    obscure: true,
  },
  {
    id: 'phia-2',
    keyword: 'Phia startup software engineer interview online assessment',
    natural:
      'A description of the online assessment that software engineering candidates at the startup Phia are asked to complete.',
    target: 'phia-msiik6jn',
    company: 'Phia (the AI-commerce startup, jobs.ashbyhq.com/phia)',
    obscure: true,
  },
];

export const FORMS: QueryForm[] = ['keyword', 'natural'];

/** One row per (need, form) — the unit a search run is keyed on. */
export interface Query extends Need {
  form: QueryForm;
  /** `${id}::${form}` — unique per run, still groupable by `id`. */
  runId: string;
  q: string;
}

export const QUERIES: Query[] = NEEDS.flatMap((n) =>
  FORMS.map((form) => ({
    ...n,
    form,
    runId: `${n.id}::${form}`,
    q: form === 'keyword' ? n.keyword : n.natural,
  })),
);

/** Mirrors planner.ts BLOCKED_SOURCE_DOMAINS — every engine gets the same
 *  policy, so the comparison is not confounded by one being allowed to cheat
 *  with Glassdoor. */
export const BLOCKED_SOURCE_DOMAINS = ['glassdoor.com'];
export const BLOCKED_DOMAINS = BLOCKED_SOURCE_DOMAINS;
