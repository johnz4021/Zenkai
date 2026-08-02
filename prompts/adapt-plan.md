# Plan adaptation

A candidate already has a practice plan for an upcoming technical interview. They just
learned something new — an invite email, problem titles from an assessment, a message
from a friend who interviewed, a preview screen — and pasted it below. Your job: say
what round shapes the new material implies, so the remaining plan can re-shape.

Return one round entry PER DISTINCT SHAPE the material implies, using the vocabulary
below. For each entry set `supersedes`:

- the id of a CURRENT round it **replaces** for future practice (the material shows
  that round is actually shaped differently than planned), or
- `null` when it is an **additional** round the plan didn't know about.

Do NOT restate current rounds the material says nothing about — only emit what the
material adds or corrects. If the material genuinely changes nothing, return an EMPTY
`rounds` array — that is a valid, honest answer, and the candidate sees "nothing to
change — the plan already matches".

## The practice environment's capabilities (the whole vocabulary)

A real code editor with a repo, a test runner, and an optional voice interviewer.
A round is described by:

- `interviewer` — true for live rounds with a person probing; false for OAs and
  anything autograded/unproctored.
- `can_run_tests` — false only when the round explicitly forbids executing code.
- `time_limit_minutes` — a number ONLY when explicitly timed; null for live rounds.
- `starts_from` — `repo` (existing codebase: debugging, extend), `blank` (build from
  scaffold: most OAs, implement-these-classes), `diff` (review someone's change).
- `submit` — `one_shot` (graded once at the end) or `iterate`.
- `check_kind` — how a generated problem proves itself: `one_failing_test` (find-and-
  fix in a repo), `all_failing` (build against a visible suite), `all_passing`
  (extend/refactor a green repo), `diff_present` (review).
- `unsupported` — ONE sentence when a round fundamentally needs something outside
  this vocabulary (system-design canvas, multi-day take-home, pure conversation);
  empty otherwise. The product declines honestly rather than faking it.

## Evidence rules

The pasted material is FIRSTHAND evidence about THIS candidate's loop — it outranks
anything you believe about what this company usually does. Interpret what it actually
says; do not pad it with base rates. When the material contradicts a current round,
that is exactly the signal `supersedes` exists for — replace, don't hedge. When the
material is thin, emit the most conservative reading and say in `rationale` what you
assumed.

Rules for the entries:

- Kebab-case `id`s that do NOT reuse any current round's id — a changed round gets a
  new id (the old one stays in history). Short human `label`s naming the company and
  round when known.
- `emphasis` carries topical hints for problem generation, from the material only.
- Coherence: `can_run_tests: false` cannot pair with a test-based `check_kind`
  (one_failing_test / all_failing / all_passing). A round about READING code still
  runs its tests — reading-heavy is an `emphasis`, not can_run_tests=false.

## The candidate's current rounds

{{CURRENT_ROUNDS}}

## What they just learned (pasted material)

{{MATERIAL}}
