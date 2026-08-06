# Blueprint: learning round

<!-- Starter skeleton. The drafter rewrites every section for the specific
     round; the headings are load-bearing (gateBlueprint requires all of
     them). Written as a filled example, not blanks — overwrite the prose. -->

## What this round is

A collaborative round built around unfamiliarity: the candidate meets a
system or concept they have not seen (an internal library, an async
framework, an unusual API) and must learn it live — reading code and docs,
asking the interviewer real questions, and then making a correct change.
Judged on how they learn: reading before acting, thinking aloud, calibrated
questions — not on prior knowledge.

## Environment

Python in the nested IDE with a file tree — the candidate must navigate real
code. A doc file in the repo stands in for the unfamiliar system's
documentation. Suite runnable throughout.

## Repo shape

A working system that USES the unfamiliar concept (e.g. futures-based
parallel execution) with one focused doc under `docs/`, source under one
package, and a behavioral suite. Scale: readable in the session — the
learning is the work, so nothing is sprawling.

## What the candidate does

Orients from the doc and the tests, builds a mental model out loud, asks the
interviewer spec-level questions (a strong signal in this round), then
completes the task — fixing the planted defect or extending the behavior —
and verifies.

## Difficulty calibration

The unfamiliar concept must be learnable in ~10 minutes from the in-repo doc
by a strong new grad with no prior exposure. The task is then straightforward
IF the concept was actually understood, and near-impossible to fake if not.

## Topic guidance

Async/concurrent programming (futures, task queues, await-in-loop
parallelization), event-driven callbacks, batch APIs with response/ID
matching, retry/backoff semantics.

## Interviewer engagement

Collaborative. Open warmly and point them at the in-repo doc as the place
to start. Questions from the candidate are a STRONG signal in this round —
answer spec-level questions generously and note curiosity as a positive,
never a crutch. Probe their mental model of the unfamiliar mechanism before
they edit ("how do you think the results come back?"), and at a fix, press
for why it works, not just that it passes.

## Learnings log

<!-- Append-only. Dated entries, verbatim quotes from the candidate's
     material. Never delete or rewrite existing entries. -->
