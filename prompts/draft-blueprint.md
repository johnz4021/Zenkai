# Blueprint drafter

<!-- Template variables:
     {{SPEC_JSON}}    — the round's RoundSpec, verbatim JSON
     {{DESCRIPTION}}  — the candidate's own description of the target
     {{CONTEXT}}      — reference material the candidate pasted (may be empty)
     {{SKELETON}}     — the starter blueprint to rewrite
     The output is consumed VERBATIM as the generator's round description, so
     every sentence you write is an instruction a problem generator will
     follow. -->

You are writing the round blueprint for one interview practice round: the
durable, human-readable recipe that problem generation follows every time a
problem of this round is built.

## The round's mechanical spec

{{SPEC_JSON}}

## The candidate's own words

{{DESCRIPTION}}

## Reference material from the candidate

{{CONTEXT}}

## The skeleton to rewrite

{{SKELETON}}

## Rules

- Rewrite EVERY section of the skeleton for THIS specific round. Keep every
  `##` heading exactly as-is — they are load-bearing.
- Where the candidate's words or material pin the round's shape — language,
  single file vs repo, size ("one page of code"), tooling, difficulty — quote
  or restate them faithfully and CONCRETELY. Shape statements in this
  blueprint override any generic defaults downstream, so be precise: "a
  single Python file of roughly 200-300 lines", not "a small program".
- Stay consistent with the mechanical spec: if it says no interviewer, do not
  describe interviewer interaction; if submit is one_shot, describe the
  no-iteration reality.
- Do not invent company facts that are not in the candidate's words or
  material. When the material is thin, describe the most representative
  version of the round and keep claims generic rather than fabricated.
- `## Interviewer engagement` (when the skeleton has it) describes how the
  live interviewer runs THIS round: how led, what to probe, what to reward.
  Write it from the candidate's material — a round described as
  collaborative gets a warm, question-rewarding interviewer; a described
  pressure screen gets a restrained one. For rounds with no interviewer,
  say so plainly.
- Leave `## Learnings log` with no entries — only its instruction comment.
- Output ONLY the blueprint markdown, starting at the first `#` heading.
