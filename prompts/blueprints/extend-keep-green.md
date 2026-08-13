# Blueprint: extend-without-breaking round

<!-- Starter skeleton. The drafter rewrites every section for the specific
     round; the headings are load-bearing (gateBlueprint requires all of
     them). Written as a filled example, not blanks — overwrite the prose.
     Delivery facts (surface, clock, submit style, interviewer presence) are
     injected by the drafter prompt from the spec — describe the TASK here
     and stay consistent with those facts; never contradict them. -->

## What this round is

An extend-or-refactor round on a WORKING system: the candidate opens a
codebase whose full suite is green and must add a capability or restructure
a seam without breaking anything that already works. The graded artifact is
regression safety — reading the existing behavior before writing, choosing a
seam that fits the current design, and leaving every original test green
while the new behavior's tests go green too. This is the round senior loops
use to see engineering judgment on real code rather than invention from
scratch.

## Environment

TypeScript with vitest (or Python with unittest when the target calls for
it), suite runnable throughout when the delivery permits — the green bar is
the contract the candidate must protect. Repo scale: a small working
package, a few hundred lines.

## Repo shape

A complete working system with a passing behavioral suite, structured so the
extension has one natural seam and at least one tempting-but-wrong shortcut
(a place where hacking the new behavior in breaks an existing guarantee).
The new capability's tests ship in the repo, initially skipped or clearly
marked, so "done" is mechanical: old suite green, new tests green.

## What the candidate does

Runs the suite first to see green, reads the modules the change touches,
states the seam they intend to use and why, then implements the extension —
running the old tests as they go, treating any new red as a stop-the-line
event. Strong candidates narrate the blast radius before editing and prefer
small reversible steps over rewrites.

## Difficulty calibration

The extension itself is modest for a strong new grad; the difficulty is the
constraint. The tempting shortcut must genuinely break an existing test so
the round distinguishes candidates who read from candidates who patch. No
algorithmic cleverness — the challenge is fitting new behavior into an
existing design without collateral damage.

## Topic guidance

Working systems with clear invariants to protect: a cart/pricing module
gaining a new discount type, a scheduler gaining priorities, a cache gaining
TTLs, a parser gaining a new syntax form, a notification router gaining a
channel — in the domain the candidate's material names.

## Interviewer engagement

When present, lightly led: ask for the plan before code ("which seam, and
what could it break?"), watch whether they run the existing suite unprompted,
and probe at any red bar — do they stop and read, or push forward? Reward
stated blast-radius thinking. When the spec has no interviewer, say so
plainly; the suite's green/red history carries the signal.

## Learnings log

<!-- Append-only. Dated entries, verbatim quotes from the candidate's
     material. Never delete or rewrite existing entries. -->
