# Memory layer — state of the world (2026-08-10)

An honest audit of the cross-session memory layer: the per-user gap graph that is
supposed to be the product differentiator — "session seven is smarter than session
one." Written against the code as of `interviewer-eyes-arc` and the real store in
`gaps/u1.json`. Companion to `docs/problem-generation.md`; the design record for the
rules cited here lives in the module doc comments (`server/src/gap-graph.ts` first).

## The claim

Every judged session writes dimension-level gaps (with the judge's analysis sentence
and verified evidence) into a per-user store. That store then (a) aims the next
generated problem, (b) briefs the live interviewer, (c) drives the feedback card and
the landing's focus line, and (d) closes gaps only on proven remediation. If all four
hold, memory is a loop, not a log.

## What is actually built — and it's real

**The store** (`server/src/gap-graph.ts`, `gaps/<user>.json`). Append-only session
records plus per-gap instance lists. The rules locked in review are all implemented
and unit-tested:

- Negative-only gap creation; adequate/strong counts only by absence.
- Recency weight `0.5^(sessionsAgo/5)`; rising/stable/fading states.
- Remediation (T11): a gap closes only after 3 consecutive *assessable* sessions
  where it didn't fire, and only if it existed before the streak began. Uninformative
  sessions (unassessable, or weak-with-all-citations-stripped) neither advance nor
  reset the streak. Closed gaps reopen on fire (D3).
- `UNASSESSED` writes nothing — judge failure never becomes history.
- Judge-era texture: each instance carries the judge's analysis sentence, round type,
  and the spec's closed-vocabulary `memory_tags`.

**The write path.** `session.ts` end-of-round → judge → `recordAssessment` →
`saveStore`, gated on `status === 'assessed'`. `cli.ts rejudge --record` can
backfill/replay. The judge is blind to the graph, so the graph cannot self-confirm.

**The read paths — the loop is genuinely closed in three places:**

1. **Generation.** `buildTargetNote()` turns the top active gap plus its last three
   analysis sentences into a targeting note. It reaches *every* generation route:
   post-session `prepare` (detached spawn with `IP_TARGET_NOTE`), `generate-for`,
   and rep-build. Session one gets a neutral problem (`undefined` note) instead of
   chasing noise.
2. **The live interviewer.** The note is injected as `TARGET_NOTE`, with a
   never-mention backstop (`leaksGapNote`, eng review T15) that only arms when a
   note was injected.
3. **Surfaces.** Feedback card renders observations-vs-patterns mode (D1, threshold
   3 sessions), the newly-closed event (D3), and the focus sentence. The app's
   landing shows the focus gap as a sentence, and `repace()` pins a `focus: <gap>`
   note on the up-next queue item.

That architecture is the differentiator working as designed, mechanically. Now the
honest part.

## What the real data says

One user (`u1`), seven recorded sessions, 2026-07-31 → 2026-08-08:

- **All six dimensions are active gaps. Zero have ever closed.** `communicate` has
  fired 7 of 7 sessions; `clarify` and `approach` 5 of 7. The remediation machinery
  is correct and has never once run to completion, because closure needs 3
  consecutive clean sessions and gaps fire nearly every session at the user's
  current level. The feedback surface can therefore only ever show bad news —
  improvement has no representation until the (so far unreachable) closure event.
- **When everything is a gap, "focus" degrades to "most frequent."** With 6/6 active
  and weights near-tied, `active[0]` is an unstable argmax; the targeting note aims
  at `communicate` every time and nothing rotates coverage or targets the second gap.
- **Early history is contamination-heavy.** Sessions 1–3 marked most dimensions
  uninformative (citation-stripped / unassessable), and the analysis sentences
  repeatedly cite "transcription unavailable." The evidence-gating rules did their
  job — but the upstream signal (voice capture) is the current bottleneck on how
  much true memory each session deposits.
- **The store has been re-baselined three times in ~10 days** (`gaps/archive/`:
  pre-honest-measurement, timesup-bug, label-era). Each reset was the right call,
  but it means comparable longitudinal history starts ~2026-07-31. The half-life and
  streak parameters have never been validated against a real multi-week arc.

## Gaps in the memory layer itself

Ranked by how much they undercut the differentiator claim:

1. **Negative-only memory cannot show progress.** There is no record of strengths or
   of a disposition axis (TODOS #1 — superseded into #7, unbuilt). Combined with
   zero closures, the user-visible story of the memory layer is a list of failures
   that only grows. A differentiator has to show the line going up.
2. **`memory_tags` are write-only.** The whole reason they exist — keeping "is my
   verify gap specific to timed rounds?" a countable question — has no counting code
   anywhere. No view, card, or targeting decision reads them back. Dead weight until
   a reader exists.
3. **Single-gap targeting with no tie-breaking or coverage policy.** `buildTargetNote`
   takes `active[0]` only. Needs at minimum: stability under near-ties, and a policy
   for the everything-is-weak regime (target the most *tractable* gap, or rotate).
4. **Memory is inert mid-session.** The interviewer gets a static note at spawn; the
   live-interruption-on-gap-fire half of design principle 3 (TODOS #2) is unbuilt,
   blocked on live classification.
5. **Only in-app sessions deposit memory.** External practice / self-reported
   debriefs don't feed the graph (deferred into the drills build, TODOS #13
   amendment). Real candidates do most reps elsewhere.
6. **No schema versioning or migration story.** The three archive resets *were* the
   migration mechanism. Fine at n=1 user; a liability the moment history is the
   product. (SQLite is already flagged in `gap-graph.ts` for multi-user.)
7. **Discovery surface is thin.** The gap-aimed composer suggestion (TODOS #31) is
   deferred, so the memory layer's presence on the landing is one sentence.

## Verdict

The plumbing is honest and closed: measurement is gated hard (no receipts → no
history), the loop from judged session → targeted next problem → briefed interviewer
→ feedback card exists end to end, and the invariants (judge blind to graph, no
leak paths, deterministic replay) hold. That's more than most "memory" features ship.

But as a *differentiator*, today it is: one user, ten days of comparable history,
six permanently-open gaps, a focus signal that has collapsed to a constant, one
write-only field, and no way to display improvement. The bottlenecks are not the
graph's math — they are (a) upstream signal quality (voice transcription is
starving the evidence gate), (b) the negative-only design meeting a user for whom
everything fires, and (c) the missing readers (`memory_tags` counting, strengths,
composer surface) that would make the stored texture visible.

## Sharpest next moves

1. **Give improvement a representation short of closure** — per-dimension trend from
   verdict history (weak→adequate is data the store already has), so the card can
   show movement now.
2. **Build the first `memory_tags` reader** — per-tag fired/clean counts behind the
   focus card. Cheap, and it converts a promise in a comment into a feature.
3. **Fix targeting under the all-weak regime** — deterministic tie-breaking plus a
   rotation or tractability policy in `buildTargetNote`.
4. **Attack transcription contamination** (TODOS #3, Silero VAD) — every
   uninformative dimension is a session that deposited nothing.

---

# Appendix: build-vs-buy — the 2026 memory-tool landscape

Researched 2026-08-10. The question asked: there is a well-funded startup category
building "persistent memory for agents" — does any of it help here?

**Short answer: don't adopt one as the store. Steal three specific ideas, and take
the pointer that matters most, which is not from this category at all.**

## Why the category is solving a different problem

Mem0, Zep, Letta, Honcho, Cognee, Supermemory and the rest converge on one shape:
*unstructured conversation in → an LLM extracts salient facts → dedupe/reconcile
against stored facts → retrieve the relevant few by hybrid semantic search at
inference time.* Three of that shape's load-bearing assumptions are false here.

1. **Their write path is LLM-inferred and ungated — ours must not be.** Mem0's
   update phase explicitly delegates the `ADD`/`UPDATE`/`DELETE`/`NOOP` decision to
   an LLM tool call against the most similar stored memories. Honcho's reasoning
   layer builds its user representation automatically with no developer control over
   the inference. That is a direct collision with this repo's bedrock invariant —
   *no model output reaches state ungated*. The reason an assessment here is
   credible is that a weak verdict whose citations were all stripped writes
   **nothing**, and `UNASSESSED` never becomes history. Handing that decision to a
   memory engine's LLM would trade away the one property that makes the gap graph
   worth trusting.
2. **Retrieval is the problem they solve, and we don't have it.** These systems
   exist because you have 10⁴ unstructured facts and need the right five in context.
   We have one user, six closed-vocabulary keys, and `active[0]` as the entire
   retrieval algorithm. Vector search over a six-member enum is not an optimization.
3. **They model "what is true about this user," not "how good is this person at X,
   and is it improving."** That second question is precisely the capability the
   audit above found missing — and none of these products answer it.

There is also a strategic point worth stating plainly: with this many funded
companies commoditizing cross-session persistence, **"we remember you between
sessions" is table stakes by 2026, not a differentiator.** The defensible asset here
is the domain-specific ruler — the six-dimension vocabulary, the evidence gating,
the remediation semantics — not persistence itself. Outsourcing the gap graph to a
generic memory layer would be outsourcing the moat to the commodity.

## Three ideas worth stealing (no dependency required)

**1. Zep/Graphiti's bi-temporal model → fixes gap history.** Graphiti tracks two
timelines per fact (when it was true in the world vs. when it was ingested) and
gives every edge an explicit validity interval `(t_valid, t_invalid)`. Superseded
facts are **invalidated, never deleted**, so the graph can answer "what did we
believe, and when." Map onto our defects directly: gap closure today is a single
`closed_at` plus reopen-on-fire, which loses the arc; and the three `gaps/archive/`
resets happened because there was no versioned history to migrate. Validity
intervals per gap instance would give us a renderable timeline — *this gap was live
from session 3 to session 7* — which is an improvement representation we currently
lack. **This is a data-model idea, not a purchase: it lands in the existing JSON in
an afternoon. We do not need Neo4j.**

**2. Letta's sleep-time compute → we already built the harness for it.** Letta runs
a separate sleep-time agent that reorganizes the primary agent's memory blocks
asynchronously during idle time, rather than doing lazy incremental updates
mid-conversation. We already spawn a detached `prepare` process post-session that
runs ~5 minutes while nobody is watching (`session.ts`, `IP_TARGET_NOTE`). That *is*
sleep-time compute — we just only use it to generate a problem. The same window
could consolidate memory: fold the accumulated analysis sentences into a durable
per-dimension summary, compute trends, and count `memory_tags`. Fits the existing
architecture exactly (detached spawn, disk-authoritative, no new runtime).

**3. Anthropic's own memory tool, for the interviewer only.** Filesystem-backed
`/memories` directory the model manages with view/create/edit commands, now GA on
the Messages API, paired with context editing (Anthropic reports large token savings
and a performance gain on a long-horizon internal benchmark). Lowest-friction option
on the table — we already hold the credentials. But the same gating objection
applies: it is *agent-managed* memory, so it must never own the authoritative gap
store. Plausible scope: the interviewer's within-session scratch notes, where being
wrong is cheap and nothing downstream is graded on it.

## The pointer that actually matters: this is a knowledge-tracing problem

The audit's three sharpest failures — can't represent improvement, focus collapsed
to a constant under all-weak, no principled "which gap next" — are not memory-storage
problems. They are textbook **learner modeling**, with thirty years of literature and
working open-source implementations.

- **Bayesian Knowledge Tracing (BKT)** models mastery as a latent state with
  interpretable `learn` / `slip` / `guess` parameters updated from a response
  sequence. This is the direct fix for "everything is weak and nothing ever closes":
  mastery becomes a probability that *moves visibly* long before it crosses any
  threshold, so improvement has a representation without waiting on a 3-session
  streak. **OATutor** (Berkeley CAHLR) is an open-source BKT implementation worth
  reading rather than deriving from scratch.
- **Elo / IRT** put candidate ability and problem difficulty on one scale. That is
  exactly the missing policy for "target the most *tractable* gap rather than the
  most frequent one," and it hands the generator a difficulty knob it doesn't have.
  Caveat from the literature: plain IRT assumes a static latent trait, so it needs
  the dynamic/multidimensional variants to model growth.
- **Spaced-repetition schedulers (FSRS and successors)** are fitted forgetting
  curves. Our `0.5^(sessionsAgo/5)` is a hand-picked constant doing that job with no
  validation — and the audit notes those parameters have never been checked against
  a real multi-week arc.
- **LOOM** (arXiv [2511.21037](https://arxiv.org/pdf/2511.21037)) is startlingly
  close to this system's design: a dynamic learner memory graph over concepts with
  *continuous* mastery values, decay functions for forgetting, confidence-weighted
  evidence accumulation, and a targeted sequencing algorithm that picks what to work
  on next from high-priority gaps. Effectively a written-up spec for gap graph v2.
  Read it before designing the next iteration.
- **Honest counterweight:** recent work questions whether LLMs reliably track
  learner knowledge over time, and notes they do not construct explicit per-learner
  models. That is an argument *for* keeping our explicit, gated, closed-vocabulary
  graph and bolting real mastery math onto it — not for replacing it with an
  inference-driven memory product.

## Revised recommendation

Keep the store. Add the math, not a vendor. Concretely, in order:

1. Replace the binary weak/not-weak instance with a **continuous per-dimension
   mastery estimate (BKT-shaped)** — this alone fixes both "can't show improvement"
   and the unstable `active[0]` argmax, since near-ties become ordered by posterior.
2. Add **validity intervals** to gap instances (Graphiti's invalidate-don't-delete)
   so history is renderable and future schema changes migrate instead of archiving.
3. Use the existing post-session detached window as a **sleep-time consolidation
   pass** (the first `memory_tags` reader belongs here).
4. Only then consider difficulty matching (Elo/IRT) to give the generator a
   tractability signal.

None of this adds a runtime dependency, and every step is compatible with the
gating invariants that make the assessments trustworthy.

## Sources

- [Zep / Graphiti temporal knowledge graph](https://help.getzep.com/graphiti/getting-started/overview) ·
  [Zep paper](https://arxiv.org/pdf/2501.13956) ·
  [Graphiti on Neo4j](https://neo4j.com/blog/developer/graphiti-knowledge-graph-memory/)
- [Mem0 — how it works](https://docs.mem0.ai/core-concepts/how-it-works) ·
  [mem0ai/mem0](https://github.com/mem0ai/mem0)
- [Letta — memory blocks](https://www.letta.com/blog/memory-blocks/) ·
  [Letta — sleep-time compute](https://www.letta.com/blog/sleep-time-compute/) ·
  [sleep-time agents docs](https://docs.letta.com/guides/agents/architectures/sleeptime/)
- [Honcho docs](https://docs.honcho.to/) (Plastic Labs)
- [Anthropic memory tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool)
- [Bayesian Knowledge Tracing overview](https://www.emergentmind.com/topics/bayesian-knowledge-tracing-bkt) ·
  [OATutor (open-source BKT)](https://github.com/CAHLR/OATutor-LLM-Learner) ·
  [IRT vs BKT](https://www.researchgate.net/publication/323846116_Learning_meets_Assessment_On_the_relation_between_Item_Response_Theory_and_Bayesian_Knowledge_Tracing)
- [LOOM — dynamic learner memory graph](https://arxiv.org/pdf/2511.21037) ·
  [Neural-symbolic knowledge tracing](https://arxiv.org/pdf/2604.08263)
- Landscape surveys: [AI agent memory 2026 comparison](https://medium.com/@wasowski.jarek/i-compared-5-ai-agent-memory-systems-across-6-dimensions-none-wins-6a658335ed0a) ·
  [Value Add VC on the AI memory category](https://valueaddvc.com/blog/the-ai-memory-problem-how-startups-are-solving-for-persistent-context)
