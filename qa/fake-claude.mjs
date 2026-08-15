#!/usr/bin/env node
/**
 * fake-claude — the model-free QA shim.
 *
 *   app/session/cli spawn `claude -p <prompt> …` ──► PATH finds qa/shim-bin/claude
 *        │                                              │
 *        └── first line of <prompt> ──► dispatch ──► deterministic, gate-conformant
 *            reply on stdout (or, for the generator, a written artifact + result payload)
 *
 * Why it exists (doors QA, 2026-08-15): the binder incident escaped the first
 * QA pass because agents were forbidden every stateful action — accept-spec was
 * never pressed. Pressing every door needs disposable state AND zero API spend,
 * and the repo's own convention makes that possible: every model-calling module
 * falls back to `claude -p` when ANTHROPIC_API_KEY is absent, each caller's
 * prompt template opens with a unique first line, and the generator's prompt
 * embeds the round spec verbatim — so a fake binary can serve every model call
 * in the system, including an artifact that passes validateProblem by
 * construction. Run only against a scratch worktree (see qa/README.md); the
 * shim refuses nothing and fakes everything, which is exactly wrong in prod.
 *
 * Steering (per-request beats global): `[QA:key=value]` tokens anywhere in the
 * prompt (they ride user-typed descriptions into clarifiers, and the blueprint
 * shim re-emits them so they reach later generation briefs) override keys in
 * the JSON file at $QA_SHIM_CONTROL, which override defaults. Every call is
 * appended to $QA_SHIM_LOG (jsonl) — the proof a run made zero API calls.
 *
 * Unknown prompt marker → exit 1, loudly. A new model caller must be noticed
 * and given a handler here, never silently faked.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// ---- argv (claude -p contract: prompt is the arg after -p) ----
const argv = process.argv.slice(2);
const flagOf = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const prompt = flagOf('-p') ?? '';
const outputFormat = flagOf('--output-format') ?? 'text';
const model = flagOf('--model') ?? '';
const firstLine = (prompt.split('\n').find((l) => l.trim()) ?? '').trim();

// ---- steering ----
const tokens = {};
for (const m of prompt.matchAll(/\[QA:([a-z_]+)=([^\]]*)\]/g)) tokens[m[1]] = m[2];
let control = {};
const controlPath = process.env.QA_SHIM_CONTROL;
if (controlPath && existsSync(controlPath)) {
  try {
    control = JSON.parse(readFileSync(controlPath, 'utf8'));
  } catch {
    /* a torn control file steers nothing */
  }
}
const opt = (k, d) => tokens[k] ?? control[k] ?? d;

function log(marker, extra = {}) {
  if (!process.env.QA_SHIM_LOG) return;
  try {
    appendFileSync(
      process.env.QA_SHIM_LOG,
      JSON.stringify({
        at: new Date().toISOString(),
        marker,
        model,
        format: outputFormat,
        cwd: process.cwd(),
        ...(Object.keys(tokens).length ? { tokens } : {}),
        ...extra,
      }) + '\n',
    );
  } catch {
    /* logging never breaks a reply */
  }
}

function reply(marker, text) {
  log(marker);
  process.stdout.write(text);
  process.exit(0);
}

// ---- shared draft shapes (intake.ts draftToSpec's flat vocabulary) ----
function flatRound(overrides = {}) {
  return {
    id: 'qa-round',
    label: 'QA fixture round',
    interviewer: false,
    can_run_tests: true,
    time_limit_minutes: 60,
    time_evidence: 'stated',
    language: 'python',
    language_evidence: 'stated',
    language_options: [],
    task: 'debug',
    task_evidence: 'stated',
    starts_from: 'repo',
    submit: 'iterate',
    check_kind: 'one_failing_test',
    emphasis: '',
    rationale: 'Deterministic QA-shim draft.',
    unsupported: '',
    ...overrides,
  };
}

/** Token-steered rounds for the clarifier doors. Tokens: task, check,
 *  starts_from, submit, surface, time (minutes or "null"), interviewer=1,
 *  parts=N, named=a,b (comma slugs), msf=N, rounds=N (sibling drafts),
 *  bad_draft=1 (adds one out-of-vocabulary sibling the gate must drop). */
function steeredRounds() {
  const base = flatRound({
    ...(opt('task') ? { task: opt('task') } : {}),
    ...(opt('check') ? { check_kind: opt('check') } : {}),
    ...(opt('starts_from') ? { starts_from: opt('starts_from') } : {}),
    ...(opt('submit') ? { submit: opt('submit') } : {}),
    ...(opt('surface') ? { surface: opt('surface') } : {}),
    ...(opt('interviewer') === '1' ? { interviewer: true } : {}),
    ...(opt('time') === 'null' ? { time_limit_minutes: null } : opt('time') ? { time_limit_minutes: Number(opt('time')) } : {}),
    ...(opt('msf') ? { max_source_files: Number(opt('msf')) } : {}),
    ...(opt('parts') ? { part_count: Number(opt('parts')) } : {}),
    ...(opt('named') ? { named_problems: opt('named').split(',').filter(Boolean) } : {}),
  });
  const rounds = [base];
  const n = Number(opt('rounds', '1'));
  for (let i = 2; i <= Math.min(n, 4); i++) {
    rounds.push({ ...base, id: `qa-round-${i}`, label: `QA fixture round ${i}` });
  }
  if (opt('bad_draft') === '1') {
    rounds.push(flatRound({ id: 'qa-bad', check_kind: 'not_a_kind' }));
  }
  return rounds;
}

// ---- handlers ----

function generator() {
  const fail = opt('fail', '');
  if (fail === 'generate') {
    // In-band failure: real `claude -p` exits 0 on error_max_turns; only the
    // JSON payload says the run died (generate.ts inBandFailure).
    log('generator', { injected: 'error_max_turns' });
    process.stdout.write(
      JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true, num_turns: 80, result: '' }),
    );
    process.exit(0);
  }
  if (fail === 'generate_dead') {
    log('generator', { injected: 'dead' });
    process.exit(1); // died leaving nothing — cli exits 1, app marks .failed
  }

  // The round spec rides the prompt verbatim ("round_spec": {{ROUND_SPEC_JSON}}).
  const anchor = '"round_spec": ';
  const at = prompt.indexOf(anchor);
  if (at < 0) {
    process.stderr.write('fake-claude: generator prompt has no round_spec anchor\n');
    process.exit(1);
  }
  let depth = 0;
  const start = at + anchor.length;
  let end = start;
  for (let j = start; j < prompt.length; j++) {
    if (prompt[j] === '{') depth++;
    else if (prompt[j] === '}') {
      depth--;
      if (depth === 0) {
        end = j + 1;
        break;
      }
    }
  }
  const spec = JSON.parse(prompt.slice(start, end));
  const kind = spec.check?.kind ?? 'one_failing_test';
  const sourced = prompt.includes('SOURCED PROBLEM');

  const plannedTitle = prompt.match(
    /set the manifest "title" to it\): (.*?) — the round description's difficulty/s,
  )?.[1];
  const topicIds = prompt
    .match(/This plan's concept topics: ([^.]+)\./)?.[1]
    ?.split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  // 'qafixture' is the shared-vocabulary token: it appears in the statement
  // and opens every expectation, satisfying validate.ts's concreteness gate.
  const statement =
    'You are handed the qafixture reservation ledger, a small service that records unit holds and ' +
    'releases against a depot inventory. Each qafixture entry carries a unit count and an expiry; ' +
    'the ledger must keep the running total consistent as holds are added, released, and swept. ' +
    'Work through the suite: read the qafixture behaviors the tests pin down, make the ledger ' +
    'honor them, and keep every invariant intact. Narrate what you check as you go; the round is ' +
    'graded on how you work as much as on the final state of the code.';
  const expectations = {
    clarify: 'Names the qafixture ledger behaviors the tests pin down before touching any code at all',
    approach: 'States a qafixture mechanism hypothesis, such as the sweep releasing the wrong unit count, before editing',
    communicate: 'Narrates each qafixture change aloud, tying every edit back to a specific failing behavior',
    implement: 'Makes the qafixture ledger edits small and targeted, keeping unrelated behaviors untouched throughout the round',
    verify: 'Re-runs the qafixture suite after each change and confirms the targeted case now passes cleanly',
    reflect: 'Explains which qafixture invariant was broken and why the final state now holds it',
  };

  const w = (rel, content) => {
    const p = path.join(process.cwd(), rel);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, content);
  };

  const manifest = {
    round_type: 'debugging',
    repo_path: '.',
    model_paths: [],
    round_spec: spec,
    title: plannedTitle ?? `${spec.label ?? 'QA round'} (qafixture)`,
    spec: statement,
    mutations: [],
    rubric: { round_type: 'debugging', dimensions: expectations },
    ...(topicIds?.length ? { topics_exercised: topicIds.slice(0, 2) } : {}),
  };

  if (sourced) {
    // The sourced contract: the generator NEVER authors tests — cli.ts
    // re-emits the grading suite from the dataset and stamps SOURCED_RUNTIME.
    // We only write the manifest and starter stubs.
    const partNums = [...prompt.matchAll(/solution_part(\d+)\.py/g)].map((m) => Number(m[1]));
    const partCount = partNums.length ? Math.max(...partNums) : 1;
    const fnName = prompt.match(/def (\w+)\(/)?.[1] ?? 'solve';
    const stub = `def ${fnName}(*args, **kwargs):\n    raise NotImplementedError('qafixture starter')\n`;
    if (partCount > 1) {
      for (let i = 1; i <= partCount; i++) w(`solution_part${i}.py`, stub);
    } else {
      w('solution.py', stub);
    }
    w('problem.json', JSON.stringify(manifest, null, 2) + '\n');
    log('generator', { sourced: true, parts: partCount });
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 3 }));
    process.exit(0);
  }

  manifest.runtime = 'python';
  manifest.test_command = 'python3 -m unittest discover -v';

  const minTests = Math.max(spec.check?.min_tests ?? 0, kind === 'one_failing_test' ? 8 : 5);
  const cases = [];
  for (let i = 1; i <= minTests; i++) {
    cases.push(
      `    def test_case_${i}(self):\n        self.assertEqual(total([${i}, ${i + 1}]), ${2 * i + 1})\n`,
    );
  }

  if (kind === 'one_failing_test') {
    // The planted bug: total() drops one unit when exactly three entries are
    // present. Every generic case passes; the three-entry case fails.
    w(
      'solution.py',
      'def total(entries):\n' +
        '    """Sum the qafixture ledger unit counts."""\n' +
        '    if len(entries) == 3:\n' +
        '        return sum(entries) - 1\n' +
        '    return sum(entries)\n',
    );
    cases.push(
      '    def test_planted_defect(self):\n        self.assertEqual(total([2, 3, 4]), 9)\n',
    );
    manifest.planted_bug = {
      file: 'solution.py',
      description: 'total() subtracts one unit when the qafixture ledger holds exactly three entries.',
      failing_test: 'test_planted_defect',
    };
  } else if (kind === 'all_failing') {
    w('solution.py', "def total(entries):\n    raise NotImplementedError('build the qafixture ledger total')\n");
  } else if (kind === 'all_passing') {
    w('solution.py', 'def total(entries):\n    """Sum the qafixture ledger unit counts."""\n    return sum(entries)\n');
  } else if (kind === 'diff_present') {
    // Manifest-side diff contract: files_changed lives in the round_spec's
    // check and every entry must exist (validate.ts checkManifest).
    w('solution.py', 'def total(entries):\n    """Sum the qafixture ledger unit counts."""\n    return sum(entries)\n');
    w('NOTES.md', 'The qafixture diff under review changes solution.py only.\n');
    manifest.round_spec = { ...spec, check: { ...spec.check, files_changed: ['solution.py'] } };
  }

  if (kind !== 'diff_present') {
    w('tests/__init__.py', '');
    w(
      'tests/test_qa.py',
      'import unittest\n\nfrom solution import total\n\n\nclass QaSuite(unittest.TestCase):\n' +
        cases.join('\n') +
        "\n\nif __name__ == '__main__':\n    unittest.main()\n",
    );
  }

  w('problem.json', JSON.stringify(manifest, null, 2) + '\n');
  log('generator', { kind, tests: kind === 'diff_present' ? 0 : cases.length });
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 3 }));
  process.exit(0);
}

function judge() {
  const order = ['clarify', 'approach', 'communicate', 'implement', 'verify', 'reflect'];
  const verdicts = String(opt('verdicts', '')).split(',').filter(Boolean);
  const out = {
    solved: opt('solved', '1') === '1',
    summary: 'Deterministic QA-shim assessment: the candidate worked the qafixture round end to end.',
    dimensions: order.map((dimension, i) => ({
      dimension,
      verdict: verdicts[i] ?? 'adequate',
      analysis: 'QA-shim canned analysis for this dimension.',
      evidence: [],
    })),
  };
  reply('judge', JSON.stringify(out));
}

function interviewer() {
  reply(
    'interviewer',
    JSON.stringify({
      say: opt('say', 'Walk me through what you are looking at right now.'),
      kind: 'answer',
      nudge: false,
    }),
  );
}

function blueprint() {
  // Re-emit any steering tokens so they ride the blueprint into later
  // generation briefs (composeRoundBrief inlines the blueprint verbatim).
  const carried = Object.entries(tokens)
    .map(([k, v]) => `[QA:${k}=${v}]`)
    .join(' ');
  const pad =
    'The qafixture reservation ledger records unit holds and releases against a depot inventory, ' +
    'and every behavior the candidate touches is pinned by the suite. ';
  reply(
    'blueprint',
    [
      '# Round blueprint — qafixture ledger (QA shim)',
      carried,
      '## What this round is',
      pad + 'This section states the round shape deterministically for harness runs.',
      '## Environment',
      pad + 'Python stdlib only; the suite runs with unittest discover.',
      '## Repo shape',
      pad + 'A single solution module plus a tests package, nothing else.',
      '## What the candidate does',
      pad + 'Reads the pinned behaviors, edits the ledger, re-runs the suite.',
      '## Difficulty calibration',
      pad + 'Calibrated for a deterministic fixture, not a human difficulty curve.',
      '## Topic guidance',
      pad + 'Topics are declared in the manifest only, never candidate-visible.',
      '## Learnings log',
      '(none yet)',
    ]
      .filter(Boolean)
      .join('\n\n'),
  );
}

function planTopics() {
  const count = Number(prompt.match(/Produce EXACTLY (\d+) titles/)?.[1] ?? 1);
  const pool = [
    'Depot ledger drift audit',
    'Parcel window overlap report',
    'Seat hold expiry sweep',
    'Cache eviction storm triage',
    'Route fare rounding check',
    'Queue lease renewal race',
    'Vault token rollover proof',
    'Kiosk badge dedupe pass',
  ];
  reply('plan-topics', JSON.stringify(pool.slice(0, count)));
}

function adapt() {
  // Token: adapt_round=<newId>:<check_kind>:<supersededSpecId>
  const spec = opt('adapt_round', '');
  const rounds = [];
  if (spec) {
    const [id, check_kind, supersedes] = spec.split(':');
    rounds.push({
      ...flatRound({ id, label: `QA adapted ${id}`, check_kind, starts_from: check_kind === 'diff_present' ? 'diff' : 'repo' }),
      supersedes,
    });
  }
  reply('adapt', JSON.stringify({ rounds, blueprint_edits: [] }));
}

// ---- dispatch ----
if (firstLine.startsWith('# Generator prompt')) generator();
else if (firstLine.startsWith('# Session judge')) judge();
else if (firstLine.startsWith('# Interviewer agent')) interviewer();
else if (firstLine.startsWith('A candidate is working')) reply('intent', opt('intent', 'no'));
else if (firstLine.startsWith('# Practice-door clarification'))
  reply(
    'practice-clarify',
    JSON.stringify({
      rounds: steeredRounds(),
      gaps: [],
      brief: 'Deterministic QA-shim brief: a qafixture round shaped exactly by the steering tokens in the paste.',
    }),
  );
else if (firstLine.startsWith('# Intake clarification'))
  reply('clarify', JSON.stringify({ questions: [], rounds: steeredRounds() }));
else if (firstLine.startsWith('# Round-spec inference')) reply('infer', JSON.stringify(steeredRounds()[0]));
else if (firstLine.startsWith('# Plan topics')) planTopics();
else if (firstLine.startsWith('# Plan adaptation')) adapt();
else {
  log('UNKNOWN', { firstLine: firstLine.slice(0, 120) });
  process.stderr.write(`fake-claude: unrecognized prompt marker: "${firstLine.slice(0, 120)}"\n`);
  process.exit(1);
}
