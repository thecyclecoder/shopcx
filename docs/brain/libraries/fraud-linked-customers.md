# libraries/fraud-linked-customers

Shared resolver for the full set of customer accounts a fraud case covers — the case's own `customer_ids`, plus ids the analyzer stashed on `fraud_cases.evidence`, plus every account linked to any of those via a [[../tables/customer_links]] group.

**File:** `src/lib/fraud-linked-customers.ts`

## Why it exists

Two places in the fraud flow need "every account this case is about" and, before this module, computed that set with their own inline code:

- `src/app/api/workspaces/[id]/fraud-cases/[caseId]/investigate/route.ts` — the GET that fills the operator's fraud detail page. Its list is what renders on `src/app/dashboard/fraud/[id]/page.tsx` as **Customer Accounts (N)** — the list the operator reads and decides fraud against.
- `src/app/api/workspaces/[id]/fraud-cases/[caseId]/confirm-fraud/route.ts` — the confirm wizard's `ban_customer` step.

Ground truth: on 2026-09-07 the operator confirmed fraud on case `5182b1dd` after reading the 21-account list. The `ban_customer` step iterated only the case's own `customer_ids` and ended up flipping `portal_banned` on exactly one row. Thirteen sibling accounts at the same postcode (including three deliberate typosquats of the confirmed email) kept ordering for a full day until someone caught it by hand.

Both routes now call `resolveFraudCaseLinkedCustomers` so the list the operator saw and the list the ban actually covers cannot drift apart. This is the same north-star pattern as [[policies]]'s two-halves rule — a control that silently applies to a fraction of what the operator was shown is a hole in it.

## Exports

### `resolveFraudCaseLinkedCustomers` — function

```ts
async function resolveFraudCaseLinkedCustomers(
  admin: SupabaseClient,
  fraudCase: { customer_ids: string[] | null; evidence: unknown }
): Promise<LinkedCustomersResult>
```

Callers pass a service-role admin client because both current call sites already run behind an owner/admin membership gate.

### `LinkedCustomersResult` — interface

```ts
interface LinkedCustomersResult {
  caseCustomerIds: string[];  // seed: fraud_cases.customer_ids + evidence.customer_id / evidence.customers[*].customer_id
  allCustomerIds: string[];   // seed unioned with every customer_links group member. Deduped, stable order.
}
```

## Semantics

1. Start from `fraud_cases.customer_ids`.
2. Union in `evidence.customer_id` (string, if present) and `evidence.customers[*].customer_id` — the analyzer sometimes writes those instead of / in addition to the top-level array.
3. Look up every [[../tables/customer_links]] row for the seed set; collect distinct `group_id`s.
4. Load every customer_link member of those groups; union their `customer_id`s in.
5. Return both the seed set (`caseCustomerIds`) and the expanded cluster (`allCustomerIds`).

## Callers

- `src/app/api/workspaces/[id]/fraud-cases/[caseId]/investigate/route.ts` (GET) — feeds the "Customer Accounts" list on the fraud detail page. Marks each row `is_case_customer` / `is_linked` using the seed set.
- `src/app/api/workspaces/[id]/fraud-cases/[caseId]/confirm-fraud/route.ts` (POST, `step=ban_customer`) — bans the linked cluster. The response includes `results[]` (per-account `banned` / `already_banned` / `error`, plus `email`) and `scope` (`linked_customer_ids`, `targeted_customer_ids`, and count breakdown) so the caller renders the true blast radius instead of assuming.

## Related

- [[../tables/customer_links]] — the group table this resolver expands over
- [[../tables/fraud_cases]] — source of the seed customer_ids / evidence
- [[../operational-rules]] § North star — supervisable autonomy: the operator's screen and the tool's action must not diverge
