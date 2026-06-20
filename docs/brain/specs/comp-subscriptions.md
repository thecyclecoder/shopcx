# Comp Subscriptions (employee / influencer / free-product) ✅

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

## Phase 1 — allowlist + comp mode + renewal + migration + Zach ✅
Migration (`customers.comp_role` enum + `comp_note`; `subscriptions.comp` + `comp_note`); renewal-path comp branch (**allowlist gate first — fail-closed if not allowlisted**, then no-PM, no-charge, still-fulfill, advance); `migrateToInternalComp` (no-PM Appstle→internal comp); allowlist + migrate Zach. Brain: [[../tables/customers]] (comp_role) + [[../tables/subscriptions]] + [[../lifecycles/subscription-billing.md]] + [[../libraries/migrate-to-internal]].

**Shipped** (code + both gated prod ops applied):
- ✅ Migration `supabase/migrations/20260620190000_comp_subscriptions.sql` (`comp_role` enum + `comp_note` on customers; `comp` + `comp_note` on subscriptions; partial indexes `idx_subscriptions_comp`, `idx_customers_comp_role`). Apply: `npx tsx scripts/apply-comp-subscriptions-migration.ts`.
- ✅ Renewal comp branch in `src/lib/inngest/internal-subscription-renewals.ts` (`load-comp-context` → fail-closed gate → $0 order + Amplifier + `type='comp'` transaction + advance; no PM/Braintree/Avalara/shipping/dunning).
- ✅ `migrateContractToInternalComp` in `src/lib/migrate-to-internal.ts` (no-PM Appstle→internal comp; sets `comp=true` + item `price_override_cents=0`).
- ✅ Brain: tables/customers, tables/subscriptions, lifecycles/subscription-billing, libraries/migrate-to-internal (new page), inngest/internal-subscription-renewals.
- ✅ **Gated owner actions applied:** (1) migration applied via `scripts/apply-comp-subscriptions-migration.ts`; (2) `scripts/migrate-zach-comp-subscription.ts` ran — Zach allowlisted (`comp_role='employee'`) + contract `27852472493` flipped to internal comp. Run the [[#verification]] checklist to confirm his next renewal ships free.

## Phase 2 — Customers → Comp Subscriptions list ✅
The sidebar page + read view. Brain: [[../dashboard/comp-subscriptions]].

**Shipped:**
- ✅ Page `src/app/dashboard/comp-subscriptions/page.tsx` — every `comp=true` sub: customer name+email, role badge (`not allowlisted` in red when `comp_role` null), note, items+quantities, cadence, next ship date, status. Role group tabs (All · Employees · Influencers · Investors · Owners) with live counts; customer search; sortable Next Ship / Status; row → subscription detail.
- ✅ API `src/app/api/workspaces/[id]/comp-subscriptions/route.ts` — `comp=true` subs joined `customers!inner(comp_role, comp_note)`; `role` / `search` / `sort` / `order` params; returns `{ subscriptions, total, role_counts }`.
- ✅ Sidebar entry under **Customers** → "Comp Subscriptions" (adminOnly).
- ✅ Brain: `docs/brain/dashboard/comp-subscriptions.md`.
- Deferred (stretch, not in v1): "Add to allowlist" / "New comp sub" write actions — read view only.

## Verification
Phase-1 checklist (run after the two gated ops land). "ws" = `fdc11e10-b89f-4989-8b73-ed6526c4d906`.

- **Migration applied** → in Supabase, `\d customers` shows `comp_role` (type `comp_role`) + `comp_note`; `\d subscriptions` shows `comp bool default false` + `comp_note`; `\di idx_subscriptions_comp`, `idx_customers_comp_role` exist. (Or run `npx tsx scripts/_verify-*` style probe.)
- **Zach allowlisted** → `select comp_role, comp_note from customers where email ilike 'zachary@superfoodscompany.com'` → `employee` / `employee`.
- **Zach migrated to comp** → `select is_internal, comp, comp_note, status, shopify_contract_id, next_billing_date, items from subscriptions where id = <Zach sub>` → `is_internal=true`, `comp=true`, `comp_note='employee'`, `shopify_contract_id` like `internal-%`, items unchanged (each with `price_override_cents=0`), cadence + next date preserved. Appstle contract `27852472493` shows `CANCELLED` (reason "migrated to shopcx (comp)"). His timeline has a `subscription.migrated` (source `comp_migration`) event.
- **Comp renewal ships free** → when Zach's `next_billing_date` rolls (or fire `internal-subscription/renewal-attempt` with his `subscription_id`): expect a new [[../tables/orders]] row `total_cents=0`, `financial_status='paid'`, `source_name='internal_subscription_comp_renewal'`, `payment_details.comp=true`, an Amplifier handoff (`amplifier_order_id` set), a `transactions` row `type='comp' status='succeeded' amount_cents=0` (no Braintree id), `next_billing_date` advanced one cadence, a `subscription.comp_shipped` event. **No** Braintree charge, **no** `dunning_cycles` row, **no** `dunning/payment-failed` event.
- **Fail-closed (negative)** → temporarily a `comp=true` sub whose customer has `comp_role IS NULL`, fire `renewal-attempt`: expect a `transactions` row `type='comp' status='failed'` (`metadata.needs_attention=true`), a `subscription.comp_renewal_failed` event, and **no** new order, **no** Amplifier handoff, **no** `next_billing_date` advance.

Phase-2 checklist (the list view).
- On the dashboard sidebar (as owner/admin), open **Customers → Comp Subscriptions** → expect the page at `/dashboard/comp-subscriptions` with Zach under the **Employees** tab (role badge `employee`, note `employee`, his items + cadence + next ship date, status `active`).
- On `/dashboard/comp-subscriptions`, click the **Employees** tab → expect only `comp_role='employee'` subs; each tab's badge count matches `role_counts` from `GET /api/workspaces/{ws}/comp-subscriptions`.
- On `/dashboard/comp-subscriptions`, search a comp customer's name/email → expect the list to narrow to matching rows; click a row → navigates to `/dashboard/subscriptions/{id}`.
- `GET /api/workspaces/{ws}/comp-subscriptions` → expect every returned sub has `comp=true`; `total` = count of comp subs (after role/search filters); `role_counts` keys ∈ {employee, influencer, investor, owner, unassigned}.
- Negative (UI surfaces fail-closed) → a `comp=true` sub whose customer has `comp_role IS NULL` shows a red **not allowlisted** badge in the Role column; it appears under the **All** tab (whose count includes the `unassigned` bucket) but under no role-specific tab.
