# Blueprint: code review round

<!-- Starter skeleton. The drafter rewrites every section for the specific
     round; the headings are load-bearing (gateBlueprint requires all of
     them). Written as a filled example, not blanks — overwrite the prose.
     Delivery facts (surface, clock, submit style, interviewer presence) are
     injected by the drafter prompt from the spec — describe the TASK here
     and stay consistent with those facts; never contradict them. -->

## What this round is

A review round: the candidate is shown a proposed change to a working
codebase — a diff, presented as authored by a teammate or by an AI coding
tool — and must review it the way the job demands: find the defects, rank
them by risk, articulate what would break in production and under what
input, and say plainly whether they would approve, block, or request
changes. Reading code critically IS the graded artifact; with most new
industry code now machine-generated and human-reviewed, this task is the
job skill, not a proxy for one.

## Environment

Python or TypeScript per the candidate's material. The repo contains the
base system AND the change (already applied on top, with the diff summary
in the README or a CHANGES file naming the files touched), so the candidate
can read the change in context and, when the delivery permits, run the
suite to test their hypotheses.

## Repo shape

A small working system plus one coherent multi-file change of reviewable
size (roughly 50-150 changed lines across 2-4 files). The change bundles a
plausible feature or fix with 2-4 planted defects of MIXED severity — one
that corrupts behavior under a specific input, one subtle contract break, a
performance or resource slip, and one harmless style nit as a decoy for
calibration. The suite as shipped passes: the defects live where the tests
do not look, which is the point.

## What the candidate does

Reads the change against the base (files in context, not just the diff
lines), traces the inputs that reach the changed paths, names each finding
with its blast radius and a concrete failing input, distinguishes must-fix
from nit, and delivers a verdict a teammate could act on. Strong candidates
test a hypothesis (a quick run, a targeted case) rather than asserting from
style, and review what the change MEANS, not how it is formatted.

## Difficulty calibration

The must-find defect should be catchable by a strong new grad who actually
traces the data flow; the subtle one should reward senior instincts (an
invariant broken two calls away). Findings must be provable from the code in
front of them — never trivia about libraries not present. Severity ranking
matters as much as detection: flagging everything equally is a miss.

## Topic guidance

Changes with consequence-bearing surface: cache or session invalidation,
pagination or off-by-one boundaries, error-path swallowing, concurrency
around shared state, unit or currency conversions, permission checks —
skinned in the domain the candidate's material names.

## Interviewer engagement

When present, socratic: ask for overall verdict first, then findings in
severity order; for each, ask "what input makes this fail?" and let them
run it when they claim it. Push back once on a correct finding to test
conviction, and probe the decoy — do they defend flagging a nit as
blocking? When the spec has no interviewer, say so plainly: the written
review (findings, severities, verdict) is the submitted artifact.

## Learnings log

<!-- Append-only. Dated entries, verbatim quotes from the candidate's
     material. Never delete or rewrite existing entries. -->
