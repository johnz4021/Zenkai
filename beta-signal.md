# Beta signal

Where the beta's results get written. `docs/beta-runbook.md` §6 and §6a point
here; until now the file did not exist, so the answers had nowhere to land.

Rules for this file, so it stays worth reading:

- **Numbers and quotes only.** "Felt like it went well" is not a result.
- **Write the decision rule before the data**, never after. Both gates below
  were pre-registered in the runbook.
- **Upvotes and "this is sick" count as zero** (§6). So does a demo you drove.

---

## §6 — Success gate

**Done condition:** one `feedback/<sid>.json` (and one Supabase `sessions`
row) from a session you did not start, with `user_id != u1`.

| Criterion | Target | Actual | Date |
|---|---|---|---|
| Invite redemptions (any launch) | ≥3 | — | — |
| Completed rounds by someone else | ≥1 | — | — |
| Unprompted follow-up ("can I do another") | ≥1 | — | — |

**Verdict:** _not yet run_

---

## §6a — Willingness-to-pay gate

Armed by `IP_PAYWALL_GATE=1`. Price shown: **$39/mo**, after 3 free rounds
(or 3 free plans). The gate really denies — "Maybe later" means no round —
and no card details are collected anywhere. Read the log per the runbook's
§6a commands, **deduped by `user_id`**.

| Reading | Distinct users |
|---|---|
| `gated` — actually stopped (the denominator) | — |
| `would_pay` — pressed Subscribe | — |
| `would_pay_confirmed` — agreed to be emailed | — |
| `notify_declined` — clicked, then would not be contacted | — |
| `not_yet` — declined, took no round | — |

**Pre-registered rule:**

- ≥5 gated, ≥1 `would_pay_confirmed` → a price worth pursuing; read `expect`.
- ≥5 gated, several `would_pay` but 0 confirmed → people click a free button
  and will not commit. No at $39.
- ≥5 gated, 0 `would_pay` → no at $39; lower the price and re-run.
- <5 gated → **the instrument did not run.** Not a negative result. Lower
  `IP_PAYWALL_FREE_ROUNDS` or get more users.

**Verdict:** _not yet run_

### Why the two numbers differ

`would_pay` costs nothing and still yields the round, so it is a **ceiling**.
`would_pay_confirmed` is a second deliberate act that costs something real —
agreeing to be contacted about paying. The gap between them is the size of the
cheap-talk problem, measured rather than assumed. Report both; lead with the
confirmed one.

### Free-text answers ("what would you expect to pay?")

Verbatim, with who said it. **Anchored below $39 by construction** — every
answer was given after seeing that price. Read as a floor, not an estimate.

| Who | Answer |
|---|---|
| — | — |

### Notes

Cost floor for reference, from the 2026-08-14 costing pass: a mock costs
~$1.35 sourced / ~$4.39 invented (build costs measured, TODOS #57; the ~$0.85
run-cost is an estimate), and a plan ~$1.00. Any price that clears has to
clear that. Full unit economics and the tier modelling live in the costing
artifact from that session.

A fresh email resets the counters — signup is open by decision (2026-08-12).
At this size that costs precision, not money.
