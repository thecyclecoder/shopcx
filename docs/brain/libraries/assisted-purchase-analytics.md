# libraries/assisted-purchase-analytics

Pure SQL builder for the concierge-flow funnel slice — part of [[../recipes/checkout-stuck-concierge-flow]]. Emits the SQL + params vector for one funnel row: **checkout-stuck tickets → assisted-purchase started → order placed** (conversion + recovered revenue), scoped by workspace + time window. Bindable to any parameterized-query transport (an RPC, a direct pg driver, an analytics-tile helper) — kept as pure code so the shape is unit-testable and doesn't need a migration/RPC/view to iterate.

**File:** `src/lib/assisted-purchase-analytics.ts` · **Tests:** `src/lib/assisted-purchase-analytics.test.ts`

## Contract

```ts
interface AssistedPurchaseFunnelSqlInput {
  workspaceId: string;
  windowStart: string;  // inclusive lower bound, ISO 8601 UTC
  windowEnd: string;    // exclusive upper bound, ISO 8601 UTC
}

function buildAssistedPurchaseFunnelSql(input: AssistedPurchaseFunnelSqlInput): string;
function buildAssistedPurchaseFunnelParams(input: AssistedPurchaseFunnelSqlInput):
  [string, string, string, readonly string[]];

interface AssistedPurchaseFunnelRow {
  workspace_id: string;
  window_start: string;
  window_end: string;
  checkout_stuck_tickets: number;
  assisted_purchase_started: number;
  orders_placed: number;
  recovered_revenue_cents: number;
  start_rate: number;         // started / stuck
  placement_rate: number;     // placed / started
  end_to_end_conversion: number;  // placed / stuck — the founder-level slice
}
```

## Signal predicates

The SQL joins three CTEs, each keyed on a durable signal Phases 1–4 already write:

| CTE | Predicate |
|---|---|
| `checkout_stuck` | A `ticket_resolution_events` row with `reasoning='sol:inflection-drift'` AND `chosen->>'reason'='stage1_checkout_stuck'` (Phase-2 stamp from [[inflection-detector]]) — OR a `ticket_directions` row with `chosen_path='journey'` + `plan->>'journey_slug'='add-payment-method'` (Phase-3 blueprint from [[assisted-purchase-direction]]). |
| `assisted_started` | The ticket has a live Direction pointing at the `add-payment-method` journey (payment_journey stage) OR at one of the two session-chosen-only playbook slugs (`assisted-order-purchase` / `assisted-subscription-purchase`, Phase-4 handoff). |
| `orders_placed` | `tickets.playbook_context->>'assisted_purchase_completed'='true'` — the Phase-4 execute-then-confirm signal that only lands after `interpretAssistedCreateResult` on `result.success=true`. |

## Ratios

- `start_rate = started / stuck` — how often Sol authored the assisted-purchase Direction on a checkout-stuck ticket. Should be near 1.0; anything under is a signal the recognizer or the router is dropping tickets.
- `placement_rate = placed / started` — of the flows that started, how many completed. Bounded by customer intent (they may abandon at any stage) — treat < 0.3 as a signal to look at UX friction (Braintree minisite, item confirmation copy, S&S question).
- `end_to_end_conversion = placed / stuck` — the founder-level number. The recovered-revenue funnel.

Every ratio is `ROUND` to 4 decimals and guarded against divide-by-zero via `NULLIF(..., 0)` + a `CASE` fallback to `0::numeric`. A window with zero checkout-stuck tickets returns 0s across the board (never NULL) so the tile can render safely.

## Recovered revenue

Extracted from `tickets.playbook_context->>'assisted_purchase_result_summary'` (the string [[playbook-executor]] `interpretAssistedCreateResult` stamps on success — e.g. `"order SC1234 charged $46.00 to vaulted PM 0011"`). Regexp captures the `$NN.NN` amount, converts to cents, and sums. Not perfect (a future summary format change breaks the extraction), but a code-path assertion up to the external Braintree edge per the spec's Phase-4 verification and safe to iterate on without a schema change.

## Parameterized only

The pure builder never string-concatenates values into the SQL — `$1..$4` placeholders are bound by the caller. Verified by the test suite (`assert.doesNotMatch(sql, new RegExp(INPUT.workspaceId))`).

## Callers

- No production caller yet. The analytics tile / API route that wires this up should:
  1. Import both builders.
  2. Get an admin client (`createAdminClient()`).
  3. Bind the params via a parameterized query transport of choice (an RPC over `run_read_only_sql`, a direct pg driver, or wire up a new tile helper).
  4. Return one `AssistedPurchaseFunnelRow`.

The wire-in checklist lives at [[../recipes/checkout-stuck-concierge-flow]] § "Analytics slice — how to query".

## Related

- [[assisted-purchase-direction]] — Phase 3 blueprint + Phase 5 fast-default guard.
- [[../recipes/checkout-stuck-concierge-flow]] — operational recipe with all signals + guards integrated.
