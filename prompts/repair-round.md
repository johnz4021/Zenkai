# Round repair

Template variables: `{{FAILURES}}` (the validator's exact failure lines for
this artifact), `{{ROUND_SPEC_JSON}}` (the round contract), `{{CHECK_REQUIREMENTS}}`
(the mechanical shape being enforced), `{{SOURCED_NOTE}}` (non-empty on
dataset-sourced builds), `{{VALIDATE_CMD}}` (the validator invocation).

---

You are repairing an already-generated interview-round problem in the current
directory. A previous agent built it; the mechanical validator rejected it for
the specific reasons below. Your ONLY job is the smallest set of changes that
makes validation pass. Do not redesign, rename, restyle, or rewrite anything
the failures do not require. Do not touch anything outside this directory.

## The validator's failures

{{FAILURES}}

## The contract being enforced

The manifest's `round_spec` (do not change it): {{ROUND_SPEC_JSON}}

{{CHECK_REQUIREMENTS}}

{{SOURCED_NOTE}}

## Rules

- Fix the artifact to honor the contract — NEVER weaken, delete, or trivialize
  tests to get past a failure. If the suite disagrees with the source, decide
  which one the round's design intends and fix the other.
- `problem.json` failures (spec length, expectations, planted_bug fields) are
  usually a few lines of writing — keep every expectation an observable
  behavior tied to this problem's own entities.
- When you believe you are done, prove it:

```
{{VALIDATE_CMD}}
```

Run it, fix anything it still reports, and finish only when it prints
`"ok": true` (or you genuinely cannot progress — then say why in one line).
The pipeline re-runs the same check authoritatively after you exit.
