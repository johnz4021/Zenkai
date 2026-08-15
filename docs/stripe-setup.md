# Stripe billing setup

Referenced from `docs/beta-runbook.md`. Everything code-side ships on the
`stripe-billing` branch; this is the dashboard half, done once.

Billing is **off** until all three env vars are set. With it off the paywall
gate still works exactly as before and manual comps still work — there is just
nothing to buy. That is also the rollback: clear the three vars and restart.

## 0. No Stripe account yet? Test the whole thing first

```bash
npm i -g @stripe/cli
stripe sandbox create      # working test keys, no registration
```

Everything below except step 4 (going live) works against that sandbox.

## 1. Product and Price (~5 min)

One **Product** per plan — not one product with several prices. Checkout and
invoices show the Product name on each line item, so tiers sharing a product
are indistinguishable on the customer's receipt.

- Product: **Zenkai Pro**
- Price: **$29.00 / month**, recurring.

Copy the Price id (`price_...`) into `STRIPE_PRICE_ID`.

The gate reads this Price at boot and uses its real amount for display, so
`IP_PAYWALL_PRICE_USD` cannot drift away from what customers are actually
charged. A mismatch logs a warning naming both numbers.

## 2. A restricted key, not a secret key (~5 min)

Dashboard → Developers → API keys → **Create restricted key** (`rk_`).
Least privilege — a leaked restricted key can do far less than a leaked `sk_`:

| Resource | Permission |
|---|---|
| Checkout Sessions | write |
| Customers | write |
| Billing Portal Sessions | write |
| Subscriptions | read |
| Prices | read |

Nothing else. Into `STRIPE_API_KEY`.

**Never commit a key.** They live in `.env`, which is gitignored, and
`child-env.ts` drops them for every child process so no agentic `claude -p`
generator ever sees them. Consider a pre-commit hook for `sk_`/`rk_`.

## 3. Webhook (~5 min)

Dashboard → Developers → Webhooks → **Add endpoint**:

- URL: `https://zenkai.run/api/stripe/webhook`
- Events: `checkout.session.completed`, `customer.subscription.created`,
  `customer.subscription.updated`, `customer.subscription.deleted`,
  `invoice.payment_succeeded`, `invoice.payment_failed`

Copy the signing secret (`whsec_...`) into `STRIPE_WEBHOOK_SECRET`.

That endpoint is the one `/api/` route with no login requirement, because
Stripe sends no JWT — the **signature is its authentication**, verified before
the payload is read. A request that fails verification gets a 400 and is never
processed.

Locally, skip the dashboard and use:

```bash
stripe listen --forward-to localhost:3300/api/stripe/webhook
```

which prints its own `whsec_`.

## 4. Customer Portal (~2 min)

Dashboard → Settings → Billing → **Customer portal** → enable cancellation and
payment-method updates. Cancellation, receipts and dunning are Stripe's, not
ours — the app only opens a portal session.

## 5. Tax — decide before you charge anyone

If you will charge US or EU customers you need **Stripe Tax** *and* an active
registration for the jurisdiction. Enabling `automatic_tax` without a
registration **collects nothing and returns no error** — the most common
Stripe Tax mistake, and it fails silently for months.

This integration deliberately does **not** enable `automatic_tax`. Turning it
on is a decision with a registration behind it, not a flag.

## 6. Verify end to end

```bash
stripe listen --forward-to localhost:3300/api/stripe/webhook
IP_PAYWALL_GATE=1 IP_PAYWALL_FREE_ROUNDS=0 npx tsx server/src/cli.ts app
```

1. Hit the gate → **Subscribe** → Stripe Checkout.
2. Card `4242 4242 4242 4242`, any future expiry, any CVC.
3. Back on the app: **the gated action completes on its own**. That is
   confirm-on-return replaying the intent it stashed before redirecting — the
   webhook has not necessarily landed yet, and does not need to have.
4. `stripe trigger customer.subscription.deleted` → next gated action refuses.
5. `stripe trigger invoice.payment_failed` → `past_due` → **still entitled**,
   deliberately: Stripe retries a failed card for days and cutting someone off
   mid-prep over a transient decline costs more than the rounds it saves.

Check the ledger:

```bash
jq -c '{user_id, status, current_period_start}' subscriptions.jsonl
```

## Kill switch

Two levels, both a restart apart (`sudo systemctl restart zenkai-app`, ~10s;
`KillMode=process` means live rounds are untouched):

- **Billing off, gate on** — clear the three `STRIPE_*` vars. Nobody can buy;
  the free allowance still applies. Use this if checkout misbehaves.
- **Everything off** — clear `IP_PAYWALL_GATE`. Every door opens regardless of
  subscription state. Use this if the gate itself misbehaves.

## Comping someone

The manual grant predates billing and still works. Append one line to
`paywall.jsonl` and that user is through permanently, no Stripe involved:

```bash
echo '{"ts":"'"$(date -u +%FT%TZ)"'","user_id":"<their id>","action":"would_pay"}' >> paywall.jsonl
```

Their `user_id` is in `/api/state` or any `feedback/<sid>.json` they own. This
is the lever for handing free access to people whose feedback is worth having.
