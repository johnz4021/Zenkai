# TODOS

Deferred work with enough context to pick up cold. Each item names what unblocks it.
A TODO without its reasoning is worse than no TODO: it creates false confidence that
the idea was captured while losing why it mattered.

---

## 1. `narrated_hypothesis` label — SUPERSEDED by the dimension judge

The judge design (2026-07-30) made this obsolete in its original form:
narration now feeds `communicate` and `approach` verdicts directly, and
positive credit exists via `strong`. The surviving idea is the DISPOSITION
axis (item 7). Kept for the record.

**What:** A positive label for stating a theory about the cause before touching code.

**Why:** The gap graph can currently only observe the *absence* of bad behavior, never
the *presence* of good behavior. `gap-graph.ts:27` literally reads "Goes quiet when
something breaks instead of **narrating** or probing," so narrating is the thing being
asked for, and nothing scores it. Today improvement can only show up as a gap going
three sessions without firing.

**Blocked on (named trigger, not "later"):** eval fixtures exist AND classifier
agreement has been measured on the current five labels. PR1 builds exactly that.

**Why not sooner:** PR2 already redefines `immediate_edit` from "edited before typing a
question" to "edited before thinking aloud or typing." Adding a new label in the same
change means two unvalidated semantic shifts landing together with no way to tell which
one is wrong. `labels.ts` warns about precisely this.

**Where to start:** `shared/src/labels.ts` (the single source of truth), then
`server/src/classifier.ts` `mechanicalLabels()`, then hand-label the same fixtures.
Ship only if agreement holds.

**Effort:** human ~2-3 days / CC ~1 hr. **Priority:** P2.

---

## 2. Live interruption when a gap fires

**What:** The interviewer speaks up because the classifier saw a gap, instead of because
a four-minute timer went off.

**Why:** The design doc's principle 3 says the graph must "generate targeted problems and
interrupt live. A report-only version is a journal with extra steps." Generation closes
that loop today. This is the other half.

**The ordering rule (record this so it is not re-derived):**

```
  gap fires ---> instance written from PAST evidence
                        |                    (clean)
                        v
                 interviewer interjects
                        |
                        v
                 everything after = contaminated
                        (existing 120s window handles it)
```

Measure first, coach second. Never interject into an open window before the label has
been recorded, or the interruption erases its own measurement.

**Blocked on:** live classification inside decision 1A's 8-second budget, which is not
built. Post-session classification has no deadline; live classification does.

**Risk:** a false interruption (agent butts in while the candidate was reading, not
stuck) is the single worst thing this product can do to a paying user.

**Effort:** human ~1 wk / CC ~2-3 hrs. **Priority:** P3.

---

## 3. Silero VAD upgrade

**What:** Replace the Web Audio energy gate with Silero VAD via `onnxruntime-web`.

**Why:** The energy gate plus `noiseSuppression` plus a 300ms minimum duration should
reject mechanical keyboard transients (~50ms). If it does not, keystroke noise streams
to a paid endpoint and gets scored as narration.

**Blocked on:** evidence. Ship the cheap gate, watch the VAD-activations versus
transcripts-returned ratio (see observability), and only take the 1-2MB model download
if that number says so. Do not add the dependency speculatively.

**Effort:** human ~1 day / CC ~30 min. **Priority:** P3, conditional.

---

## 4. Transcript retention policy

**What:** Decide how long `traces/*.jsonl` keeps transcribed speech, and whether
anything is redacted.

**Why:** Audio is already decided (not stored). Transcripts of someone's unfiltered
thinking are a different data class from `edit` events. Irrelevant for the author's own
use; not irrelevant before a paying stranger. Codex also flagged that misquoting someone
back to themselves in performance feedback is worse than not quoting at all, so
transcript confidence handling belongs here too.

**Blocked on / bundle with:** T18 sandbox hardening, whose trigger has already fired
(before any non-author user runs a session).

**Effort:** human ~1 day / CC ~30 min. **Priority:** P2 before any external user.

---

## 5. Session length cap and spend enforcement

**What:** A hard per-session budget for STT and TTS with a defined behavior at the cap.

**Why:** "$0.20/session" assumes a well-behaved 45-minute session. It ignores a session
left open with a live mic, development usage, retried sessions, and abuse. Without a cap
the number is decorative.

**Behavior at the cap (already decided, recording it here):** warn at 80%, and at 100%
fall back to text-only with the header saying so. Never silently mute, which produces
exactly the "is this thing broken?" reaction that the first real session already taught
us about.

**Effort:** human ~half a day / CC ~20 min. **Priority:** P2, ships with voice.

---

## 6. Indirect leak coverage

**What:** Extend the never-reveal guard beyond the buggy filename.

**Why:** `leaksBugLocation()` catches the file path, basename, and stem. Codex correctly
notes the interviewer can still leak a location indirectly: quoting a stack trace,
echoing a filename inside a suggested command, saying "check the parser," or referring
to what the candidate did in a previous session. One mirror test is not coverage.

**Constraint to respect:** the guard must stay surgical. Widening it to identifiers
pulled from the bug description would muzzle legitimate spec answers, since "extend" is
both the bug's mechanism and vocabulary the spec itself uses. See `interviewer.ts`
`leaksBugLocation()` for the reasoning already written down there.

**Where to start:** an adversarial test set of interviewer turns that leak indirectly,
run against the guard.

**Effort:** human ~1 day / CC ~40 min. **Priority:** P2.

---

## 7. Disposition axis (open-vocabulary tendencies)

**What:** A second scoring axis alongside dimensions, for recurring behavioral
tendencies that cut across stages: "anchors on a preconceived cause instead of
instrumenting to see what actually happened."

**Why:** The user named this himself as the most valuable feedback he could
imagine receiving. Codex went further and argued it is "where the useful
pattern lives," and that dimensions alone risk mush. Partly mitigated by
storing the judge's per-session analysis with each dimension instance (that
landed in scope), which makes a disposition *visible* in the memory without
being *named*. Naming it is what this TODO is for.

**Blocked on:** dimension scoring validated across enough real sessions to know
whether the analysis text already surfaces these tendencies well enough. Also
needs entity resolution (match a free-form finding to an existing one), which
is the machinery the current design deliberately avoids.

**Effort:** human ~1 wk / CC ~2-3 hrs. **Priority:** P2 after ~10 judged sessions.

---

## 8. Interviewer-agent quality is unmeasured

**What:** Nothing assesses whether the interviewer agent itself performed well.

**Why:** Codex caught this and it is a real hole in the measurement story. A
wrong spec answer, a badly-timed nudge, or a slow TTS turn changes what the
candidate does, and all of it currently scores as the candidate's gap.
Reliability annotations cover sensors and nudges; they do not cover interviewer
*correctness*.

**Where to start:** the interviewer's turns are already in the trace with kind
and nudge flags. A separate cheap pass could flag turns that contradict the
spec. Note the recursion risk: a model grading a model, unaudited.

**Effort:** human ~2-3 days / CC ~1 hr. **Priority:** P3.

---

## 9. ~~Generated-expectation quality is on the critical path~~ SHIPPED 2026-07-31

Resolved by `checkExpectations()` in server/src/validate.ts: all six dimensions
required, >= 8 words, no vague stems, vocabulary tied to the spec or planted
bug. Verified against a real generation (debugging-1785433362606 passed with
six concrete expectations). Kept for the record.

**What (original):** Nothing checks that the generator's per-dimension expectations are
concrete.

**Why:** Under the judge design, feedback quality is downstream of expectation
quality. "Understands the problem" as an expectation produces vague feedback on
that dimension forever, and it will look like a judge problem rather than a
generator problem. Codex correctly reclassified this from "known open" to
"critical path."

**Where to start:** a mechanical check at generation time (does the expectation
name an observable behavior, or is it an abstract noun) plus a spot-check in
the validator, which already exists for the failing-test manifest.

**Effort:** human ~1 day / CC ~30 min. **Priority:** P2, ships with the judge.

---

## 10. Speaker attribution: a third party in mic range is recorded as you

**What:** Anyone speaking within microphone range is transcribed into the
candidate's record as if they said it.

**Why:** Measured in the first judge-era live session. A background speaker's
"Hey, there. Um, how are you doing?" landed in the trace, and the judge counted
"off-topic asides" against the candidate's `communicate` verdict. The candidate
apologised on the record — to a system that had no way to act on it.

**Why intent detection cannot fix it:** that utterance IS addressed language;
classifying it as an ask is correct as language and wrong as attribution. The
gauntlet's intent metric deliberately does NOT test this case, so it never
pretends to cover it.

**Where to start:** the honest options are speaker diarization (ElevenLabs
Scribe returns `speaker_id` on the timestamped variant — a per-segment check
that the voice matches the enrolled candidate), or an explicit
"someone else is talking" mute affordance. Diarization is the real fix;
the mute is the two-minute one.

**Effort:** human ~2-3 days / CC ~1 hr. **Priority:** P2 before any user in a
shared space, which for a college senior is most of them.

---

## 11. Cross-target pace arbitration

**What:** Each target's queue paces independently against its own interview date.
Nothing arbitrates between targets: a candidate with Palantir in 5 days and Stripe
in 30 sees two paces that may jointly exceed what a human can do, and the app
serializes sessions without prioritizing the nearer date.

**Why deferred:** per-target queues were an explicit decision (2026-07-31 planning
Q&A) and single-target is the September reality. The arbitration question is a data
model question (a season-level scheduler over per-target queues) best answered
after real multi-target use.

**Where to start:** `queue.ts` `repace()` currently takes one target; a season-level
pass would sort next-up items across targets by `daysLeft` and demote the far ones.

**Effort:** human ~2 days / CC ~1 hr. **Priority:** P3 until a second live target exists.

---

## 12. Generation spend is now queue-driven and unmetered

**What:** The app auto-kicks one opus generation per completed queue item (the
prepareNext successor). A 12-item queue is ~12 generations ≈ real money, invisible
to the user.

**Why it matters more than before:** pre-queue, generation happened once per session
end. Now completing items steadily drains spend with no cap and no display. Bundle
with TODO #5 (session spend cap): one budget object, two consumers (voice, generation),
warn at 80%.

**Effort:** human ~half day / CC ~30 min. **Priority:** P2, before any paying user.

---

## 13. Drills (deferred from the season-program build)

**What:** 2-5 minute reps between full rounds — the queue's second item size.
Deferred by explicit decision (2026-07-31): rounds-only queue ships first.

**Why:** a rounds-only 3-week queue is 10-15 items and dead days between them; drills
are what make the daily-open habit real. Needs its own generator, a judge-lite grading
path, and a surface (~2-3 days CC when picked up).

**Where to start:** the CEO plan (ceo-plans/2026-07-31-season-program.md) has the
framing; queue.ts already models items generically (kind field would be additive).

**Amendment (2026-08-02, external-bridge CEO review, decision T2):** the drills build
also owns the debrief→gap-graph ingestion deferred from the external-practice bridge:
external items store a single-slot `debrief` note, and mapping self-reported notes to
dimension evidence (polarity, weight, idempotency) belongs here, where judge-lite
grading gives self-reported signal a principled design.

**Amendment (2026-08-10, memory-layer CEO review):** trigger REWRITTEN from the vague
"after the queue proves itself in real use" to a computable one: **memory-layer Pass 1
has run for N sessions AND one cause tag accounts for a plurality of weak dimensions.**
Reasoning: drills are the cheap intervention for the `couldnt` cause specifically, and
building them before the cause distribution is known means targeting a guess. Pass 1
produces that distribution. This is the other half of the efficiency thesis — cause
tells you a 3-minute drill would fix it, and today the only response the system owns is
a 60-minute round.

**Priority:** P2, un-defer on the trigger above.

---

## 14. No DESIGN.md — every UI decision restarts from principles

**What:** Run `$D extract` on the two approved mockups
(`~/.gstack/projects/interview_prep/designs/season-timeline-20260731/`) to author a real
DESIGN.md: the token set both surfaces already share (`#17171a`, `#e6e6ea`, `#9a9aa2`,
`#2a2a2e`, one violet accent `#7c5cff`, green `#4caf7d` for completed work only,
hairline rules, uppercase letterspaced micro-labels, flat/shadowless).

**Why:** The 2026-07-31 design review had nothing to calibrate against and rated design
system alignment 3/10 purely for the absence. Without it, the next UI change
re-derives the same decisions and drifts.

**Blocked on:** nothing. The approved mockups exist.

**Effort:** human ~1 hr / CC ~30 min. **Priority:** P2.

---

## 15. In-session chrome will diverge from the redesigned home app

**What:** Bring `chrome.ts` `sessionPage()` and the post-session feedback card up to the
visual language the home app establishes after the timeline redesign lands.

**Why:** The design review was deliberately scoped to the home surface only (decision D1,
2026-07-31). Once the entry point and timeline ship, the entry point and the session a
student launches from it are designed to different standards. That is precisely how a
product starts feeling assembled rather than designed.

**Constraint:** the session chrome currently works and is the measured surface. Any change
must not disturb the trace, the voice controls, or the card's three assessment states.

**Blocked on:** the home app redesign landing first — it defines the target language.

**Effort:** human ~1 day / CC ~2-3 hrs. **Priority:** P2 after the redesign.

---

## 16. ~~Unnamed font stack~~ SHIPPED 2026-08-01 — IBM Plex Mono

Resolved in the home app: IBM Plex Mono (400/500/600 + italic) via Google Fonts,
falling back to ui-monospace. Free and open — no licence cost. The session chrome
(chrome.ts) still uses the bare system stack; that alignment rides with TODO #15.

**What (original):** Unnamed font stack — the design is never actually the design

**What:** Choose a real named monospace (Berkeley Mono, JetBrains Mono, Söhne Mono) to
replace `ui-monospace, monospace` in `chrome.ts` and `app.ts`.

**Why:** A system stack renders differently on every machine, so the approved mockups are
never what a user actually sees. It is also the "gave up on typography" signal on the AI
slop blacklist. Monospace is the correct genre for a tool whose sibling surface is a code
editor; the issue is that no specific face was ever chosen.

**Cost to weigh:** the good faces are paid (Berkeley Mono is a one-off licence); JetBrains
Mono is free and open. Adds a webfont to load on a surface that currently loads none.

**Effort:** human ~1 hr / CC ~20 min once the face is chosen. **Priority:** P3.

---

## 17. Persistence has no atomicity — a crash mid-write truncates the plan

**What:** Give `saveTarget` and `saveQueue` (`server/src/intake.ts:51`, `server/src/queue.ts:65`)
a temp-then-rename write: serialise to `<file>.tmp`, `fsync`, then `rename` over the target.
`rename` on the same filesystem is atomic, so a reader sees either the old file or the new
one, never a half-written one.

**Why:** Both savers call `writeFileSync` directly. A crash, a full disk, or a kill mid-write
leaves truncated JSON, and neither loader validates (see #18), so the failure surfaces later
as a confusing UI rather than a loud error. This was tolerable when a target was written once
at intake. The adaptation feature (CEO review 2026-08-02) writes both files on every adapt,
multiplying the exposure.

**Pros:** closes the only path by which a plan silently corrupts on disk; ~20 lines; no
behaviour change when nothing goes wrong.
**Cons:** touches the persistence layer every module depends on, so it wants its own careful
pass with the full suite green, not a drive-by inside a feature branch.

**Context:** raised by the outside voice (Codex) during the CEO review that cut preemptive
research. Pairs naturally with #18 — atomic writes stop corruption being *created*, schema
validation stops corruption being *consumed*. Do #17 first; it's the cheaper half.

**Effort:** human ~2 hrs / CC ~20 min. **Priority:** P2. **Blocked on:** nothing.

---

## 18. Loaders cast instead of validating — `JSON.parse(...) as T`

**What:** Validate shape in `loadTarget` (`server/src/intake.ts:56`) and `loadQueue`
(`server/src/queue.ts:59`) instead of casting. A hand-written validator in the repo's
existing gate style (see `gateTopics`, `validateRoundSpec`) is preferable to adding a
schema library — the vocabulary is already closed and hand-written gates are the house
pattern.

**Why:** Every read of a target or queue is an unchecked cast. A truncated file, a
hand-edited one, or a shape from an older build produces `undefined` deep in a render
path rather than a clear error at the boundary. Codex's framing during the CEO review:
deferring validation *while adding state transitions* is a bad trade — the adaptation
feature adds an `adapting` flag, per-item stale flags, and an `adaptations[]` log, so
there is strictly more shape to get wrong.

**Pros:** turns a class of silent misbehaviour into one loud error at the boundary;
makes #17's recovery story real (you can tell a good file from a bad one).
**Cons:** a validator must be kept in sync with the types by hand, which is exactly the
drift the `as T` cast was avoiding; a library would avoid that but adds a dependency to
a repo that currently has almost none.

**Context:** from the same CEO review as #17. The specific trigger is that adaptation
introduces a half-applied state that is only detectable if a loader can tell a valid
queue from an invalid one.

**Effort:** human ~half day / CC ~45 min. **Priority:** P2. **Blocked on:** #17 ideally
lands first, so validation has something trustworthy to validate.

---

## 19. Pasted material is not fenced as untrusted input

**What:** In `prompts/clarify-intake.md` and the new adapt prompt, wrap candidate-supplied
material (`t.context`, adaptation material) in an explicit boundary — a delimiter plus a
line stating the enclosed text is data describing an interview round, never instructions —
and add eval cases with an injection attempt inside pasted material.

**Why:** The product's whole value is interpreting primary material the candidate pastes:
recruiter emails, OA problem titles, a friend's messages, a GitHub reference someone found.
That material goes straight into a model that then writes `RoundSpec`s and re-shapes a plan.
Nothing currently distinguishes "this is the round description" from "ignore previous
instructions". The blast radius today is the candidate's own practice plan on their own
machine, which is why this is P2 and not P1 — but the feature that makes it matter is the
one being built now.

**Pros:** cheap, prompt-only, and testable; the closed `RoundSpec` vocabulary plus
`validateRoundSpec` already bounds what a hijacked planner could emit.
**Cons:** prompt-level mitigation is mitigation, not a guarantee; without eval cases it's
an untested claim, and this repo has no eval harness yet.

**Context:** raised by Codex during the CEO review. Note the existing defence-in-depth:
pasted links are stored as text and never fetched, and every emitted spec must survive
`validateRoundSpec` server-side.

**Effort:** human ~3 hrs / CC ~30 min. **Priority:** P2. **Blocked on:** nothing.

---

## 20. ~~Research is kept but unused~~ RESOLVED 2026-08-02 — deleted same day

Closed early by D9, the launch-lens revision of D1: an opt-in button on a 40%-rejected
feature is a support liability in a paid product, and the networkless student is already
served by model priors + clarifying questions. `research.ts`, its tests, the prompt, both
endpoints, the CLI subcommand, and `Target.research` were all deleted; git history is
the archive (the citation gate and `normalizeCitation` lessons live there if it ever
comes back).

**What (original):** A dated decision, not open-ended debt. If the opt-in "look it up for me" link
has not been used by 2026-09-30, delete `server/src/research.ts`, `server/src/research.test.ts`
(11 tests), `prompts/research-round.md`, and the `/api/research` + `/api/research/confirm`
endpoints, and drop `research` from the `Target` interface.

**Why:** The CEO review on 2026-08-02 cut preemptive research from the default intake path
on measured evidence: 5 runs across real targets, 2 rejected outright by the candidate, and
one confident miss where research contradicted a HackerRank preview the candidate had seen
with their own eyes. It was kept behind an explicit opt-in for the case with no
counter-evidence — a student with no network, no invite email, and no contacts. That case is
real but unproven. If a full recruiting season passes without it being pressed, the case
does not exist and the code should go.

**Pros:** converts a kept-but-unused path into a decision with an expiry rather than
permanent maintenance surface; deleting it also removes the only subprocess in the product
holding `WebSearch,WebFetch`.
**Cons:** if it does get pressed occasionally the check just churns; and re-adding it later
costs more than keeping it, since the citation gate and `normalizeCitation` took two rounds
of live failures to get right.

**Context:** Codex's fair hit during that review was that the cut reduced default-path
latency (~2min → ~15s) but not maintenance surface. This TODO is the answer to that: the
surface goes away too, just on evidence rather than on a guess.

**Effort:** human ~2 hrs / CC ~20 min. **Priority:** P3. **Blocked on:** the September
season completing.

---

## 21. Curated LC-slug allowlist — mechanical gate for model-emitted problem titles

**What:** Bundle a static list of ~500 famous LeetCode problem slugs (Blind 75,
NeetCode 150, top-liked). In `gateExternal`, model-emitted titles/links ship only when
the slug matches the list; misses fall to the topic+count fallback shape. Replaces
model self-attestation with a genuinely mechanical gate.

**Why:** The external-bridge CEO review (2026-08-02, decision T1) kept model-attested
titles over the outside voice's objection that self-attestation is "just another model
claim" shipping invented problems with product authority. This is the hardening that
retires that residual risk without reversing T1 — attestation stays the UX, the
allowlist becomes the proof.

**Pros:** mechanical, not model-bounded; a tiny static file; also validates the url
slug for free. **Cons:** a corpus to curate and occasionally refresh; the tail beyond
the list still falls back (by design).

**Context:** the bridge's gate already has the fallback machinery, so this is one
lookup added to an existing code path, not a new subsystem.

**Effort:** human ~half day / CC ~30 min. **Priority:** P3.
**Depends on:** the external-practice bridge shipping, and invented titles actually
being observed in real plans.

---

## 22. Session architecture is single-tenant — a production blocker, not a bug

**What:** `const CONTAINER = 'ip-session'` (`server/src/session.ts`) plus hardcoded ports
3200 (session server) and 3100 (openvscode) make sessions **globally single-tenant** — one
session per *machine*, not per user. Two users would collide on the container name, and
session startup's `docker rm -f ip-session` would destroy the other person's live interview.

**Why it isn't urgent:** for local single-user this design is correct and earned its keep
during the 2026-08-02 QA — killing the app mid-generation left the detached generator
running and disk-derived state recovered it cleanly. Process isolation is the right call.

**What production needs:** per-session container names and dynamic port allocation; a
routing proxy mapping session id → container; a lifecycle manager with idle timeout
(teardown-on-grade landed in `fa3b7e6`, but nothing reaps a session abandoned by a closed
tab); per-user resource caps. None of this invalidates the current architecture — it is the
same shape with identity added.

**Effort:** human ~1 wk / CC ~3-4 hrs. **Priority:** P2, blocking any second user.

---

## 23. Drills would fill the quiet days the timeline now names

**What:** see #13. The 2026-08-02 QA made the gap concrete and visible: with 3 rounds/week
over an 18-day runway, the runway is mostly empty days. Those now render honestly as
"· N quiet days ·" rows (D4) instead of a wall of blank dated rows — which makes the hole
easier to see, not smaller.

**Why here:** #13 framed drills as a habit mechanism. The QA adds the evidence: the
timeline's own shape now points at exactly where they go.

**Effort / priority:** unchanged from #13 (P2, ~2-3 hrs CC).

---

## 24. Debrief shape-ledger (deferred from the shape-uncertainty CEO review)

**What:** After a real interview round, a prefilled one-tap debrief ("was it like this?"
against the plan's own predicted shape) recording the ACTUAL round shape per company,
dated, in the spec vocabulary.

**Why:** Ground truth about round shapes arrives at the moment memory is freshest, via a
timeline prompt that already exists ("X was 2 days ago — how did it go?"). At n=1 it
re-aims the user's own remaining rounds; at scale it compounds into dated per-company
shape priors — the data asset LC company tags approximates with stale crowd frequency.

**Pros:** self-feeding moat; near-zero friction (correcting a prediction, not authoring).
**Cons:** worthless below some user count; noise/lying concerns (user judgment 2026-08-07:
open but unconvinced at current scale).

**Context:** Noise fences designed and agreed: ledger priors enter the evidence hierarchy
at tier 3 (structurally cannot override firsthand/secondhand), shift only on k≥3
recency-weighted independent reports, provenance always displayed. Rides the E1 debrief
channel from the external-bridge review. See ceo-plans/2026-08-07-shape-uncertainty.md.

**Effort:** human ~1 wk / CC ~3-4 hrs. **Priority:** P3 until user count justifies.
**Blocked on:** users beyond the author.

---

## 25. Cold-start shape corpus (deferred from the shape-uncertainty CEO review)

**What:** Manually curated public-source pass (Blind, LC discuss, HN) extracting round
SHAPES per company — spec vocabulary + date, never problem content — for ~20-30 companies.

**Why:** Per-company priors before debriefs accumulate. **Cons:** recurring manual
re-verification (shapes rot; stale curated data is worse than the live research loop).
**Context:** the planner's runtime web search covers the author's own loops this season.

**Effort:** M, recurring. **Priority:** P3. **Blocked on:** #24 existing (else nowhere to store).

---

## 26. Dimension-tagged difficulty operators (deferred from the shape-uncertainty CEO review)

**What:** Blueprint variation operators tagged to judged dimensions — orientation → more
files/deeper call graph; diagnosis → symptom further from cause; verification → subtler
criterion; constraint → tighter budget; transfer distance → different shape. NEVER raw
LOC. The gap graph picks the axis (extend where cruising, hold where struggling); a
one-tap post-round grade (too easy / right / brutal) plus per-dimension verdicts close
the loop IRT-style: operators are hypotheses, outcomes correct them.

**Why:** "Meaningfully extend so they're challenged every time" made mechanical; answers
the multi-file-vs-LOC question by construction.

**Context:** Design settled in the 2026-08-07 CEO review; calibration needs live
sessions. Un-defer criterion: the author completes one season containing ≥1 hedged
segment and debriefs it.

**Amendment (2026-08-10, memory-layer CEO review):** the one-tap too-easy/right/brutal
grade was offered for the memory-layer's Pass 1 (it would ride the same card control)
and DEFERRED. Reasoning: it competes with the cause click at the moment of highest exit
intent, risking the more valuable of the two signals, and #26 is independently blocked
so the grade would accumulate with nothing reading it. **Second un-defer condition:**
the cause click demonstrates that candidates use a card-time control at all.

**Effort:** human ~1 wk / CC ~3-4 hrs. **Priority:** P2 once the criterion fires.
**Blocked on:** portfolio planning shipping (the accepted scope).

---

## 27. Retention policy for generated problems and rep metadata

**What:** A reaping rule for `problems/` and `targets/*/problems/` (used problems older
than N days), plus failed reps, stale `ready` reps, and abandoned generations in
`reps.json`.

**Why:** `problems/` already holds 22 full generated repos with no reaping code anywhere
in the product. The "Practice now" door adds a second unbounded producer, and rep
metadata compounds it — a failed rep leaves both a directory and a row. Nothing breaks at
22 or at 200, which is exactly why it will never get fixed unless it's written down.

**Pros:** bounded disk, and a `ready` rep that has sat for three weeks is stale signal the
UI shouldn't offer. **Cons:** a reaping rule is a destructive code path in a product that
currently has none, and the right N is unknown — a used problem you failed is arguably
worth keeping forever (see #28, which wants exactly that corpus).

**Context:** Raised by Codex in the 2026-08-08 CEO review on spontaneous practice. Note
the dependency inversion with #28: retention must NOT reap unsolved problems, because #28
proposes re-serving them. Reap on `.used` + assessment-says-solved, never on age alone.

**Effort:** human ~half day / CC ~45 min. **Priority:** P3. **Blocked on:** nothing, but
sequence after #28 so the keep-rule is known.

---

## 28. "One more" — extra practice when today's plan is done

**What:** The other half of the spontaneous-practice question (2026-08-08 CEO review): you
finished today's queue items and want another rep. Two sources, in order: a warm pool kept
stocked for your targets' *confirmed* specs (shapes are known and stable, so pre-warming
actually works there), then the already-generated corpus — 21 of 22 problems on disk are
used, and `feedback.ts:19` already states the design intent that *"a problem you didn't
crack stays re-runnable."* Rank by the gap graph's focus dimension.

**Why:** This is user case (a), and the shipped "Practice now" door deliberately does not
serve it: that door infers a round from pasted information, so it must generate, and five
minutes is intrinsic. "Give me one more" is the opposite — it wants instant, and instant
is only possible where the shape is already known.

**Pros:** near-zero generation cost (the corpus is paid for); re-serving a problem you
failed, aimed at your focus gap, is better pedagogy than a fresh random one; the warm pool
(`pool.ts`, complete and tested at 8 passing tests) is currently unreachable from the app
and would finally be used. **Cons:** a memorized problem stops teaching, so re-runs need a
staleness rule; warm-pool depth costs speculative opus spend (see TODOS #12).

**Blocking bug this must fix first:** `markUsed` (`pool.ts:56`) OVERWRITES `.used` with the
new session id, and `rejudge`'s reverse lookup (`cli.ts:411`) matches on that file's first
line. Re-running any problem therefore makes the *earlier* session permanently
un-rejudgeable. Append, don't overwrite, and have the lookup scan all lines.

**Context:** Set aside during the 2026-08-08 CEO review to keep the second door's build
clean — it's a different mechanism (pre-warm + re-serve) from the door's (infer +
generate). Codex independently argued the simplest useful version of practice is close to
this; the counter is that it doesn't answer "a round like the info I gathered," which is
what the door exists for. Both are real; they're just two features.

**Effort:** human ~1 wk / CC ~2 hrs. **Priority:** P2. **Blocked on:** nothing. Revisit
after the second door has real usage — if a 5-minute build always feels fine, this may
never be wanted.

---

## 29. Motion vocabulary is undecided

**What:** Decide whether this app animates at all, and if so, name the two or three
intentional motions (entrance, state arrival, focus) as tokens rather than per-component
guesses.

**Why:** The design litmus check came back NOT SPEC'D on motion in the 2026-08-08 design
review. Nothing in the app animates today, which may well be correct for an instrument
panel, but nobody decided it — so the first implementer who wants a spinner introduces one
and the vocabulary is set by accident. The "Practice now" wait state is the first surface
where motion would actually carry meaning (build progress, arrival of a ready round), and
it's shipping with honest elapsed text instead, which is a defensible answer but an
undocumented one.

**Pros:** cheap to decide; prevents a spinner-shaped accident; "no motion" is a legitimate
and rare position that's worth stating out loud. **Cons:** hard to decide well against one
surface — a motion vocabulary wants several screens to calibrate against, and guessing now
risks a rule that the timeline or the session chrome immediately breaks.

**Context:** Deferred from the 2026-08-08 plan-design review. Note the constraint it has to
live inside: `app.ts:260-276` states the shell has no elevation, so any motion cannot rely
on shadow, lift, or depth. That rules out most conventional "rise on hover" patterns and
pushes toward opacity, position, and hairline-weight changes.

**Effort:** human ~half day / CC ~15 min. **Priority:** P3. **Blocked on:** nothing, but
worth waiting until the wait state and the reps strip both exist to decide against.

---

## 30. Promotion: rep → season (spec frozen, presser doesn't exist yet)

**What:** `POST /api/practice/promote {rep_id, label, date?}` — one endpoint turning a
finished target-less rep into a new season. Full spec in
ceo-plans/2026-08-10-composer-first-landing.md (Phase 2): guards, `promoted_from`
self-heal key (NOT spec.id — model-authored, not unique), queue-repair on heal,
`acceptSpecsCore()` extraction so promotion never forks accept-spec's logic, CTA on
the landing strip card only (the session server never learns rep identity), copy
"seeded {label}" not "part of" (season starts 0/N), text-context-only seeding
(rep attachments were never persisted, by design).

**Why deferred (2026-08-10, codex tension, user call):** mid-season with seasons
already built, nobody presses this button; the person it serves is a future new
user. The spec cost 19 spec-loop + 15 codex findings to pin — freezing it beats
rebuilding it.

**Un-defer trigger:** a second real user exists, OR a rep of yours genuinely
deserved a season and couldn't get one.

**Effort:** human ~3 days / CC ~1.5 hrs. **Priority:** P2 once the trigger fires.

---

## 31. Gap-aimed suggestion line in the empty composer

**What:** When the landing composer is empty and a gap graph exists, one quiet line:
"your focus gap is {gap} — want a rep aimed at it?" One tap → generation briefed by
`buildTargetNote` (the doorless `cli.ts prepare` machinery, given a door).

**Why deferred (2026-08-10 CEO review):** the landing should prove itself plain
first, and the suggestion copy deserves design against a REAL gap-graph state —
which a week of composer-first reps will produce.

**RESOLVED 2026-08-10 (memory-layer CEO review): trigger fired, accepted into scope.**
Both blockers are satisfied — the composer landing shipped, and the gap graph holds 7
sessions. Scheduled inside memory layer v2 Pass 2a so the copy is written against a
real cause CONDITIONAL ("you go silent when timed") rather than the current constant
("communicate"), which is what the original deferral was waiting for. See
`~/.gstack/projects/interview_prep/ceo-plans/2026-08-10-memory-layer-v2.md`.

**Effort:** human ~1 day / CC ~40 min. **Priority:** P3. **Blocked on:** the
composer landing shipping + a non-empty gap graph.

---

## 32. Bare-company-name quick start ("Palantir" → a round)

**What:** The composer accepts one word; clarify infers a representative round from
the name plus any existing target context for that company.

**Why deferred (2026-08-10 CEO review):** step one is a TEST, not code — the
clarifier may already handle a one-word description passably (it's just a short
description). If it does, this is placeholder copy, not a feature. Guard the
invented-company-facts failure the blueprint rules exist to prevent.

**Effort:** test ~10 min; if real, human ~2 days / CC ~1 hr. **Priority:** P3.

---

## 33. The golden-set regression loop has never had an input

**What:** `promote-fixture` turns a candidate-confirmed session into a golden judge
fixture. It reads `assessments/<sid>.confirm.json`. As of 2026-08-10 there are 12
assessments, **0 confirm files, and `fixtures/judge/golden/` is empty.**

**Why:** CLAUDE.md calls `eval-judge` "the judge's whole regression suite" and
promote-fixture the way "the library grows from REAL sessions." That library has been
empty since it shipped, so judge quality has no regression protection from real data.

**Root cause (found 2026-08-10, memory-layer CEO review):** the only control that
writes `confirm.json` is `client/session.js:257`, which renders only on the live
session tab — reachable from exactly two places (`:104` time-up, `:202` End button)
and gone when that tab closes. The durable surface people actually revisit,
`renderCardHtml` (`client/app.js:1573`), deliberately omits it, and `app.test.ts:93`
asserts the omission. So the 0/12 rate is an ARCHITECTURE artifact, not a signal that
nobody wants to confirm.

**Where to start:** `session.ts:1046` writes the file, `cli.ts:398-410` reads it.
The memory-layer plan's app-side capture endpoint unblocks this for nearly free.

**Effort:** human ~1 day / CC ~20 min once app-side capture exists. **Priority:** P2.
**Blocked on:** app-side capture (memory layer v2, Pass 1).

---

## 34. `rejudge --record` appends duplicate gap instances

**What:** `cli.ts rejudge --record` (`cli.ts:501-505`) calls `recordAssessment` again
for a session already in the store. `recordSession` (`gap-graph.ts:113-165`) appends
unconditionally, so a second instance lands for the same `(session_id, dimension)`.

**Why:** it silently inflates `fired_count` and `weight` for any rejudged session,
which skews the focus ranking the entire memory layer is built on. Rejudge is how a
judge prompt change gets re-scored against history, so the tool that keeps history
comparable is the one that corrupts it. Found independently by two reviewers
(2026-08-10 CEO review and the codex outside voice).

**The design question to settle first:** does a rejudge REPLACE the prior instance or
SUPERSEDE it (keeping both, with the older marked)? Specs are append-only elsewhere in
this codebase for a reason, so superseding is more consistent, but it needs a
version/row id — which is also what a cause needs to attach to safely.

**Effort:** human ~1 day / CC ~30 min. **Priority:** P1 if you rejudge, P3 if never.

---

## 35. 17 feedback files, 12 assessments — five sessions unaccounted for

**What:** `feedback/` holds 17 cards; `assessments/` holds 12. Five sessions have a
rendered card with no assessment behind them.

**Why it matters:** `session.ts:858-891` writes both in the same finalize path, so
they should move together. Benign explanation: those five predate the assessment
write. Bad explanation: a path exists where a card renders without an assessment
landing, which would mean the gap graph has silently missed sessions and every count
it makes is off.

**Where to start:** compare session ids across the two directories and check dates
against the `gaps/archive/` reset points (the store was intentionally re-baselined
three times, so some discontinuity is expected and not a bug).

**Effort:** human ~1 hour / CC ~10 min. **Priority:** P3.

---

## 36. The two-phase confirm gate: correct the blueprint, not the intent

**What:** Split `rep-build` so the blueprint draft (~30s) finishes BEFORE the candidate
commits, show them the real brief, and let them correct it before the ~5-minute opus
generation runs.

**Why it matters:** The blueprint is the artifact that actually decides whether a round
is any good, and today it is written 30 seconds AFTER Start inside a detached child the
candidate never sees. The 2026-08-12 design review shipped the cheap version instead
(decision 3A: the clarifier emits a 3-4 sentence plain-words brief above Start, no second
phase). That brief describes what the clarifier INTENDS, not what the drafter WROTE — so
a drafter that wanders off the brief is still invisible until the round exists.

**Pros:** the highest-fidelity clarification available; a correction costs 30s to redo
instead of 5 minutes, which is the right economics for the expensive step.

**Cons:** `rep-build` becomes two commands with a restart-durable pause between them, and
the `.generating` marker stops covering one continuous pid — `sweepVerdict` and
`sweepOrphanedGenerations` both assume it does. Needs a new "awaiting confirmation" phase
that survives an app restart. Adds 30s between Start and commitment on the surface whose
entire license to exist is speed.

**Named trigger:** build this when the plain-words brief demonstrably fails to catch a
wrong round — i.e. a session where the candidate read the brief, started, and the
generated round still did not match their interview.

**Depends on:** decision 3A shipping first, and enough real sessions to observe the
failure. **Effort:** human ~2 days / CC ~1.5 hours. **Priority:** P3 until the trigger fires.

---

## 37. Practice door: round selector when one paste describes several rounds

**What:** A round selector at the top of the confirm screen's settled-facts rail, with
gaps and facts recomputed per selected round.

**Why it matters:** `gateClarify` already returns up to 4 drafts (one per distinct round —
an OA and an onsite are two). The practice door hardcodes `rep.chosen = 0` and silently
discards the rest. Silently dropping a round the candidate described reads as the product
not listening, which is the exact complaint that started the 2026-08-12 review. That
review shipped a one-line disclosure now ("your material describes 2 rounds — building
the OA") and deferred the selector.

**Pros:** every round the candidate described becomes reachable, each with its own facts
and its own gaps. **Cons:** a rail labelled "Confirmed from your paste" has a single
identity, so switching rounds has to swap the spec, the settled facts, and the gap list
together; it is real machinery, not a render tweak.

**Context:** the season-plan gate already solves the multi-draft case (`app.js:475-504`
splits usable/declined and lets you include/exclude each). Read that first — the practice
door may be able to reuse its selection model rather than invent one.

**Depends on:** the gap model from the 2026-08-12 review landing first.
**Effort:** human ~1 day / CC ~45 min. **Priority:** P2.

---

## 38. A third `answer_type` for bounded-but-not-enum gaps

**What:** A control kind between "closed enum" (pills only) and "open" (pills as
shortcuts plus a free-text input): pills plus an explicit `other…` escape, with no
always-visible text box.

**Why it matters:** decision 4A of the 2026-08-12 review splits gaps into closed and open,
and the client renders controls deterministically from that flag. But "how senior should
the bar be?" is neither — there is no fixed set, yet a free-text box invites answers like
"idk pretty hard" that the blueprint drafter cannot use. Difficulty and seniority are
exactly the axes candidates most want to tune, and today they land in the weaker control.

**Pros:** honest affordance for the bounded case, and it keeps vague prose out of the
drafter's input. **Cons:** a third case in the taxonomy, the gate, and the renderer;
designing it before observing real usage risks designing for a case that does not occur.

**Named trigger:** revisit once there is a corpus of real pastes showing what the
clarifier actually asks for difficulty and seniority. If those questions come back as
closed enums the model invented, this is urgent; if they come back as genuinely open
prose, it may not be needed at all.

**Depends on:** decision 4A shipping, plus beta traffic. Note `answer_type` is already an
extensible string, so adding a third value later is not a migration.
**Effort:** human ~4 hours / CC ~25 min. **Priority:** P3.
