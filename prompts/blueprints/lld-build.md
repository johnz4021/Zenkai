# Blueprint: practical build round

<!-- Starter skeleton. The drafter rewrites every section for the specific
     round; the headings are load-bearing (gateBlueprint requires all of
     them). Written as a filled example, not blanks — overwrite the prose.
     Delivery facts (surface, clock, submit style, interviewer presence) are
     injected by the drafter prompt from the spec — describe the TASK here
     and stay consistent with those facts; never contradict them. -->

## What this round is

A build-a-small-system round: the candidate implements a working component —
a rate limiter, an in-memory key-value store with expiry, a booking engine, a
pricing/discount calculator — against requirements that ARRIVE IN STAGES.
The defining property is evolution: stage 1 states a base contract, each
later stage adds rules that stress the earlier design, and what is graded is
whether the code stays correct as requirements grow. When the candidate's
material names its stages, the blueprint MUST carry them: same count, same
escalation, later stages building on earlier code, all under one budget.

## Environment

TypeScript with vitest (or Python with unittest when the target calls for
it), with the suite runnable when the delivery permits iteration. Repo
scale: one small package, a few hundred lines when complete.

## Repo shape

Two legitimate variants — pick from the candidate's material. CONTRACT-GIVEN:
public API stubbed (types/signatures present, bodies throwing) with a
complete visible test suite; the tests are the spec. SPARSE-SPEC: a short
statement per stage and a thinner suite, where naming, decomposition and
interface choices are the candidate's to make — the design decisions are
part of the graded artifact. Either way, a short README states the domain
contract in a paragraph.

## What the candidate does

Reads the stage-1 contract (from the suite or the statement), implements in
dependency order, and moves through the stages in sequence — reworking
earlier code when a later stage's rules demand it, which is the point.
Strong candidates get a subset green quickly rather than attempting a
big-bang finish, and say out loud where state lives and what validates
where.

## Difficulty calibration

Stage 1 completable quickly by a strong new grad; the last stage requires
genuine care (an ordering guarantee, an eviction rule, an idempotency case,
a rule interaction that breaks a naive stage-1 design). No algorithmic
cleverness required — the difficulty is modeling and evolution, not
complexity.

## Topic guidance

Bounded stateful components: pricing/discount engines, parking lot / booking
systems, LRU-style caches, rate limiters, order books, versioned key-value
stores, undo stacks — skinned in the domain the candidate's material names.

## Interviewer engagement

Moderately led when present. Open by framing the staged premise. Probe design
decisions BEFORE code exists — where state lives, what validates where — and
at each stage boundary ask what the new rules break in the old design.
Reward incremental progress over big-bang attempts; press when they code
ahead of a stated design. When the spec has no interviewer, say so plainly:
the stages alone carry the escalation.

## Learnings log

<!-- Append-only. Dated entries, verbatim quotes from the candidate's
     material. Never delete or rewrite existing entries. -->
