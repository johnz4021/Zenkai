# Blueprint: HackerRank-classic online assessment

<!-- Starter skeleton. The drafter rewrites every section for the specific
     round; the headings are load-bearing (gateBlueprint requires all of
     them). Written as a filled example, not blanks — overwrite the prose. -->

## What this round is

A timed, unproctored online assessment in a browser pane editor: problem
statement on the left, editor on the right, graded once at submit. Nobody
replies; the candidate manages their own time. Fidelity target is the
HackerRank/CodeSignal classic experience, including the pressure of no
feedback until the end.

## Environment

Python (stdlib only, unittest) in the panes surface — a single editor, no
terminal, no file tree beyond a couple of tabs. Time-boxed. The suite runs
once, server-side, at submit.

## Repo shape

Minimal: one solution file the candidate fills in (a scaffold with function
stubs and docstrings) and one test file defining the contract. No supporting
modules — the whole problem fits on one screen of scaffolding.

## What the candidate does

Reads the statement, implements the stubbed functions against the documented
contract, dry-runs mentally (no iteration runs on one-shot rounds), and
submits once. The work is algorithmic: correctness on edge cases and stated
complexity bounds.

## Difficulty calibration

LeetCode-medium equivalent, sized so a prepared new grad finishes with margin
inside the time cap. Edge cases are discoverable from the statement, never
hidden gotchas. One problem per session.

## Topic guidance

Classic OA fare: array/string manipulation with a twist, hashmap counting,
two-pointer/sliding window, BFS on grids, interval merging, simple DP.

## Interviewer engagement

None — this round is autograded and unproctored. Nobody replies during the
session; the candidate manages their own time. (This section exists so the
recipe says the absence out loud instead of leaving it implied.)

## Learnings log

<!-- Append-only. Dated entries, verbatim quotes from the candidate's
     material. Never delete or rewrite existing entries. -->
