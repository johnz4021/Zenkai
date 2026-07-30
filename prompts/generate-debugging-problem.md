# Generator prompt — debugging round

Template variables: `{{THEME}}` (problem domain), `{{TARGET_NOTE}}` (optional emphasis
from the gap graph, e.g. "the candidate tends to edit before reading failures — make
the failure output genuinely informative").

---

You are generating a debugging-round interview problem. Work entirely inside the
current directory (it is empty and dedicated to this problem). Do not touch anything
outside it.

## What to build

1. A small, realistic TypeScript module set for: {{THEME}}.
   - 4 to 8 source files under `src/`. Pure logic + in-memory state. No HTTP server,
     no database, no external services.
   - Written like production code by a competent team: consistent style, no
     tutorial comments, realistic naming.
2. A vitest test suite under `test/` with 8 to 15 behavioral tests.
   - `package.json` must define `"test": "vitest run"`.
   - Tests describe real behavior ("reserving more units than available rejects"),
     not implementation details.
3. Plant EXACTLY ONE subtle bug in `src/`.
   - Realistic class: boundary condition, wrong comparator, missed invalidation,
     state updated in the wrong order, off-by-one on a partition. NOT a typo, NOT a
     syntax error, NOT a wrong constant with an obvious name.
   - Findable by a strong college senior in 20-40 minutes of real debugging.
   - No comment anywhere near the bug that hints at it. No README hints.
4. Exactly ONE test must fail because of the bug. Every other test must pass.
   - The failing test must be a legitimate behavioral test that would exist anyway —
     not a test written to point at the bug.

## Self-verification (do this before you finish — it is the whole point)

- Run `npm install`, then `npm test`.
- Confirm exactly one test fails, and that it fails BECAUSE of the planted bug.
- Temporarily fix the bug, confirm ALL tests pass, then RESTORE the bug exactly.
- If anything is off, fix the problem set and re-verify. Do not finish until this
  holds.

{{TARGET_NOTE}}

## Manifest

Write `problem.json` at the repo root, exactly this shape:

```json
{
  "round_type": "debugging",
  "repo_path": ".",
  "model_paths": ["src/<the files that define the data model, if any>"],
  "planted_bug": {
    "file": "src/<file>",
    "line": <line number of the bug>,
    "description": "<one sentence: what the bug is>",
    "failing_test": "<the exact full name of the one failing test>"
  },
  "spec": "<150-300 words: the problem statement handed to the candidate. Describe the module's intended behavior and state that one behavior is broken; tell them to find and fix it. Do NOT name the file or the bug.>",
  "mutations": [],
  "rubric": {
    "round_type": "debugging",
    "dimensions": {
      "clarify": "<what resolving ambiguity looks like ON THIS PROBLEM>",
      "approach": "<what a real hypothesis looks like ON THIS PROBLEM>",
      "communicate": "<what narration worth hearing sounds like here>",
      "implement": "<what a targeted change looks like here>",
      "verify": "<what checking the fix means here>",
      "reflect": "<what explaining the root cause means here>"
    }
  }
}
```

## Writing the dimension expectations (this is graded feedback material — be exact)

Each expectation describes what a STRONG candidate does on THIS SPECIFIC problem,
in one sentence naming an OBSERVABLE behavior tied to this problem's entities. A
session judge applies these verbatim; vague expectations produce vague feedback
forever.

Rules:
- Name entities from YOUR spec (the modules, states, and behaviors you built).
- Describe an action someone could point to in a transcript, never a mental state.
  BANNED stems: "understands...", "thinks about...", "is aware of...".
- For `approach`, demand a MECHANISM, not a location.

Worked examples (from an inventory-holds problem — match this specificity):
- approach: "Names a mechanism before editing — e.g. that the expiry sweep
  releases the hold's ORIGINAL unit count rather than its remaining count —
  not merely 'something in the expiry code'."
- verify: "Re-runs the suite after the fix, confirms the extended-hold expiry
  test passes, and checks that partial-shipment release still works."

Output nothing else. When verification holds and problem.json is written, you are done.
