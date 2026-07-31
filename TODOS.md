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

**Priority:** P2 after the queue proves itself in real use.
