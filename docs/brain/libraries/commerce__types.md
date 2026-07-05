# libraries/commerce__types

The canonical view shapes every commerce SDK op returns — plus the operation contract types (`DisplayOp`, `MutationOp`, `InternalOrAppstle`).

**File:** `src/lib/commerce/types.ts` · **Spec:** [[../specs/commerce-sdk-scaffold-money-resolver]] · **Depends on:** none

## Why this exists

A view is what a Display op yields for one entity — the fields the current dashboard, portal, and AI hydration paths already read. Ground truth is the brain table pages ([[../tables/subscriptions]], [[../tables/orders]], [[../tables/returns]], [[../tables/chargeback_events]], [[../tables/fraud_cases]], [[../tables/replacements]], [[../tables/customers]], [[../tables/loyalty_members]], [[../tables/crisis_customer_actions]]) — every field on a view corresponds to a column on those tables (or a value derived at read time from them, e.g. priced money).

Money is always **cents (integer)**; never a float, never undefined. The money-invariant guard lives in [[commerce__price]].

## Exports

### Money primitives
- **`Cents`** — an integer cent count. Always defined.
- **`PricedLine`** — `{ base_cents, unit_cents }` pair for one priced line.
- **`DiscountPill`** — a discount pill rendered next to the total.

### View shapes (Display outputs)
- **`SubscriptionLineView`**, **`SubscriptionLatestOrderView`**, **`SubscriptionUpcomingOrderView`**, **`SubscriptionView`**, **`SubscriptionListFilters`**, **`SubscriptionPricingView`** — subscription views.
- **`OrderLineView`**, **`OrderView`** — order views.
- **`ReturnLineView`**, **`ReturnView`** — return views.
- **`ReplacementView`** — replacement view.
- **`CustomerEventsSummaryView`**, **`CustomerDemographicsView`**, **`CustomerView`** — customer views.
- **`LoyaltyRedemptionTierView`**, **`LoyaltyView`**, **`LoyaltyLedgerEntryView`** — loyalty views.
- **`ChargebackView`** — chargeback view.
- **`FraudView`**, **`FraudPostureView`** — fraud views.
- **`CrisisCustomerActionView`**, **`CrisisView`**, **`CrisisContextView`** — crisis views.

### Operation contract types
- **`DisplayOp<TInput, TView>`** — a read-only op: `(workspaceId, input) → view`.
- **`MutationResult<TResult>`** — the payload shape every `MutationOp` returns: `{ success: boolean } & TResult`.
- **`MutationOp<TInput, TResult>`** — a mutation op with optional `.gateway` metadata.
- **`Gateway`** — `"braintree" | "shopify"` — the payment boundary a money-moving mutation routes through.
- **`InternalOrAppstle<T>`** — the branching contract: every op has two implementations (`internal` + `appstle`). Declaring only one branch is a type error.

## Callers

Consumed by every `src/lib/commerce/*.ts` file — see the per-module pages ([[commerce__subscription]], [[commerce__order]], [[commerce__return]], [[commerce__replacement]], [[commerce__customer]], [[commerce__loyalty]], [[commerce__chargeback]], [[commerce__fraud]], [[commerce__crisis]], [[commerce__price]]).

---

[[../README]] · [[../../CLAUDE]] · [[commerce__price]]
