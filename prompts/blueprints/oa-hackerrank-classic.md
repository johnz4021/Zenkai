# Blueprint: algorithmic problem set

<!-- Starter skeleton. The drafter rewrites every section for the specific
     round; the headings are load-bearing (gateBlueprint requires all of
     them). Written as a filled example, not blanks — overwrite the prose.
     Delivery facts (surface, clock, submit style, interviewer presence) are
     injected by the drafter prompt from the spec — describe the TASK here
     and stay consistent with those facts; never contradict them. -->

## What this round is

A problem-set round: the candidate works through one or more short,
independent, statement-driven algorithmic problems, each with a documented
contract and sample cases. Correctness on edge cases within stated bounds is
the graded artifact. This is the classic screening task the volume platforms
run; when the candidate's material describes MULTIPLE PARTS (a part 1/2/3
ladder, escalating variants of one theme), the set MUST carry that structure:
same count of parts, same escalation, each part's statement standing alone.

## Environment

Python (stdlib only, unittest) unless the candidate's material pins another
language. Each problem is self-contained: a solution file with function stubs
(one-line docstrings — the statement carries the contract), and a test file
defining the contract from the statement's sample cases plus edge cases.

## Repo shape

Minimal per problem: one solution file the candidate fills in and one test
file per part. No supporting modules — each part's whole surface fits on one
screen of scaffolding. Multi-part sets keep one pair of files per part, named
so the ladder is obvious (part1_*, part2_*, …).

## What the candidate does

Reads each statement, implements the stubbed functions against the documented
contract, checks edge cases against the samples, and manages their own pacing
across parts — earlier parts are meant to be banked quickly so time remains
for the harder tail.

## Difficulty calibration

LeetCode-easy-to-medium equivalent per part, sized so a prepared new grad
finishes the set with margin inside the delivery's time budget. In a
multi-part ladder the escalation is real but continuous — part N reuses the
domain of part N-1 with added rules, never a discontinuous jump. Edge cases
are discoverable from the statement, never hidden gotchas.

## Topic guidance

Classic screening fare: array/string manipulation with a twist, hashmap
counting, two-pointer/sliding window, BFS on grids, interval merging, simple
DP — skinned in whatever domain theme the candidate's material names.

## Interviewer engagement

Typically none — this task usually ships autograded and unproctored, and when
the spec says so, state the absence out loud: nobody replies; the candidate
manages their own time. If the spec DOES include a live interviewer, they
observe pacing and probe edge-case reasoning between parts, never hinting at
solutions.

## Learnings log

<!-- Append-only. Dated entries, verbatim quotes from the candidate's
     material. Never delete or rewrite existing entries. -->
