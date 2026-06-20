# Comp Subscriptions (employee / influencer / free-product) ⏳

**Owner:** [[../functions/retention]] · **Parent:** Retention mandate "Subscription continuity & billing integrity" ([[../lifecycles/subscription-billing.md]]). Triggered live by Zach Zavala (employee) being charged on SC133080 (refunded).

A **comp subscription**: an internal sub that **ships on schedule for free** — base price $0, **no saved payment method required**, no charge attempted — for **employees, influencers, and anyone we send free product to regularly**. Today the internal-renewal cron **skips** a sub if `totalCents <= 0` (`zero_total`) *or* if there's no payment method (`no_payment_method`) — so a free sub silently stops fulfilling. This adds a first-class comp mode that fulfills without billing, a no-PM migration path off Appstle, and a **Customers → Comp Subscriptions** list so we can see everyone on free product.

## Allowlist + the $0-renewal gate (the safety rule)
A $0 renewal is **only** allowed for a customer on a **comp allowlist**, flagged by role; **otherwise a $0 / comp renewal FAILS** (fail-closed — never ship free off an unbacked $0 sub).
- **`customers.comp_role`** (enum: `employee` ｜ `influencer` ｜ `investor` ｜ `owner`, nullable; null = not comp-eligible) + `comp_note text?`. Setting it = adding the customer to the allowlist (owner/admin only). The set of customers with a non-null `comp_role` *is* the allowlist (drives both the renewal gate and the list view).
- **The gate (in the renewal path):** before a comp/$0 renewal fulfills, check the sub's customer has a valid `comp_role`. **Allowlisted → ship free; not allowlisted → the renewal FAILS** (surface it — a failed/`needs_attention` transaction + event; do NOT silently ship, do NOT advance). This catches a $0 sub that shouldn't be free (misconfig, abuse, a stale comp flag) instead of leaking product.

## Mechanism
- **Marker** — add to `subscriptions`: `comp boolean default false` + `comp_note text?`. A comp sub is **internal** (`is_internal=true`) with item `price_override_cents=0` (base price $0), and only ships free when its customer is allowlisted (above). See [[../tables/subscriptions]].
- **Renewal path** (`src/lib/inngest/internal-subscription-renewals.ts`) — when `comp=true`:
  - **FIRST gate on the allowlist:** if the customer's `comp_role` is null/invalid → **FAIL** the renewal (failed/`needs_attention` transaction + `customer_events`), do NOT ship, do NOT advance. Only proceed to ship-free when allowlisted.
  - **Do NOT require a payment method** (skip the `no_payment_method` early-return).
  - **Do NOT attempt a Braintree charge** (skip `transaction.sale`) and **do NOT treat `totalCents<=0` as a skip** — a comp sub is $0 *by design*.
  - **Still fulfill**: create the renewal `order` (total $0; a clear marker — `financial_status='paid'` $0 or a `comp` flag — that does **not** trip dunning or read as a failed payment), **advance `next_billing_date`**, hand off to **Amplifier** for shipment, generate the packing slip. Record a `transaction` row `type='comp'` (status succeeded, $0, no Braintree id) for the ledger.
  - Tax/coupons/shipping: a comp sub is fully free (no tax quote, no shipping charge) — skip Avalara + shipping pricing; it just ships.
- **No-PM migration off Appstle** — `migrateToInternal` today **hard-requires a billable PM** (no orphan subs). Add a **comp path** (`migrateCustomerToInternalComp` or a `{comp:true, compNote}` option) that: reads the live Appstle contract (items/cadence/next date), cancels the Appstle contract, flips the row `is_internal=true` + `comp=true` + item `price_override_cents=0`, **without** the PM requirement (comp subs never charge, so "must be billable" doesn't apply). Reuses the existing translate-lines + cancel-contract + audit steps.

## Customers → Comp Subscriptions (the list view)
A new page under the **Customers** sidebar: **Comp Subscriptions** — every `comp=true` sub: customer name + email, **role** (`comp_role`: employee/influencer/investor/owner) + `comp_note`, items + quantities, cadence + **next ship date**, status. **Group/filter by role** (Employees · Influencers · Investors · Owners) — this is the comp **allowlist** roster: at-a-glance "who gets free product, in what category, and what ships next." (Stretch: "Add to allowlist" / "New comp sub" actions — v1 is the read view + the renewal/migration plumbing.)

## Guardrails
- **Comp ≠ broken payment.** The renewal path must distinguish `comp=true` (free by design → fulfill, no charge, no dunning) from a genuine `no_payment_method`/decline (→ dunning). Never route a comp sub into dunning or mark it failed.
- **Comp is set deliberately** (owner/admin), not auto. The list view makes the standing free-product roster visible + auditable so it doesn't sprawl silently.

## Zach (the first comp sub) + verification
- **Allowlist Zach** (`customers.comp_role='employee'`) and **migrate** him off Appstle (contract `27852472493`) → internal **comp** sub, item `price_override_cents=0`, `comp_note="employee"`, preserving items/cadence/next date. (His SC133080 charge is already refunded.) Confirm his next renewal **ships free** (a $0 order + Amplifier handoff, no charge, no dunning) and he appears under **Employees** on **Customers → Comp Subscriptions**.
- Negative: a comp sub with no PM does NOT skip with `no_payment_method`; a comp renewal does NOT call Braintree and does NOT open dunning. **A `comp=true` sub whose customer is NOT allowlisted (`comp_role` null) → the $0 renewal FAILS** (no free shipment, surfaced) — fail-closed.

## Phase 1 — allowlist + comp mode + renewal + migration + Zach ⏳
Migration (`customers.comp_role` enum + `comp_note`; `subscriptions.comp` + `comp_note`); renewal-path comp branch (**allowlist gate first — fail-closed if not allowlisted**, then no-PM, no-charge, still-fulfill, advance); `migrateToInternalComp` (no-PM Appstle→internal comp); allowlist + migrate Zach. Brain: [[../tables/customers]] (comp_role) + [[../tables/subscriptions]] + [[../lifecycles/subscription-billing.md]] + [[../libraries/migrate-to-internal]].

## Phase 2 — Customers → Comp Subscriptions list ⏳
The sidebar page + read view (+ stretch "mark/create comp" action). Brain: [[../dashboard]] customers section.
