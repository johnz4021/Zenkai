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

**Priority:** P2 after the queue proves itself in real use.

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
