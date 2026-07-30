/**
 * Gauntlet fixtures: synthetic sessions with ground truth BY CONSTRUCTION.
 *
 * Each persona is a scripted trace plus the verdicts a correct judge must
 * reach. Expected verdicts are SETS — "strong or adequate" is a legitimate
 * ground truth where the line is genuinely judgment; a fixture that
 * over-specifies its truth tests the coin, not the judge.
 *
 * The user's real traces are deliberately NOT here: they were app-testing
 * noise, excluded by decision. Realistic mess comes from the simulated-
 * candidate fixtures (see gauntlet.ts --simulate), where an LLM plays a
 * scripted persona against a real generated problem.
 */

import type { DimensionKey, GeneratedProblem, TraceEvent, Verdict } from '@interview-prep/shared';

// ---- trace-building DSL ----

const T0 = 1_700_000_000_000;

export class TraceBuilder {
  private events: TraceEvent[] = [];
  private seqBySource = new Map<string, number>();

  private push(type: TraceEvent['type'], offsetSec: number, payload: unknown, source: TraceEvent['source']): this {
    const seq = this.seqBySource.get(source) ?? 0;
    this.seqBySource.set(source, seq + 1);
    this.events.push({
      session_id: 'fixture', user_id: 'u1', source, seq, ts: T0 + offsetSec * 1000, type, payload,
    });
    return this;
  }

  start(at = 0) { return this.push('session_start', at, {}, 'extension'); }
  failRun(at: number) { return this.push('test_run', at, { via: 'task', exit_code: 1, duration_ms: 900 }, 'extension'); }
  passRun(at: number) { return this.push('test_run', at, { via: 'task', exit_code: 0, duration_ms: 900 }, 'extension'); }
  say(at: number, text: string) { return this.push('utterance', at, { text, via: 'voice' }, 'chrome'); }
  type(at: number, text: string) { return this.push('utterance', at, { text, via: 'text' }, 'chrome'); }
  spokeUntranscribed(at: number) { return this.push('utterance', at, { text: '', via: 'voice', untranscribed: true }, 'chrome'); }
  open(at: number, path: string) { return this.push('file_open', at, { path }, 'extension'); }
  edit(at: number, path: string) { return this.push('edit', at, { path, changes: 3 }, 'extension'); }
  save(at: number, path: string) { return this.push('file_save', at, { path, is_model_path: false }, 'extension'); }
  interviewer(at: number, text: string, nudge = false) {
    return this.push('interviewer', at, { text, kind: nudge ? 'answer' : 'probe', nudge, unprompted: false }, 'chrome');
  }
  sensor(at: number, sensor: 'presence' | 'stt', state: 'up' | 'down') {
    return this.push('sensor', at, { sensor, state, reason: 'fixture' }, 'chrome');
  }
  end(at: number) { return this.push('session_end', at, {}, 'chrome'); }
  build(): TraceEvent[] { return [...this.events]; }
}

// ---- the fixture problem (shared spec/bug so expectations stay coherent) ----

export const FIXTURE_DEBUGGING_PROBLEM: Pick<GeneratedProblem, 'round_type' | 'spec' | 'planted_bug' | 'rubric'> = {
  round_type: 'debugging',
  spec:
    'This repository is an inventory reservation module. Stock units can be placed on time-limited holds; every hold carries an expiry deadline, and a periodic sweep releases expired holds back to available stock. Extending a hold moves its deadline forward. One behavior is broken: exactly one test fails. Find the root cause in src/ and fix it. The failing test is correct as written.',
  planted_bug: {
    file: 'src/sweep.ts',
    line: 31,
    description:
      'the expiry sweep releases the hold\'s ORIGINAL unit count instead of its remaining count, so partially-shipped holds return phantom stock',
    failing_test: 'expiry > releases only the remaining units of a partially shipped hold',
  },
  rubric: {
    round_type: 'debugging',
    dimensions: {
      clarify: 'Reads the failing test body and asks whether partially shipped holds should return only unshipped units before editing.',
      approach: 'Names the mechanism — the sweep releasing the original count rather than the remaining count — not merely "something in the sweep".',
      communicate: 'Narrates what the failure diff shows and which hold-state fields are being traced.',
      implement: 'Changes the sweep\'s released-quantity computation to test the stated hypothesis.',
      verify: 'Re-runs the suite and confirms the partially-shipped expiry test passes without breaking full-release behavior.',
      reflect: 'Explains why releasing the original count created phantom stock and how the remaining-count fix prevents it.',
    },
  },
};

export const FIXTURE_DSA_PROBLEM: Pick<GeneratedProblem, 'round_type' | 'spec' | 'planted_bug' | 'rubric'> = {
  round_type: 'dsa',
  spec:
    'Implement findPairs(nums, target): return all unique index pairs whose values sum to target. The test suite defines the contract: duplicates in nums are allowed, each index may be used once per pair, and pairs are unordered. Several tests fail until implemented. Efficiency matters: the large-input test has a generous but real time limit.',
  rubric: {
    round_type: 'dsa',
    dimensions: {
      clarify: 'Establishes how duplicate values and reused indices behave in findPairs before designing.',
      approach: 'States the algorithm and its complexity — e.g. a hashmap pass making it O(n) versus the naive O(n^2) — BEFORE writing code.',
      communicate: 'Talks through the pair-collection logic while implementing it.',
      implement: 'Implementation follows the stated algorithm for collecting unique index pairs.',
      verify: 'Dry-runs findPairs on an example with duplicates and re-runs the suite including the large-input test.',
      reflect: 'Restates the complexity and where the hashmap approach would break.',
    },
  },
};

// ---- personas ----

/** Ground truth: acceptable verdict SETS per dimension. Omitted dimension =
 *  not scored for this fixture (genuinely ambiguous either way). */
export interface PersonaFixture {
  id: string;
  problem: typeof FIXTURE_DEBUGGING_PROBLEM;
  events: TraceEvent[];
  expected: Partial<Record<DimensionKey, Verdict[]>>;
  /** For the format-adaptation metric: fixtures sharing a behavior_class
   *  across round types must each catch/reward it under their own bar. */
  behavior_class?: string;
}

export function personaFixtures(): PersonaFixture[] {
  const F = 'src/sweep.ts';

  // -- the methodical one: textbook process, self-directed --
  const methodical = new TraceBuilder()
    .start()
    .failRun(6)
    .open(15, '/p/test/expiry.test.ts')
    .say(40, 'The diff says we released eight units but only five were still held — three had already shipped.')
    .say(55, 'Should a partially shipped hold return only its unshipped units? The spec says remaining, so yes.')
    .say(75, 'My hypothesis: the sweep releases the original count instead of the remaining count.')
    .open(90, `/p/${F}`)
    .say(110, 'Yes — release uses hold.units, not hold.units minus shipped. Fixing that computation.')
    .edit(130, `/p/${F}`)
    .save(140, `/p/${F}`)
    .passRun(170)
    .say(185, 'Green. The sweep was returning phantom stock for anything partially shipped; subtracting shipped units fixes it because release now matches what is actually held.')
    .end(200)
    .build();

  // -- the silent editor: no words, straight to code, does verify --
  const silentEditor = new TraceBuilder()
    .start()
    .failRun(6)
    .edit(15, `/p/${F}`)
    .edit(45, `/p/${F}`)
    .edit(80, `/p/src/holds.ts`)
    .save(95, `/p/${F}`)
    .passRun(140)
    .end(150)
    .build();

  // -- the location-namer: a location is not a mechanism --
  const locationNamer = new TraceBuilder()
    .start()
    .failRun(6)
    .say(20, "It's probably something in the sweep file. Let me just poke around in there.")
    .open(30, `/p/${F}`)
    .edit(60, `/p/${F}`)
    .save(70, `/p/${F}`)
    .passRun(110)
    .say(120, 'Cool, it passes now.')
    .end(130)
    .build();

  // -- the never-verifier: good process until the fix, then walks away --
  const neverVerifier = new TraceBuilder()
    .start()
    .failRun(6)
    .open(15, '/p/test/expiry.test.ts')
    .say(35, 'Expected five, got eight — the three shipped units came back too.')
    .say(55, 'So the sweep must release the original count, not the remaining count. Fixing the release computation.')
    .edit(80, `/p/${F}`)
    .save(90, `/p/${F}`)
    .say(100, 'That should do it.')
    .end(110)
    .build();

  // -- the interviewer-carried one: same GOOD moves, every one prompted --
  const carried = new TraceBuilder()
    .start()
    .failRun(6)
    .interviewer(20, 'Read the failing test body before you touch anything — what does the diff actually show?', true)
    .say(35, 'Okay — expected five, got eight. The shipped units came back.')
    .interviewer(50, 'So what mechanism would return shipped units? Look at what quantity the sweep releases.', true)
    .say(65, 'Oh — it releases the original count instead of the remaining count.')
    .interviewer(80, 'Fix exactly that and re-run.', true)
    .edit(95, `/p/${F}`)
    .save(105, `/p/${F}`)
    .passRun(140)
    .end(150)
    .build();

  // -- the ghost: opened it, looked at it, left --
  const ghost = new TraceBuilder()
    .start()
    .failRun(6)
    .open(20, '/p/package.json')
    .end(95)
    .build();

  // -- DSA: states complexity before code (the round-specific bar, met) --
  const dsaComplexityFirst = new TraceBuilder()
    .start()
    .failRun(6)
    .say(25, 'Duplicates are allowed and each index once per pair — so I need index pairs, not value pairs.')
    .say(45, 'Naive is checking all pairs, O(n squared). A hashmap from value to indices gets it to O(n) — one pass, look up target minus current. I will do that.')
    .edit(70, '/p/src/findPairs.ts')
    .say(100, 'Collecting earlier indices from the map as I scan so each pair is emitted once.')
    .save(120, '/p/src/findPairs.ts')
    .passRun(160)
    .say(175, 'Passes including the large input. One pass, O(n) time, O(n) space for the index map.')
    .end(190)
    .build();

  // -- DSA: dives into code, never states approach or complexity --
  const dsaCodeDiver = new TraceBuilder()
    .start()
    .failRun(6)
    .say(15, 'Alright, let me just start writing this.')
    .edit(30, '/p/src/findPairs.ts')
    .edit(70, '/p/src/findPairs.ts')
    .save(90, '/p/src/findPairs.ts')
    .passRun(140)
    .end(150)
    .build();

  const A = (...v: Verdict[]) => v;

  return [
    {
      id: 'methodical-debugging',
      problem: FIXTURE_DEBUGGING_PROBLEM,
      events: methodical,
      expected: {
        clarify: A('strong', 'adequate'),
        approach: A('strong'),
        communicate: A('strong', 'adequate'),
        implement: A('strong', 'adequate'),
        verify: A('strong', 'adequate'),
        reflect: A('strong', 'adequate'),
      },
    },
    {
      id: 'silent-editor-debugging',
      problem: FIXTURE_DEBUGGING_PROBLEM,
      events: silentEditor,
      expected: {
        clarify: A('weak'),
        approach: A('weak'),
        communicate: A('weak'),
        verify: A('strong', 'adequate'),
        reflect: A('weak', 'unassessable'),
      },
    },
    {
      id: 'location-namer-debugging',
      problem: FIXTURE_DEBUGGING_PROBLEM,
      events: locationNamer,
      behavior_class: 'approach-without-round-bar',
      expected: {
        approach: A('weak'), // a location is not a mechanism — the round's bar
        verify: A('strong', 'adequate'),
        reflect: A('weak', 'unassessable'),
      },
    },
    {
      id: 'never-verifier-debugging',
      problem: FIXTURE_DEBUGGING_PROBLEM,
      events: neverVerifier,
      expected: {
        approach: A('strong', 'adequate'),
        verify: A('weak'), // made a fix, declared victory, never ran anything
        communicate: A('strong', 'adequate'),
      },
    },
    {
      id: 'interviewer-carried-debugging',
      problem: FIXTURE_DEBUGGING_PROBLEM,
      events: carried,
      expected: {
        // Right moves, all prompted: must NOT be credited as strong
        // (self-directed). adequate or weak are both defensible.
        clarify: A('adequate', 'weak'),
        approach: A('adequate', 'weak'),
        verify: A('strong', 'adequate'),
      },
    },
    {
      id: 'ghost-debugging',
      problem: FIXTURE_DEBUGGING_PROBLEM,
      events: ghost,
      expected: {
        approach: A('unassessable', 'weak'),
        communicate: A('unassessable', 'weak'),
        implement: A('unassessable'),
        verify: A('unassessable'),
        reflect: A('unassessable'),
      },
    },
    {
      id: 'complexity-first-dsa',
      problem: FIXTURE_DSA_PROBLEM as typeof FIXTURE_DEBUGGING_PROBLEM,
      events: dsaComplexityFirst,
      behavior_class: 'approach-with-round-bar',
      expected: {
        clarify: A('strong', 'adequate'),
        approach: A('strong'), // stated complexity before code — the DSA bar
        verify: A('strong', 'adequate'),
        reflect: A('strong', 'adequate'),
      },
    },
    {
      id: 'code-diver-dsa',
      problem: FIXTURE_DSA_PROBLEM as typeof FIXTURE_DEBUGGING_PROBLEM,
      events: dsaCodeDiver,
      behavior_class: 'approach-without-round-bar',
      expected: {
        approach: A('weak'), // never stated algorithm or complexity — DSA bar
        // The DSA bar wants a dry-run AND the suite; suite alone does not
        // round up (rule 8), so adequate or weak are both defensible.
        verify: A('adequate', 'weak'),
      },
    },
  ];
}

// ---- contrast pairs: one behavior differs; target flips, others hold ----

export interface ContrastPair {
  id: string;
  target: DimensionKey;
  problem: typeof FIXTURE_DEBUGGING_PROBLEM;
  withBehavior: TraceEvent[];
  withoutBehavior: TraceEvent[];
  /** Acceptable verdicts WITH the behavior / WITHOUT it. */
  expectWith: Verdict[];
  expectWithout: Verdict[];
}

export function contrastPairs(): ContrastPair[] {
  const F = 'src/sweep.ts';

  const base = () =>
    new TraceBuilder()
      .start()
      .failRun(6)
      .open(15, '/p/test/expiry.test.ts')
      .say(30, 'Expected five, got eight — shipped units came back.');

  const withClarify = base()
    .say(50, 'Before I change anything: should a partially shipped hold release only its unshipped units on expiry? Confirming that is the intended behavior.')
    .say(75, 'The sweep must release the original count instead of remaining. Fixing it.')
    .edit(95, `/p/${F}`).save(105, `/p/${F}`).passRun(140).end(150).build();
  const withoutClarify = base()
    .say(75, 'The sweep must release the original count instead of remaining. Fixing it.')
    .edit(95, `/p/${F}`).save(105, `/p/${F}`).passRun(140).end(150).build();

  const withVerify = base()
    .say(60, 'The sweep releases the original count instead of remaining — fixing the computation.')
    .edit(80, `/p/${F}`).save(90, `/p/${F}`).passRun(130)
    .say(145, 'So the issue was the sweep returning the original count as phantom stock.').end(160).build();
  const withoutVerify = base()
    .say(60, 'The sweep releases the original count instead of remaining — fixing the computation.')
    .edit(80, `/p/${F}`).save(90, `/p/${F}`)
    .say(100, 'So the issue was the sweep returning the original count as phantom stock.').end(110).build();

  const withMechanism = base()
    .say(60, 'Hypothesis: the sweep releases the ORIGINAL unit count instead of the remaining count — that is exactly how shipped units would come back.')
    .edit(85, `/p/${F}`).save(95, `/p/${F}`).passRun(130).end(140).build();
  const withoutMechanism = base()
    .say(60, "Something's off in the sweep somewhere — let me dig around in the release path and watch the hold state fields as I go.")
    .edit(85, `/p/${F}`).save(95, `/p/${F}`).passRun(130).end(140).build();

  const withNarration = new TraceBuilder()
    .start().failRun(6)
    .say(20, 'Reading the expiry test first.')
    .open(30, '/p/test/expiry.test.ts')
    .say(50, 'Expected five, got eight — the shipped three came back.')
    .say(70, 'Tracing the sweep release path now.')
    .edit(95, `/p/${F}`)
    .say(110, 'Swapping original count for remaining count in the release.')
    .save(120, `/p/${F}`).passRun(150).end(160).build();
  const withoutNarration = new TraceBuilder()
    .start().failRun(6)
    .open(30, '/p/test/expiry.test.ts')
    .edit(95, `/p/${F}`)
    .save(120, `/p/${F}`).passRun(150).end(160).build();

  return [
    {
      id: 'clarify-pair', target: 'clarify', problem: FIXTURE_DEBUGGING_PROBLEM,
      withBehavior: withClarify, withoutBehavior: withoutClarify,
      expectWith: ['strong', 'adequate'], expectWithout: ['weak', 'unassessable'],
    },
    {
      id: 'verify-pair', target: 'verify', problem: FIXTURE_DEBUGGING_PROBLEM,
      withBehavior: withVerify, withoutBehavior: withoutVerify,
      expectWith: ['strong', 'adequate'], expectWithout: ['weak'],
    },
    {
      id: 'approach-pair', target: 'approach', problem: FIXTURE_DEBUGGING_PROBLEM,
      withBehavior: withMechanism, withoutBehavior: withoutMechanism,
      expectWith: ['strong', 'adequate'], expectWithout: ['weak'],
    },
    {
      id: 'communicate-pair', target: 'communicate', problem: FIXTURE_DEBUGGING_PROBLEM,
      withBehavior: withNarration, withoutBehavior: withoutNarration,
      expectWith: ['strong', 'adequate'], expectWithout: ['weak'],
    },
  ];
}

// ---- reliability pairs: same silence, with/without sensor annotations ----

export interface ReliabilityPair {
  id: string;
  problem: typeof FIXTURE_DEBUGGING_PROBLEM;
  /** Long silent stretch, sensors HEALTHY: silence is real. */
  healthy: TraceEvent[];
  /** Same shape, sensors DOWN: silence proves nothing. */
  degraded: TraceEvent[];
  /** Dimension that must flip to unassessable under degradation. */
  target: DimensionKey;
}

export function reliabilityPairs(): ReliabilityPair[] {
  const F = 'src/sweep.ts';
  const silentWork = (b: TraceBuilder) =>
    b.failRun(6)
      .open(20, '/p/test/expiry.test.ts')
      .edit(120, `/p/${F}`)
      .edit(200, `/p/${F}`)
      .save(220, `/p/${F}`)
      .passRun(260)
      .end(280);

  const healthy = silentWork(
    new TraceBuilder().start().sensor(1, 'presence', 'up').sensor(1, 'stt', 'up'),
  ).build();

  const degraded = silentWork(
    new TraceBuilder().start().sensor(1, 'presence', 'up').sensor(1, 'stt', 'up').sensor(10, 'presence', 'down'),
  ).build();

  return [
    {
      id: 'mic-down-silence',
      problem: FIXTURE_DEBUGGING_PROBLEM,
      healthy,
      degraded,
      target: 'communicate',
    },
  ];
}
