# Blueprint: low-level design build round

<!-- Starter skeleton. The drafter rewrites every section for the specific
     round; the headings are load-bearing (gateBlueprint requires all of
     them). Written as a filled example, not blanks — overwrite the prose. -->

## What this round is

An implement-to-a-contract round: the candidate receives a scaffold and a
visible behavioral test suite that all fail, and builds the classes/functions
until the suite passes. What is being judged is API design sense, incremental
progress against a suite, and clean state modeling — the tests ARE the spec.

## Environment

TypeScript with vitest (or Python with unittest when the target calls for
it), runnable repeatedly — iterating against the suite is the whole point.
Repo scale: one small package, a few hundred lines when complete.

## Repo shape

A scaffold with the public API stubbed (types/signatures present, bodies
throwing or returning placeholders), a complete visible test suite, and a
short README stating the domain contract in a paragraph.

## What the candidate does

Reads the suite to extract the contract, implements in dependency order,
runs early and often, and narrates design decisions (where state lives, what
is validated where). Strong candidates get a subset green quickly rather than
attempting a big-bang finish.

## Difficulty calibration

Completable by a strong new grad in the session with the last tests requiring
genuine care (an ordering guarantee, an eviction rule, an idempotency case).
No algorithmic cleverness required — the difficulty is modeling, not
complexity.

## Topic guidance

Bounded stateful components: parking lot / booking systems, LRU-style caches,
rate limiters, order books, versioned key-value stores, undo stacks.

## Learnings log

<!-- Append-only. Dated entries, verbatim quotes from the candidate's
     material. Never delete or rewrite existing entries. -->
