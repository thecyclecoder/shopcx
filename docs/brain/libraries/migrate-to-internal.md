# migrate-to-internal.ts

`src/lib/migrate-to-internal.ts` — the **strangler migration**: flip a customer's Appstle subscriptions to internal billing **in place** (no new rows, so the stable `subscriptions.id` and every reference to it stays valid). Called wherever we capture a payment method (checkout, portal add-card, recovery) and by the self-healing guard on portal load.

Full flow: [[../lifecycles/subscription-billing]] § Migration path.

## Exports

- **`migrateCustomerAppstleSubsToInternal(workspaceId, customerId, opts?) → MigrateResult`** — migrates **all** Appstle subs across the customer's link group. **HARD RULE: a migration must be billable** — resolves the link-group member with a default Braintree PM, reassigns the sub to it, and **skips** every sub when no linked account has a PM. Per sub: read the **live** Appstle contract → translate lines → internal catalog UUID refs (grandfathered lines get `price_override_cents`, via [[appstle-pricing]] `inferAppstleLineBase`) → cancel the Appstle contract → flip the row `is_internal=true` / native `internal-*` id / billable customer → record + verify a [[migration-audit]] audit. `opts.isRecovery` threads from the payment-recovery flow. Returns `{ migrated, skipped, failed }`.
- **`migrateContractToInternalComp(workspaceId, contractId, { compNote? }) → { ok, subId?, internalContractId?, error? }`** — **comp** migration for **one** contract. Same translate-lines + cancel-contract, but **no billable-PM requirement** (a comp sub never charges) and the `customer_id` is **preserved** (no reassignment). Sets `comp=true` + `comp_note` + **every item `price_override_cents=0`** (base $0, overriding any grandfathered base). Preserves items/cadence/next date/status. **Idempotent** (a contract already `is_internal && comp` returns ok). **No `migration_audit`** is recorded — the audit's `card_pinned` check expects a billable card a comp sub deliberately lacks. Used by `scripts/migrate-zach-comp-subscription.ts` (first comp sub: Zach Zavala, employee).
- **`ensureGroupMigratedIfBillable(workspaceId, customerId) → count`** — cheap self-healing guard (one count query); runs `migrateCustomerAppstleSubsToInternal` only when a link-group Appstle straggler exists **and** there's a working default Braintree PM. Call it wherever subs are fetched.

## Internal helpers

- `appstleLinesToInternalItems` — translate live Appstle lines → internal catalog UUID refs (no baked price; grandfathered → `price_override_cents`). Lines not in our catalog keep the legacy Shopify-id + baked-price shape.
- `linkedCustomerIds` / `findBillableCustomer` — link-group expansion + billable-member resolution (default Braintree PM, prefer the passed-in customer).

## Gotchas

- **Cancel-then-flip** — cancel the Appstle contract FIRST so a later flip failure stops the sub (re-runnable) rather than double-billing it. Already-cancelled subs skip the cancel.
- **Comp vs billable** — `migrateContractToInternalComp` deliberately bypasses the billable-PM rule and skips the audit. Never use it for a sub that should actually charge — it sets base $0. Conversely a normal migration never sets `comp`.
- Cancelled subs migrate using the local row when the live Appstle contract is unreadable; an active/paused sub that can't be read is left alone (re-runnable).

---

[[../README]] · [[../lifecycles/subscription-billing]] · [[migration-audit]] · [[appstle-pricing]] · [[../integrations/appstle]] · [[../tables/subscriptions]] · [[../tables/customers]] · [[../../CLAUDE]]
