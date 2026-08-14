# Zenkai design system — Graphite Steel

Extracted from the token comments in `server/src/app.ts` (direction 3a, plus the
2026-08-08 design review's action-role decision) so the system is discoverable
without reverse-engineering a CSS block. **`app.ts`'s `:root` is the source of
truth for values; this file is the source of truth for the RULES.** If they
disagree, fix the drift — don't pick a side silently.

## Color roles

Every color has exactly one job. A color used outside its job is a bug.

| Token | Value | Job — and what it must NEVER mean |
|---|---|---|
| `--plate-blue` / `--plate-blue-fold` | `#5099c2` / `#38708f` | **Identity.** The upper half of the folded-Z mark: lit face, then the fold behind it. Deliberately the ONLY branded pixels in a monochrome shell. Never action, never status. The fold face sits a hair off `--steel` — same neighborhood, different job; do not merge them. |
| `--plate-red` / `--plate-red-fold` | `#bf2b50` / `#99203f` | **Identity.** The lower half of the mark, same lit-face/fold pair. Not a verdict color: `--weak` is the pink that grades, and these two must never appear on a grade or a status. |
| `--bg` / `--panel` / `--raised` / `--sunk` | `#0e0e0f` `#151517` `#1d1e20` `#131314` | **Ground.** One flat tone-step per layer. No shadows, no glows, no gradients — elevation does not exist in this system. |
| `--text-1` / `--text-2` / `--text-3` | `#f4f4f5` `#96979b` `#66676b` | **Voice.** Primary / secondary / micro-label tiers. `--text-3` is for decorative micro labels only — it sits near the 4.5:1 contrast floor. |
| `--steel` / `--steel-text` | `#35708f` / `#7ea9c2` | **Time and position.** The timeline spine, date markers, the live-session pulse, focus outlines. Never action, never grade, never identity. |
| `--ok` / `--weak` / `--none` | `#5f9e7a` `#e82b86` `#4a4b4f` | **Verdicts.** The only other saturation on screen. Shape always backs up hue: `■` strong, `◆` adequate, `▫` gap — color alone never carries a grade. |
| **Action** | `--text-1` fill, `--bg` text | **Inverted, not colored** (decision 4A, 2026-08-08): a primary action is white-on-graphite — the brightest object on the page, no new hue. `.primary` is the reference. Secondary actions are hairline outlines, same shape, no fill. Steel and the plates are forbidden on buttons. |

## Type

- **Archivo** (grotesque sans), 14px / 1.55 — body, headings, controls. Also
  the wordmark: 20px / 500 / sentence case, set against a 30px mark.
- **JetBrains Mono** — 11px, UPPERCASE, `.18em` letterspacing, `--text-3` —
  micro labels (`.micro`) and instrument readouts (`.genclock`) ONLY.
  Mono as body type is terminal cosplay; don't. The wordmark used to be mono
  caps — the rule's one standing violation, fixed with the folded-Z mark.

## Rules that keep the system honest

1. **No elevation.** Layers separate by one tone-step and 1px hairlines
   (`--line`, `--line-soft`, `--rule`). A drop shadow anywhere is a regression.
2. **No icons.** The only glyphs are the logo mark and the grade shapes
   `■ ◆ ▫`. A bug icon on a "Debugging" chip is how AI slop gets in.
3. **Affordance matches constraint** (D4, 2026-08-08): a chevron/menu appears
   ONLY where a closed vocabulary genuinely exists (`check.kind`, the four
   round kinds). Open values (language, difficulty, size) are editable text —
   a menu on an open field caps what looks possible and misrepresents the
   data model (`round-spec.ts`: "capabilities, not categories").
4. **One sticky-bottom element per stack** (QA ISSUE-003, twice-burned): a
   second `position: sticky; bottom: 0` in the same column hides the first.
   Prefer zero.
5. **Real labels, always** (`app.ts` intake note): every input has a visible
   `<label for>` or an sr-only one beside a visible word. Placeholder-as-label
   is a hard-rule violation that already shipped once.
6. **44px tap targets** on primary actions and anything the shape screen calls
   editable.
7. **Focus is global.** `:focus-visible` gets the 2px steel outline from the
   base sheet. Never `outline: none` — the a11y test pins this.
8. **Layout**: single centered column, `max-width: 760px` (1180px only for the
   planner's two-pane `body.wide`). Desktop-only by design — ≤700px shows the
   `#narrow` notice.
9. **Motion**: nothing animates except the live-session pulse, `.sk` skeleton
   breathing, and `@keyframes rise` entrances — all killed by
   `prefers-reduced-motion`. A deliberate motion vocabulary is TODOS #29;
   until it lands, adding animation is a decision, not a default.
10. **Copy is utility copy**: orientation, status, action. Failure copy names
    the fix ("no ANTHROPIC_API_KEY in .env"), never the plumbing
    (`clarifyFailureMessage` is the pattern).
