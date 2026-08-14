# Blueprint: unfamiliar-codebase comprehension round

<!-- Starter skeleton. The drafter rewrites every section for the specific
     round; the headings are load-bearing (gateBlueprint requires all of
     them). Written as a filled example, not blanks — overwrite the prose.
     Delivery facts (surface, clock, submit style, interviewer presence) are
     injected by the drafter prompt from the spec — describe the TASK here
     and stay consistent with those facts; never contradict them. -->

## What this round is

A comprehension round: the candidate is dropped into a working codebase they
have never seen and must make sense of it before changing it — read the
structure, trace the behavior, then complete a concrete task in it (fix a
planted defect, make a focused improvement, or extend a behavior). What is
graded is how they work in code that is not theirs: reading before acting,
tracing data flow out loud, and grounding every change in something the code
actually does rather than what they assume it does.

## Environment

Python (or the language the candidate's material pins) in a workspace with a
real file tree — navigating unfamiliar structure is part of the task. A
short doc in the repo stands in for the system's documentation when the
domain needs one. Suite runnable when the delivery permits it.

## Repo shape

A small working system of several modules — enough structure that
orientation is real work, small enough to be readable within the session
(a few hundred lines across 4-8 files). One focused doc under `docs/` when
the domain warrants, source under one package, and a behavioral suite that
documents what the system promises.

## What the candidate does

Orients from the tests, the doc, and the entry points; builds a mental model
and says it out loud; then completes the concrete task — localizing the
defect or seam, making the change, and verifying against the suite. Strong
candidates read breadth-first before depth-first and can say what a module
is FOR before opening it.

## Difficulty calibration

The codebase must be comprehensible in the first third of the session by a
strong new grad with no prior exposure — unfamiliar, never obfuscated. The
task is then straightforward IF the system was actually understood, and
near-impossible to complete correctly if not. Difficulty lives in the
comprehension, not the edit.

## Topic guidance

Systems whose behavior takes reading to predict: async/concurrent flows
(futures, task queues), event-driven callbacks, caching layers with
invalidation, retry/backoff semantics, state machines, batch APIs with
response matching — in the domain the candidate's material names.

## Interviewer engagement

When present, collaborative: point them at the repo's entry points, answer
spec-level questions generously (calibrated questions are a STRONG signal in
this task, never a crutch), and probe their mental model before they edit —
"how do you think the results come back?" At a fix, press for why it works,
not just that it passes. When the spec has no interviewer, say so plainly;
think-aloud still carries the comprehension signal.

## Learnings log

<!-- Append-only. Dated entries, verbatim quotes from the candidate's
     material. Never delete or rewrite existing entries. -->
