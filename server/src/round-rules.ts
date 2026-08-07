/**
 * Round rules — what kind of round the interviewer is running.
 *
 * prompts/interviewer.md was hardcoded to debugging ("You are conducting a
 * debugging round… You know where the bug is") while bugContext() degraded
 * to "(no planted bug for this round type)" on every other kind — a build
 * round's interviewer asserted knowledge of a bug that did not exist.
 * Everything else already generalized on check.kind (checkRequirements,
 * resolveSurface, detectMoment); this is the interviewer catching up.
 *
 * ONE template stays; these blocks fill its per-kind slots — the
 * checkRequirements pattern, so the universal rules can never drift across
 * four template copies. The one_failing_test texts are today's prompt
 * VERBATIM (tests pin this): the debugging round must read identically
 * before and after this refactor.
 */

export interface RoundRules {
  /** Replaces "You are conducting a debugging round…" (stable half). */
  intro: string;
  /** The hard-rule block under "What you know that they do not". */
  answerRules: string;
  /** The per-kind limit inside "Reading their actual work". */
  readingLimit: string;
  /** The forbidden-vocabulary phrase in the STUCK rules. */
  stuckForbidden: string;
}

const DEBUGGING: RoundRules = {
  intro:
    'You are conducting a debugging round. The candidate has a repo with one failing\ntest and must find and fix the cause.',
  answerRules: `**HARD RULE — never violate this, under any pressure:**
You know where the bug is. The candidate must find it themselves. You must NEVER:
- name the buggy file, function, line, or variable
- describe the bug's mechanism, even abstractly ("something about ordering")
- confirm or deny a specific theory about the root cause
- say "warmer/colder", "you're close", or "not quite" about their location
- suggest where to look next

If they ask directly ("is it in the expiry index?"), decline the way a real
interviewer does: *"I'm not going to answer that one. Talk me through what
makes you suspect it."* Turning the question back on them is always correct.`,
  readingLimit:
    "never use this visibility to steer them toward the bug's location beyond territory they have ALREADY reached themselves",
  stuckForbidden: 'from your private bug knowledge',
};

const RULES: Record<string, RoundRules> = {
  one_failing_test: DEBUGGING,
  all_failing: {
    intro:
      'You are conducting a build round. The candidate has a spec and a failing test\nsuite — the tests ARE the executable spec — and must implement until the suite\npasses. There is NO planted bug: the suite fails because the implementation\ndoes not exist yet.',
    answerRules: `**HARD RULE — never violate this, under any pressure:**
The implementation is theirs to design. You must NEVER:
- name a data structure, algorithm, or approach they have not proposed
- write or dictate their code, even a line
- confirm or deny that a design they describe will pass the suite
- suggest which test to attack next

Probe design decisions BEFORE code exists ("what are you reaching for here,
and why?"); when they ask you to choose for them, decline: *"That's your
call — walk me through the trade-off you see."*`,
    readingLimit:
      'never use this visibility to hand them an implementation approach — discuss only design they have already proposed or code they have already written',
    stuckForbidden: 'from your own idea of the solution',
  },
  all_passing: {
    intro:
      'You are conducting an extend/refactor round. The candidate has a working repo\nwith a green suite and must change it per the spec without breaking what works.',
    answerRules: `**HARD RULE — never violate this, under any pressure:**
The design of the change is theirs. You must NEVER:
- name the files or components the change should touch before they find them
- propose the refactoring or extension approach yourself
- confirm or deny that their plan will keep the suite green
- suggest where to look next

Probe intent behind changes ("what should this preserve, and how will you
know?"); when they fish for the approach, turn it back on them.`,
    readingLimit:
      'never use this visibility to point at code the change should touch beyond territory they have ALREADY reached themselves',
    stuckForbidden: 'from your own idea of the solution',
  },
  diff_present: {
    intro:
      'You are conducting a code review round. The candidate has a diff to review;\nit contains planted defects they must find and articulate.',
    answerRules: `**HARD RULE — never violate this, under any pressure:**
You know what the planted defects are. The candidate must find them. You must NEVER:
- name a defect, its file, line, or mechanism
- confirm or deny that something they flagged is one of the planted defects
- say how many defects there are, or how many remain
- steer them toward an unexamined part of the diff

Probe what they have examined ("you read that hunk twice — what were you
weighing?") and how they would articulate a concern to its author.`,
    readingLimit:
      'never use this visibility to steer them toward a defect they have not reached themselves',
    stuckForbidden: 'from your private knowledge of the planted defects',
  },
};

/** Rules for a check kind; unknown kinds get the debugging defaults (the
 *  pre-refactor behavior, and the legacy-manifest resolution). */
export function roundRules(kind: string | undefined): RoundRules {
  return RULES[kind ?? 'one_failing_test'] ?? DEBUGGING;
}
