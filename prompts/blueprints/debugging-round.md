# Blueprint: debugging round

<!-- Starter skeleton. The drafter rewrites every section for the specific
     round; the headings are load-bearing (gateBlueprint requires all of
     them). Written as a filled example, not blanks — overwrite the prose.
     Delivery facts (surface, clock, submit style, interviewer presence) are
     injected by the drafter prompt from the spec — describe the TASK here
     and stay consistent with those facts; never contradict them. -->

## What this round is

A find-and-fix round: the candidate opens a working-looking codebase where
exactly one behavior is broken and one test fails. What is graded is how the
fault gets localized — reading the failure before touching code, forming a
mechanism-level hypothesis, and verifying the fix — more than whether they
finish fast. The classic debugging screen, and the round the industry leans
on hardest now precisely because it resists shortcutting: the code must be
read and the discrepancy explained.

## Environment

TypeScript with a vitest suite (or the language the candidate's material
pins), with a runnable suite. Repo scale: a small multi-module package,
roughly 300-600 lines of source total. No network, no database — pure logic
and in-memory state.

## Repo shape

A handful of source modules under `src/` with one clear domain (e.g. a
reservation ledger, a rate limiter), a behavioral test suite under `test/`,
and a README naming the domain. The buggy file looks as innocent as its
neighbors; nothing in naming or comments points at it.

## What the candidate does

Runs the suite (it fails once at kickoff), reads the failing test's diff,
traces the behavior to a mechanism, edits, re-runs, and confirms green without
breaking the rest. Strong candidates narrate the failure reading and commit to
a hypothesis before editing.

## Difficulty calibration

A strong new grad should localize the bug in 15-25 minutes. The bug is a
plausible engineering mistake (off-by-one on a boundary, stale cache entry,
wrong quantity released), never a typo or a trick. Every module is readable in
one sitting.

## Topic guidance

Stateful domains where a subtle quantity or ordering mistake produces a clean
observable failure: inventory holds, schedulers, caches with expiry, retry
queues, billing accumulators.

## Interviewer engagement

When present, restrained. Open by framing the broken-behavior premise, then
let them drive. Probe method at the flagged moments — what the failure
output said, what a change was meant to fix — and press for a mechanism when
they name only a location. Reward reading before editing and stated
hypotheses; do not reward speed. When the spec has no interviewer, say so
plainly; the think-aloud trace carries the method signal.

## Learnings log

<!-- Append-only. Dated entries, verbatim quotes from the candidate's
     material. Never delete or rewrite existing entries. -->
