# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An interview-prep system that generates practice rounds (a real repo with a planted
bug / a spec to implement), runs them live in a containerized VS Code or a
HackerRank-style panes surface with an LLM interviewer listening over voice, then
judges the recorded trace and accumulates a per-user gap graph that targets the next
problem. `docs/problem-generation.md` is the authoritative walkthrough of the
description → spec → blueprint → generated repo pipeline; read it before touching
anything in intake/blueprint/generate.

## Commands

```bash
npm test                                  # vitest, whole repo (~2s, no model calls)
npx vitest run server/src/judge.test.ts   # one file
npx vitest run -t "name of the test"      # one test by name
npx tsc -b shared server                  # typecheck (see caveat below)
node extension/build.mjs                  # bundle the trace-emitter extension
```

`npm run typecheck` is currently broken: it runs `tsc -b shared server extension`
but `extension/tsconfig.json` does not exist. Use `npx tsc -b shared server`.

Everything else is subcommands of one CLI (`npx tsx server/src/cli.ts <cmd>`):

```bash
cli.ts app                                   # home app on :3300 — targets, queues, launch
cli.ts session [problemDir]                  # run a live round (picks from pool if omitted)
cli.ts target add "Palantir onsite" --desc …  # season-program intake
cli.ts target infer <target-id> "…" --accept  # draft + confirm a RoundSpec, draft its blueprint
cli.ts blueprint <target-id> <spec-id>       # (re)draft a round blueprint — idempotent
cli.ts generate-for <target-id> [spec-id]    # generate a problem from a confirmed spec
cli.ts prepare | generate [dir]              # untargeted / gap-targeted pool generation
cli.ts validate <dir> | cli.ts pool          # mechanical problem check / list unused problems
cli.ts rejudge <session-id> [--record]       # re-judge a stored trace; --record writes gap + topic graphs
cli.ts eval-judge [--quick|--simulate|--resume]  # the judge gauntlet (REAL model calls)
cli.ts promote-fixture <session-id>          # confirmed session → golden regression fixture
cli.ts lc fetch | list | show <slug>         # vendored LeetCode dataset (pinned in lc-source.ts)
cli.ts lc verify <slug> [--generate] | --all-eligible  # prove conversion against the oracle (no model);
                                             #   --generate adds a real sourced build; the full sweep writes blocklist.json
```

Generation takes ~5 minutes per problem (an agentic `claude -p` run). Sessions need
Docker; the runtime pulls `gitpod/openvscode-server` and builds a derived image on
first use, and rebuilds the extension bundle automatically when its source is newer.

## Environment

`.env` at the repo root is loaded by `cli.ts` before anything reads `process.env`, and
the app passes its own env to sessions and generators it spawns — so one file reaches
the whole tree. A shell export still wins. See `.env.example`.

- `ANTHROPIC_API_KEY` — when set, every model-calling module uses the API directly;
  without it they shell out to `claude -p` (needs the Claude CLI authenticated). The
  conversational planner is the one exception: it requires the key and has no
  degraded mode (server-side web_search doesn't exist on the `claude -p` path).
- `ELEVENLABS_API_KEY` — voice (STT relay + TTS). Absent, sessions run text-only.
- `IP_VOICE=0`, `IP_INTERVIEWER=0`, `IP_USER_ID`, `IP_AUTORUN_TESTS=0`, `IP_PREPARE_NEXT=0` —
  per-session overrides.

## Architecture

Three npm workspaces: `shared/` (types + closed vocabularies, consumed as raw TS via
`main: ./src/index.ts`), `server/` (everything), `extension/` (the VS Code trace
emitter, esbuild-bundled into `dist/trace-emitter-0.0.1/`).

Three processes, three ports:

```
:3300  app.ts       persistent home — targets, intake, queues, launch. Holds NO
                    authoritative in-memory state; every /api/state reconciles from disk.
:3200  session.ts   one process per live round. Owns the container, the voice socket,
                    the interviewer loop, and proxies everything it doesn't route to :3100.
:3100  openvscode-server in Docker (or the panes surface, same container)
```

Sessions are separate processes on purpose: a session crash can't take the app down,
and the session keeps sole ownership of port 3200 and the container.

**Authoritative state lives on disk, never in memory.** Queue item status is derived
from marker files — `.generating` (carries `{pid, started_at}`; liveness is a signal-0
probe), `.validated`, `.failed`, `.used` (names the session that consumed the problem).
The app can be killed and restarted at any time; the worst case is a stale page.
Data dirs (all gitignored except `fixtures/` and `assessments/`): `targets/`,
`problems/`, `traces/` (append-only JSONL per session), `gaps/`, `assessments/`,
`feedback/`, `topics/` (per-user LC topic ledgers), `datasets/` (the vendored
LeetCode corpus — fetched, never committed).

**The two-artifact rule.** A `RoundSpec` (`shared/src/round-spec.ts`) is the closed
*ruler* — capabilities the session runtime enforces, the validator dispatches on, and
memory counts over. A blueprint (`targets/<id>/blueprints/<spec_id>.md`) is the open
*recipe* — a full markdown generation prompt. Never widen the closed vocabulary to
express something the blueprint can say in prose; the one enforceable size knob is
`check.max_source_files`. The round *task* (`blueprint.ts` `ROUND_TASKS` — which
skeleton generation drafts from) is deliberately RECIPE-SIDE: it routes generation and
nothing else, so it lives in clarifier output and the rep record, never in RoundSpec.

**Single sources of truth in `shared/`:** `dimensions.ts` (the six judge dimensions —
the judge prompt, gap graph, feedback card, and gauntlet all import from here),
`round-spec.ts`, `rubric.ts`, `trace.ts`, `test-command.ts`, `topics.ts` (the LC
topic-tag vocabulary — the topic ledger counts over it and `lc fetch` asserts the
dataset maps onto it with zero drops). Duplicating any of these silently makes the
eval gauntlet measure nothing.

**LC-sourced rounds.** A queue item or rep may carry `source: {kind:'leetcode',
slug}` — the build then converts a real problem from the vendored dataset instead of
inventing one: deterministic code emits the grading suite from pre-verified I/O
(`lc-convert.ts`; the generator NEVER authors tests on these builds, and cli.ts
re-emits them post-generation), the generator only skins the surface (statement,
naming) with the real statement fenced as private context. `mode: skinned` is the
default; `verbatim` is policy-gated. The manifest's `source` field is patched from
the dataset record and is what the topic ledger (`topic-graph.ts`, `topics/<uid>.json`)
records on. Bindings come from intake extraction (`named_problems` on both doors,
resolved mechanically by `lc-refs.ts`), from `lc-pick.ts` auto-sourcing (the default
for unnamed algorithmic rounds — memory-BLIND diverse picks; the topic ledger is read
only as a 14-day seen-window dedup), or from `POST /api/item/source`. Weakness-ranked
selection stays deferred (TODOS #40). Read `server/src/lc-source.ts` / `lc-convert.ts`
headers before touching any of it.

**The pipeline**, end to end:

```
intake/clarify ──► RoundSpec[] ──► queue (paced, no due dates) ──► blueprint
                                                                      │
                             generate.ts (agentic `claude -p`, opus) ◄─┘
                                        │
                          validate.ts (mechanical, no LLM) ──► .validated
                                        │
                          session.ts ──► trace (JSONL) ──► judge.ts ──► assessment
                                        │                                   │
                          interviewer.ts (live, reactive + pressure)   gap-graph.ts
                                                                            │
                                                            targets the NEXT generation
```

## Conventions that are load-bearing

**Every model-calling module has the same shape** (`judge.ts` is the canonical one,
copied by `blueprint.ts`, `plan-topics.ts`, `clarify.ts`, `intake.ts`, `adapt.ts`):
a pure exported gate that throws on bad output, `buildPrompt`, a forced tool call on
the API path, a `claude -p` fallback, and a `pickX()` that chooses on
`ANTHROPIC_API_KEY`. The model function is injectable end to end.

**Unit tests never call a model.** That's what the injectability buys. Anything that
needs real model calls is a CLI command instead — `cli.ts eval-judge` is the judge's
whole regression suite. `vitest.config.ts` excludes `problems/`, `targets/`, and
`spikes/` because generated problems contain deliberately-failing tests.

**No model output reaches state ungated, and no plan change lands unapproved.**
Spec inference → `validateRoundSpec`. Blueprint drafts → `gateBlueprint`. Adaptation
previews write nothing; only an approved diff applies. Specs are append-only — a new
shape supersedes an old one for future items only, so history keeps pointing at the
spec it actually ran under.

**Detection modules are pure and stateless over the trace** (`stuck.ts`, `adrift.ts`,
`moments.ts`, `ack.ts`, `addressing.ts`): no I/O, no clock reads, `nowMs` and
`sessionStartedAt` injected, no `Math.random`. A restart forgets nothing, and replay
is deterministic. Read each file's header before changing its thresholds — the
suppression rules are features (e.g. adrift must NOT fire when the region being read
contains the bug; stuck must NOT fire on reading or exploring).

**Judge/interviewer invariants.** The judge is blind to the gap graph (otherwise the
graph is self-confirming) but knows the planted bug; it never writes quoted text —
the renderer pulls verbatim from the trace via verified citations, so fabricated
quotes are structurally impossible. Judge failure is `UNASSESSED`, never a verdict,
and nothing is written to the gap graph. The interviewer knows the bug and is stopped
from leaking it by two independent defenses: the prompt, and the mechanical
unit-tested `leaksBugLocation()`. The session chrome is backend-driven only — it never
reads editor state from the IDE iframe.

**Prompts live in `prompts/*.md`**, loaded at runtime with `{{PLACEHOLDER}}`
substitution; `prompts/blueprints/` holds the git-tracked starter skeletons. Changing
a judge prompt bumps its hash, which invalidates gauntlet caches and version-stamps
new assessments so `rejudge` history stays comparable.

**Every module opens with a doc comment stating what it does, the data flow as ASCII,
and *why it exists* — usually citing the specific session id or review decision that
forced it.** These are the real design record (there is no README); match the style
when adding a module, and read them before changing behavior they describe.

`TODOS.md` holds deferred work with its reasoning and the named trigger that unblocks
each item.
