# How a practice problem comes to be

An objective walkthrough of the pipeline from "I have a Palantir interview" to a
generated repo on disk — every stage, every field that matters, where each piece
of user intent travels, and where it currently stops. Line numbers are accurate
as of 2026-08-05 (commit `cd89ac8`).

```
description ──► intake/clarify LLM ──► RoundSpec[] ──► queue (spec_id per item)
                                                          │
"what I learned" ──► adapt LLM ──► new RoundSpec appended ─┤ (re-points pending items)
                                                          │
                                          generate-for ◄──┘  (one item at a time)
                                                │
                    prompts/generate-round.md + 4 substitutions ──► claude -p (opus, 80 turns)
                                                │
                                        problems/<item>/  (repo + problem.json)
                                                │
                                        validateProblem ──► .validated | .failed
```

---

## Stage 1 — Intake: description → RoundSpec

**Entry**: the "new target" flow. The user types a free-form `description` and can
paste reference material (`context`). `POST /api/clarify` (`app.ts:657`) runs the
clarify reasoner (`clarify.ts`), which may ask up to 3 questions and returns
draft rounds; `POST /api/accept-spec` (`app.ts:690`) persists the confirmed
result as `targets/<id>/target.json`.

**The inference contract**: the LLM fills a flat tool schema (`intake.ts`
`DRAFT_TOOL` :101, `clarify.ts` `ROUND_FIELDS` :46) and `draftToSpec()`
(`intake.ts:166`) converts it to a `RoundSpec`, derives memory tags in code, and
gates it through `validateRoundSpec()`. A draft that fails the gate throws — an
inference failure never becomes a session.

**What a RoundSpec contains** (`shared/src/round-spec.ts`):

| Field | Type | Vocabulary |
|---|---|---|
| `id`, `label` | free-form strings | display + file naming only |
| `capabilities.interviewer` | boolean | closed |
| `capabilities.can_run_tests` | boolean | closed |
| `capabilities.time_limit_ms` | number \| null | closed |
| `capabilities.starts_from` | `repo` \| `blank` \| `diff` | closed |
| `capabilities.submit` | `iterate` \| `one_shot` | closed |
| `capabilities.surface` | `ide` \| `panes` (optional; derived from `starts_from` when absent) | closed |
| `check.kind` | `one_failing_test` \| `all_failing` \| `all_passing` \| `diff_present` | closed |
| `check.min_tests` | number (optional) | the only numeric shape knob |
| `memory_tags` | 6-tag set, derived in code, never authored | closed |
| `emphasis` | free-form string (optional) | **the only open-vocabulary generation input on the spec** |

**What the vocabulary does NOT contain**: language/runtime, file count, line
count, repo size, problem scale. None of these are fields. If the user's
description implies them, they can only survive as prose inside `emphasis`,
`label`, `description`, or `context`.

**Target file** (`targets/<id>/target.json`): `id`, `label`, `interview_date`,
`description` (the user's original text, kept verbatim), `context` (pasted
reference material, kept verbatim), `specs: RoundSpec[]`, `adaptations:
AdaptRecord[]`. A `research` key exists on some targets from a dead feature;
nothing reads it.

---

## Stage 2 — The plan: queue items bound to spec ids

`/api/accept-spec` also builds the queue (`queue.ts` `proposeQueue` :89):
runway ÷ 3 per week, capped at 12 items, **round-robin across `target.specs`**.
Each `QueueItem` carries:

- `spec_id` — the binding to a RoundSpec. This is the identity that decides
  which spec a future generation uses. It is set here and changed only by
  adaptation re-pointing.
- `planned_title` — a topic name from the plan-topics LLM (`plan-topics.ts`),
  e.g. "Async task queue — sequential-to-parallel refactor". Passed to the
  generator as a build-exactly-this instruction.
- `status` — `pending → generating → ready → done` (or `failed`/`skipped`),
  plus a `stale` flag set by adaptation.
- `note` — display-only. Explicitly documented as NOT a generation channel
  (`queue.ts:36`).

---

## Stage 3 — Generation: spec + prose → repo

**Trigger paths**: `/api/generate` (next pending item), `/api/retry` (failed
item), `/api/rebuild` (stale ready item) — all in `app.ts`, all funneling into
`spawnGeneration()` (`app.ts:120`), which shells out:

```
cli.ts generate-for <target_id> <item.spec_id> --into <dir> [--title <planned_title>]
```

That argument list is the **entire** channel from the app to the generator:
target id, spec id, output dir, planned title.

**The prompt** (`generate.ts:114-118`) is `prompts/generate-round.md` with
exactly four substitutions:

1. **`{{ROUND_BRIEF}}`** — composed in `cli.ts:195-205` from, in order:
   `Round: <spec.label>.` · `Planned title for THIS problem (build exactly
   this system...): <planned_title>` · `Emphasis: <spec.emphasis>.` · `The
   candidate describes it as: <target.description>` · `Reference material from
   the candidate:\n<target.context>`. Empty pieces are dropped.
2. **`{{CHECK_REQUIREMENTS}}`** — a hardcoded block selected by `check.kind`
   from `CHECK_REQUIREMENT_BLOCKS` (`generate.ts:26-84`). The model never
   writes its own passing criterion. For `one_failing_test` the block demands:
   *"4 to 8 source files"*, *"a behavioral test suite with 8 to 15 tests"*,
   exactly one failing test, a `planted_bug` manifest entry. For `all_failing`:
   min 5 tests (or `check.min_tests`), scoped "to fit the round's time limit".
3. **`{{ROUND_SPEC_JSON}}`** — the spec verbatim; the template requires it to
   be embedded unchanged in the generated `problem.json` as `round_spec`.
4. **`{{TARGET_NOTE}}`** — the gap-graph targeting note (`buildTargetNote`,
   `gap-graph.ts:310`): the candidate's most active process gap with recent
   evidence, plus instructions to make that behavior likely-triggered and
   observable, and to never mention it. Purely behavioral; carries no
   shape/language intent by construction.

**The generation itself** is an agentic `claude -p` run (model hardcoded
`opus`, `--max-turns 80`, 8-minute timeout, cwd = the item dir). The model
writes the repo and the manifest directly to disk.

**Runtime selection is the model's free choice, steered by one prompt line**
(`generate-round.md:28-34`): *"Choose the language the round calls for (from
the brief; default TypeScript)."* Only two runtimes exist end-to-end
(`GeneratedProblem.runtime?: 'node' | 'python'`). There is no equivalent
instruction for size — and the check-requirements block is introduced as
**"Mechanical requirements (the validator will prove these — they are not
advisory)"** (`generate-round.md:24`), so when the brief's prose and the
block's file-count band conflict, the model has been told the block wins.

**What the model controls vs. not**: it picks the domain, module decomposition,
bug, test names, spec text, and rubric expectations. It does not pick the check
kind, the test-count band, the manifest schema, or the round-spec JSON.
`round_type` in the manifest is always the literal `"debugging"` regardless of
the round's real shape (legacy field; `resolveRoundSpec` is the real read path).

**Validation** (`validate.ts`): `checkManifest` proves manifest shape,
planted-bug coherence, spec length, expectation concreteness; the suite is
actually run and `checkSuiteAgainstKind` (:232) proves the failure pattern
(≥8 tests and exactly one failure for `one_failing_test`, etc.). **File count
is never validated** — the "4 to 8 source files" language exists only in the
prompt. Success writes `.validated`; failure writes `.failed` and the timeline
offers retry.

---

## Stage 4 — Adaptation: "what I learned" → new specs

**Entry**: the "+ add what you learned" box on a target page → `POST
/api/adapt` (preview, writes nothing) → `POST /api/adapt/apply` (persists).

**What the adapt LLM sees** (`adapt.ts` `buildPrompt` :323): exactly two
things — one summary line per current spec (`specLine`) and the user's raw
`material`. It returns new round drafts in the same flat schema as intake,
each optionally naming `supersedes`.

**What apply does** (`applyAdaptation`, `adapt.ts:234-264`):

- **Specs are append-only.** New specs are pushed onto `target.specs`; an
  existing spec object is never mutated, and id collisions are rejected.
  Supersession is recorded on the adapt record, not on the spec — the old spec
  remains in `target.specs` and remains loadable by id.
- **Only `pending` and `failed` items are re-pointed** (`RESHAPEABLE`,
  `adapt.ts:151`): their `spec_id`, `label`, and `planned_title` are updated
  to the new spec.
- **`ready` items are only flagged** (`item.stale = true`) — their `spec_id`
  is NOT changed.
- `done` / `generating` / `skipped` items are untouched.
- The apply route revalidates every new spec through `validateRoundSpec`
  before writing `target.json` then `queue.json`.

**What survives of the user's note**: the material is consumed by one LLM call
and persisted only as a 280-character `material_excerpt` on the adapt record
(display + crash recovery). It is **never appended to `target.context` or
`target.description`**, so any detail the adapt model chose not to encode into
the new spec's `emphasis` is unrecoverable downstream. `emphasis` is also not
in the adapt tool's `required` list — the model may omit it silently.

---

## Stage 5 — Regeneration: which spec does a rebuild use?

`/api/rebuild` (stale ready item) and `/api/retry` (failed item) both
regenerate under **`item.spec_id` as it currently stands** (`app.ts:853-857`,
`:899`). The CLI re-reads `target.json` at generation time, so later *edits*
to a spec object would be picked up — but spec objects are never edited
(append-only), so in practice the spec identity on the item is everything.

Consequences, stated plainly:

- For a **failed** item: correct. Adaptation already re-pointed it, so retry
  generates under the new spec.
- For a **stale ready** item: **the rebuild regenerates under the superseded
  spec.** Adaptation flagged it but did not re-point it; rebuild clears the
  flag and calls `generate-for` with the old `spec_id`, which still resolves
  (append-only specs never disappear). The UI copy — *"built for the old round
  shape — still startable, or rebuild it to match the plan"*
  (`client/app.js:403`) — promises the opposite of what the code does.

---

## Field reference: every channel that can carry user intent into generation

| # | Field | Written by | Reaches the generation prompt? | How |
|---|---|---|---|---|
| 1 | `RoundSpec.emphasis` | intake/clarify/adapt LLM | **yes** | `Emphasis: …` in ROUND_BRIEF **and** inside ROUND_SPEC_JSON |
| 2 | `RoundSpec.label` | same | **yes** | `Round: …` in ROUND_BRIEF |
| 3 | `Target.description` | user, at intake, verbatim | **yes** | `The candidate describes it as: …` |
| 4 | `Target.context` | user, at intake, verbatim | **yes** | `Reference material from the candidate: …` |
| 5 | `QueueItem.planned_title` | plan-topics LLM | **yes** | `--title` → "build exactly this system" |
| 6 | Gap-graph note | `buildTargetNote` from session history | **yes** | `{{TARGET_NOTE}}`; behavioral only |
| 7 | Adapt `material` (the "what I learned" note) | user | **no** | one LLM call → `emphasis` on a new spec; raw text discarded (280-char excerpt kept for display) |
| 8 | `AdaptRecord.summary` / `rationale` | adapt LLM | no | display only |
| 9 | `QueueItem.note` | re-pacing | no | display only, by documented design |
| 10 | `Target.research` | dead feature | no | zero readers |

The closed capability vocabulary (interviewer / can_run_tests / time_limit /
starts_from / submit / surface / check.kind) always reaches generation via
ROUND_SPEC_JSON and is enforced by the validator and the session runtime.

---

## Case study: the Palantir learning-round adaptation (2026-08-05)

Material: *"Task is one page w/ couple hundred lines of code, debug in
python"*.

What happened, verified on disk:

1. Adapt created `palantir-learning-round-debug-python` with emphasis
   *"Debugging a single ~few-hundred-line Python file; likely
   concurrency/async…"* — the laundering **worked**; both learnings made it
   into the new spec's emphasis.
2. Items 3–6 (pending) were re-pointed to the new spec. Item-2 (ready) was
   flagged stale only.
3. The user pressed rebuild on item-2. It regenerated **under the superseded
   `palantir-learning-round`** (manifest written 7 minutes after that spec was
   retired still embeds the old spec id and old emphasis) — Stage-5 limitation.
4. Even under the new spec, the size intent would have been fighting
   `{{CHECK_REQUIREMENTS}}`'s "4 to 8 source files / 8 to 15 tests", framed as
   non-advisory. Result: `runtime: python` (language survived — it has an
   explicit prompt line telling the model to read the brief) and 11 files /
   747 lines (size lost — no such line exists, and the constant is declared to
   win).

---

## Current limitations, in one list

1. **Size/shape is a hardcoded constant that outranks user intent.** The
   per-check-kind file and test bands (`generate.ts:26-84`) are presented to
   the model as validator-enforced. Prose in the brief cannot beat them. (The
   validator enforces the *test* pattern but never counts files.)
2. **Stale-ready rebuilds regenerate the old shape.** Flagging does not
   re-point; rebuild uses the unchanged `spec_id`; the button copy claims
   otherwise. Verified live on `palantir-ms9y4guw/item-2`.
3. **Language and scale have no home in the closed vocabulary.** Language
   works in practice only because of one prompt line telling the model to read
   the brief; scale has no such line and no field.
4. **The raw adaptation note is unrecoverable after one LLM call.** Only a
   280-char excerpt survives, for display. Anything the adapt model dropped is
   gone; `emphasis` is optional in its tool schema.
5. **`round_type` is frozen at `"debugging"`** in every manifest regardless of
   the round's real shape; the judge still resolves expectations off it.
6. **`min_tests` is the only numeric knob** on a spec, and the
   `one_failing_test` requirement block ignores it (hardcodes 8–15).
7. **Generated dirs accumulate host artifacts** (`__pycache__` from two
   Python versions) that appear in the candidate's file tree.
8. **`Target.research` is written but never read** (dead field on older
   targets).
