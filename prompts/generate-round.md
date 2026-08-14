# Generator prompt — interview round

Template variables: `{{ROUND_BRIEF}}` (what round this is and any candidate-provided
reference material), `{{SOURCE_BLOCK}}` (empty for invented rounds; for dataset-sourced
rounds, the authoritative SOURCED PROBLEM section rendered in code by
`sourceRequirements` — the checkRequirements pattern), `{{CHECK_REQUIREMENTS}}` (the
mechanical shape this problem must satisfy — selected in code from the round spec's
check kind), `{{ROUND_SPEC_JSON}}` (embedded verbatim in the manifest),
`{{TARGET_NOTE}}` (optional emphasis from the candidate's gap history).

---

You are generating a technical-interview round problem. Work entirely inside the
current directory (it is empty and dedicated to this problem). Do not touch anything
outside it.

## The round

{{ROUND_BRIEF}}

Honor the reference material above hard: if it contains an example question, generate
a NEW problem of the same species — same difficulty, same domain flavor, same round
etiquette — never a copy (unless a SOURCED PROBLEM section below says otherwise — it
is authoritative when present). If the material is thin, generate the most
representative problem for the round described.

The round description above governs the problem's SHAPE: language, repo size,
file layout, single-file vs multi-module, difficulty. The mechanical
requirements below govern ONLY the test/check pattern the validator proves.
Where the two seem to conflict on shape or size, the round description wins —
"a single Python file of ~200 lines" means exactly that, however the
requirements below are phrased.

{{SOURCE_BLOCK}}

## Mechanical requirements (the validator will prove these — they are not advisory)

{{CHECK_REQUIREMENTS}}

## Runtime

Choose the language the round calls for (from the brief; default TypeScript).
- TypeScript: vitest suite; `package.json` with `"test": "vitest run"`. Omit
  `runtime`/`test_command` from the manifest.
- Python: stdlib `unittest` (no pip installs); manifest carries
  `"runtime": "python"` and `"test_command": "python3 -m unittest discover -v"`.

{{TARGET_NOTE}}

## Manifest

Write `problem.json` at the repo root:

```json
{
  "round_type": "debugging",
  "repo_path": ".",
  "model_paths": ["<files defining the data model, if any>"],
  "round_spec": {{ROUND_SPEC_JSON}},
  "title": "<short human name for this problem, 3-8 words naming the system and its mechanism, e.g. 'Field depot reservation ledger'. If the round brief includes a planned title, this must match it.>",
  "spec": "<150-300 words: the problem statement handed to the candidate. Describe intended behavior and what they must do. Never reveal solution structure or (for bug rounds) the bug's location.>",
  "mutations": [],
  "rubric": {
    "round_type": "debugging",
    "dimensions": {
      "clarify": "<what resolving ambiguity looks like ON THIS PROBLEM>",
      "approach": "<what a real plan/hypothesis looks like ON THIS PROBLEM>",
      "communicate": "<what narration worth hearing sounds like here>",
      "implement": "<what strong implementation work looks like here>",
      "verify": "<what checking the work means here>",
      "reflect": "<what explaining the outcome means here>"
    }
  }
}
```

Plus any fields the mechanical requirements above demand (e.g. `planted_bug`).
`round_type` stays `"debugging"` for tooling compatibility regardless of the round's
actual shape — the `round_spec` is what describes this round.

When the round brief lists the plan's concept topics, add `"topics_exercised"`:
the 1-3 topic ids this problem genuinely tests, copied EXACTLY from that list
(the build drops anything outside it). Topics never appear in candidate-visible
files — the manifest is the only place they are written. Omit the field when
the brief lists no topics.

## Writing the dimension expectations (this is graded feedback material — be exact)

Each expectation describes what a STRONG candidate does on THIS SPECIFIC problem,
in one sentence naming an OBSERVABLE behavior tied to this problem's entities. A
session judge applies these verbatim; vague expectations produce vague feedback
forever.

Rules:
- Name entities from YOUR spec (the modules, states, and behaviors you built).
- Describe an action someone could point to in a transcript, never a mental state.
  BANNED stems: "understands...", "thinks about...", "is aware of...".
- For `approach`, demand a MECHANISM or a stated design, not a location or a vibe.
- Write them for the round's shape: on a one-shot autograded round, `verify` means
  dry-running before submit, not re-running a suite; with no interviewer, `clarify`
  means pinning down the spec from the visible tests, not asking questions.

Worked examples (from an inventory-holds bug round — match this specificity):
- approach: "Names a mechanism before editing — e.g. that the expiry sweep
  releases the hold's ORIGINAL unit count rather than its remaining count —
  not merely 'something in the expiry code'."
- verify: "Re-runs the suite after the fix, confirms the extended-hold expiry
  test passes, and checks that partial-shipment release still works."

Output nothing else. When your self-verification holds and problem.json is written,
you are done.
