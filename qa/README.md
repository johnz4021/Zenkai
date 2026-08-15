# qa/ — the model-free doors harness

Run the whole product — both intake doors, generation, validation, sessions,
the judge — with **zero API calls** and **disposable state**. Born from the
2026-08-15 doors QA: the binder incident escaped the first QA pass because
agents were forbidden every stateful action; pressing every door safely needs
a scratch state root and free, deterministic model calls.

Three pieces:

- **`fake-claude.mjs`** (+ `shim-bin/claude`) — a PATH shim serving every
  `claude -p` caller in the tree. Dispatches on each prompt template's first
  line; the generator handler writes an artifact that passes `validateProblem`
  by construction. Steer per-request with `[QA:key=value]` tokens typed into
  descriptions (they ride clarifier prompts, and the blueprint handler
  re-emits them into generation briefs), or globally via `$QA_SHIM_CONTROL`
  (a JSON file). Every call logs to `$QA_SHIM_LOG` — the zero-API proof.
- **`scratch-app.mts`** — boots this checkout's app on `:3301`/`:3201`
  (override with `QA_APP_PORT`/`QA_SESSION_PORT`).
- **`seed-conversation.mjs`** — writes a stored planner proposal so
  `/api/accept-spec` runs with full input control despite the conversational
  planner needing an API key.

## Setup

```bash
git worktree add /tmp/zenkai-qa beta
cd /tmp/zenkai-qa && npm install        # its OWN install — never symlink
                                        # node_modules (workspace links would
                                        # escape to the main checkout's shared/)
ln -s ~/Documents/GitHub/interview_prep/datasets datasets   # optional: makes
                                        # LC sourcing live (lcReady). Read-only.
chmod +x qa/shim-bin/claude
```

## Boot

```bash
cd /tmp/zenkai-qa
env -u ANTHROPIC_API_KEY \
  IP_MULTI_SESSION=1 IP_VOICE=0 IP_PREPARE_NEXT=0 \
  QA_SHIM_CONTROL="$PWD/qa/.shim-control.json" \
  QA_SHIM_LOG="$PWD/qa/.shim-log.jsonl" \
  PATH="$PWD/qa/shim-bin:$PATH" \
  npx tsx qa/scratch-app.mts
```

- **No `ANTHROPIC_API_KEY`** anywhere in the env (the Claude Code harness
  shell exports a stale one — `env -u` it). Every model module then falls
  back to `claude -p`, which the PATH shim intercepts. Children inherit env,
  so one boot covers app + sessions + spawned generators.
- **Auth off** = leave the Supabase trio unset (a worktree has no `.env`).
- **Paywall runs**: add `IP_PAYWALL_GATE=1 IP_PAYWALL_FREE_ROUNDS=<n>
  IP_PAYWALL_FREE_PLANS=<n>` (0 is meaningful — gates immediately).
- The conversational planner (`/api/plan/turn`) 501s by design — that IS the
  no-key behavior; drive `/api/accept-spec` via `seed-conversation.mjs`.

## Constraints

- **One instance launches Docker sessions at a time**: the session sweeper
  reaps containers by the global `ip-session-` name prefix, and every
  instance's registry allocates ports from `:3401` — two instances running
  sessions concurrently WILL collide. API-only QA parallelizes fine.
- First session launch in a fresh worktree pays the `ip-ide` image build and
  an extension esbuild.
- The shim exits 1 on an unrecognized prompt marker, on purpose: a new model
  caller must get a handler, never a silent fake. If a build suddenly fails,
  read `qa/.shim-log.jsonl` first.
- The shim's generator writes python-unittest artifacts only (the cheapest
  shape the validator accepts). TS/vitest rounds still *bind and queue*
  normally; only the generated fixture is python.

## Steering reference

`[QA:…=…]` tokens (per-request, in any pasted description) or
`.shim-control.json` keys (global):

| Key | Effect |
|---|---|
| `task`, `check`, `starts_from`, `submit`, `surface`, `time`, `interviewer`, `msf` | shape the clarifier draft (`time=null` for untimed; `interviewer=1`) |
| `parts=N`, `named=a,b` | stated part count / named problems on the draft |
| `rounds=N`, `bad_draft=1` | N sibling drafts / add one out-of-vocabulary draft the gate must drop |
| `fail=generate` / `fail=generate_dead` | generator dies in-band (`error_max_turns`, exit 0) / dies cold (exit 1) |
| `fail=validate` | generator writes an artifact with a too-short spec — validation fails, the repair pass triggers; the repair handler fixes it in place |
| `repair_noop=1` (control file only — repair prompts carry no paste tokens) | repair changes nothing, exercising the failed-repair path |
| `verdicts=weak,adequate,…` (×6), `solved=0` | judge output, in dimension order (clarify, approach, communicate, implement, verify, reflect) |
| `say=…`, `intent=yes` | interviewer line / route utterances to the interviewer |
| `adapt_round=<id>:<check_kind>:<supersedes>` | adaptation that re-points a spec |

Tear down: kill the app, `git worktree remove --force /tmp/zenkai-qa`.
