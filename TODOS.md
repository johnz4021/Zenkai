# TODOS

Deferred work with enough context to pick up cold. Each item names what unblocks it.
A TODO without its reasoning is worse than no TODO: it creates false confidence that
the idea was captured while losing why it mattered.

---

## 1. `narrated_hypothesis` label

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
