# How a practice problem comes to be

An objective walkthrough of the pipeline from "I have a Palantir interview" to a
generated repo on disk — every stage, every artifact, where each piece of user
intent travels. Rewritten for the round-blueprints refactor (2026-08-05); the
pre-blueprint version of this document, with its limitations list, is in git
history at commit `db3a1ad`.

```
description ──► intake/clarify LLM ──► RoundSpec[]        ──► queue (spec_id per item)
                        │                    │
                        │                    └─► blueprint drafter (detached, per spec)
                        │                              │
                        │                targets/<id>/blueprints/<spec_id>.md
                        │                              │
"what I learned" ──► learnings.md (verbatim) ──► adapt LLM ──► blueprint edits
                                                    │            + new specs (append-only)
                                                    │            + re-points (pending, failed, READY+stale)
                                                    ▼
                              generate-for: blueprint + planned title = the brief
                                                    │
                     prompts/generate-round.md + 4 substitutions ──► claude -p (opus, 80 turns)
                                                    │
                                    problems/<item>/ (repo + problem.json)
                                                    │
                                    validateProblem ──► .validated | .failed
                                    (incl. max_source_files count, __pycache__ swept)
```

The two-artifact rule: a **spec** is the closed *ruler* (capabilities the session
runtime enforces, the validator dispatches on, and memory counts over); a
**blueprint** is the open *recipe* (a rich markdown generation prompt, drafted by
an LLM, editable by adaptation and by hand). A spec means an **exercise form** —
"learning round: debugging" and "learning round: implement-from-docs" are two
specs on one target, each with its own blueprint. The queue round-robins across
specs; each queue item's `planned_title` is the topic slot within its form.

---

## Stage 1 — Intake: description → RoundSpec + blueprint

**Entry**: the "new target" flow. The user types a free-form `description` and
can paste reference material (`context`). `/api/clarify` runs the clarify
reasoner (up to 3 questions, draft rounds); `/api/accept-spec` persists the
confirmed result to `targets/<id>/target.json`, builds the queue (round-robin,
`proposeQueue`), names planned rounds (`plan-topics.ts`), and then **spawns a
detached blueprint draft per accepted spec** (`cli.ts blueprint <target>
<spec>` — idempotent, exits 0 when the file exists; drafter failure degrades to
the legacy brief and never blocks intake). The CLI intake path (`target infer
--accept`) drafts inline.

**The drafter** (`server/src/blueprint.ts`, prompt `prompts/draft-blueprint.md`)
rewrites a starter skeleton from the git-tracked library `prompts/blueprints/`
(debugging-round, oa-hackerrank-classic, lld-build, learning-round; keyword
match on label/emphasis, capability shape as fallback) against the spec and the
candidate's own words, quoting shape statements concretely. Gate:
`gateBlueprint` — ≥600 chars, all seven load-bearing H2s (What this round is /
Environment / Repo shape / What the candidate does / Difficulty calibration /
Topic guidance / Learnings log).

**What a RoundSpec contains** (`shared/src/round-spec.ts`):

| Field | Type | Vocabulary |
|---|---|---|
| `id`, `label` | free-form strings | display + file naming only |
| `capabilities.interviewer` | boolean | closed |
| `capabilities.can_run_tests` | boolean | closed |
| `capabilities.time_limit_ms` | number \| null | closed |
| `capabilities.starts_from` | `repo` \| `blank` \| `diff` | closed |
| `capabilities.submit` | `iterate` \| `one_shot` | closed |
| `capabilities.surface` | `ide` \| `panes` (optional; `resolveSurface` derives from `starts_from`) | closed |
| `check.kind` | 4 kinds | closed |
| `check.min_tests` | number (optional) | suite-size floor, honored by every kind |
| `check.max_source_files` | number (optional) | **the enforceable size knob** — validator counts candidate-facing source files (tests/harness excluded) |
| `memory_tags` | derived in code, never authored | closed |
| `emphasis` | free-form (optional) | legacy topical hint; the blueprint is the real recipe |

Language and repo shape deliberately stay OUT of the closed vocabulary: they are
blueprint prose, which generation is told is authoritative — plus the one
enforceable `max_source_files` knob when size must be a guarantee rather than a
request.

## Stage 2 — The plan: queue items bound to spec ids

Unchanged: `proposeQueue` round-robins runway across `target.specs` (≤12 items,
3/week), each `QueueItem` carrying `spec_id` (its binding to a form),
`planned_title` (the topic commitment), `status`, and the `stale` flag.

## Stage 3 — Generation: blueprint + title → repo

All trigger paths funnel to `cli.ts generate-for <target> <spec> --into <dir>
[--title]`. The brief (`composeRoundBrief`, `server/src/blueprint.ts`):

- **Blueprint exists** → the blueprint IS the round description, plus the
  planned-title commitment line. `description`/`context` are deliberately NOT
  re-appended — the drafter folded them in, and re-adding raw words would
  recreate the conflicting-prose problem.
- **No blueprint** (pre-blueprint specs, drafter failure) → the legacy
  five-part brief, byte-for-byte (pinned by test).

The prompt (`prompts/generate-round.md`) still takes four substitutions
(`{{ROUND_BRIEF}}`, `{{CHECK_REQUIREMENTS}}`, `{{ROUND_SPEC_JSON}}`,
`{{TARGET_NOTE}}`) and now states the **precedence rule**: the round
description governs shape/language/size/layout; the mechanical block governs
only the validator-proven test pattern; on conflict the description wins.

`{{CHECK_REQUIREMENTS}}` is `checkRequirements(check)` (`generate.ts`) — a
function of the spec's check, no longer a constant. The old "4 to 8 source
files" claim is gone (it was framed as validator-enforced and never was); test
floors interpolate `min_tests`; a max-files sentence appears exactly when
`max_source_files` is set, and that one is true — `checkManifest` counts via
`countSourceFiles` over the panes file-walker. `one_failing_test`'s suite floor
honors `min_tests` (default 8). Generated dirs are swept of `__pycache__`/
`*.pyc` before AND after validation (`removePythonArtifacts`).

Runtime selection is unchanged in mechanism (the model reads the brief; only
node/python exist) but the blueprint's Environment section now states the
language explicitly, so it is instruction rather than luck.

## Stage 4 — Adaptation: learnings in, recipe edits out

**The raw material is never lost again**: at apply time, before anything else,
the full note is appended verbatim with a dated header to
`targets/<id>/learnings.md` (`appendLearnings`).

The adapt LLM (`adapt.ts`, prompt `prompts/adapt-plan.md`) sees the active
specs AND their current blueprints (capped ~8K chars each), and answers with
two instruments:

- **`blueprint_edits`** — the common case: the material refines HOW an existing
  form looks (topic/size/language/difficulty) with no capability change. The
  round's complete revised blueprint, with the learning folded into the
  relevant sections and appended to its Learnings log. Recipe-only adapts
  never touch the queue.
- **`rounds`** — a genuinely different exercise form or a capability change:
  a new spec (append-only, `supersedes` optional) arriving WITH its complete
  blueprint (gate-required; a draft without one is dropped).

**Queue effects of a supersession**: `pending`/`failed` items re-point
round-robin as before. **`ready` items now re-point AND get `stale: true`** —
the fix for the pinned regression where the rebuild button regenerated a
retired spec because `item.spec_id` never changed. `done`/`generating`/
`skipped` stay untouchable.

**Writes at apply** (order deliberate): learnings.md → blueprint files (each
overwrite snapshots the previous version to `<spec_id>.prev.md`; `targets/` is
gitignored, so these ARE the history) → `target.json` (specs + AdaptRecord,
the commit marker) → `queue.json`. `AdaptRecord` gains optional
`blueprints_updated`; `reconcileAdaptation` is unchanged and compatible. The
apply route re-proves `gateBlueprint` server-side and tolerates old-shape
diffs from stale tabs.

**Preview UI**: spec boxes as before, plus "blueprint created/revised" rows
with an expandable view of the full markdown; nothing is written until the
user approves.

## Stage 5 — Regeneration

`/api/rebuild` and `/api/retry` regenerate under `item.spec_id` as before —
which is now correct for all cases, because adaptation genuinely re-points
superseded ready items. `generate-for` re-reads the target and the blueprint
file at generation time, so a hand-edit to a blueprint is picked up by the
next generation with no further ceremony.

---

## Field reference: every channel that carries user intent into generation

| # | Artifact | Written by | Reaches generation? | How |
|---|---|---|---|---|
| 1 | **Blueprint** (`targets/<id>/blueprints/<spec_id>.md`) | drafter at intake; adapt edits; hand-editable | **yes — it IS the round description** | `composeRoundBrief` → `{{ROUND_BRIEF}}` |
| 2 | `QueueItem.planned_title` | plan-topics LLM | yes | title commitment line |
| 3 | `check.max_source_files` | inference models or hand-set | yes + **enforced** | requirements block + validator count |
| 4 | `check.min_tests` | same | yes + enforced | requirements block + suite check |
| 5 | Gap-graph note | session history | yes | `{{TARGET_NOTE}}` (behavioral only) |
| 6 | `RoundSpec.emphasis` / `label` | inference models | yes (legacy path, no-blueprint fallback) | legacy brief |
| 7 | `Target.description` / `context` | user at intake | indirectly | folded into the blueprint by the drafter; raw only in the no-blueprint fallback |
| 8 | **`learnings.md`** | user, verbatim at adapt apply | indirectly | the adapt model folds entries into blueprints; the file itself is the loss-proof record |
| 9 | `<spec_id>.prev.md` | blueprint writes | no | single-level undo |
| 10 | `AdaptRecord` | apply | no | audit + crash repair |

## Standing limitations

1. **`round_type` is frozen at `"debugging"`** in every manifest; the judge
   still resolves expectations off it (out of scope of the blueprints work).
2. **`Target.research` is written but never read** (dead field on older
   targets).
3. Blueprint history is single-level (`.prev.md`) plus `learnings.md`;
   `targets/` has no git history by design.
4. The drafter runs detached from accept-spec with no UI surfacing of a
   failed draft — the degrade path (legacy brief) is silent. A "(no blueprint
   yet)" indicator is a known deferrable.
5. `checkExpectations`' vocabulary-overlap gate can in principle false-fail a
   terse single-file problem whose manifest spec runs short — the 150-300-word
   manifest spec requirement is the mitigation; watch early generations.
