# libraries/auto-link-customer-from-message

Scan a customer's recent inbound messages for emails / order numbers that point at a different customer profile → auto-link them before Sonnet runs.

**File:** `src/lib/auto-link-customer-from-message.ts`

## What it does

Runs pre-orchestrator on every customer inbound (the `auto-link-from-inbound` step in [[../inngest/unified-ticket-handler]]). Scans the **last 10 inbound external messages** on the ticket and links any identifier that resolves to a *different* customer in the same workspace. Best-effort, never throws.

Two identifier kinds:

1. **Email** — extract addresses (own + transactional domains filtered out), match [[../tables/customers]] by email, link if found.
2. **Order number** — extract `SC######`-style names + bare numerics in an explicit "order #…" context, resolve the order's owner:
   - [[../tables/orders]] by `order_number` (Shopify order name, e.g. `SC132076`; no `name` column), else
   - **Shopify fallback** `orders(first:1, query:"name:…")` → order email + customer → find local profile by `shopify_customer_id` then email → if none, create a minimal customer row (upsert on `workspace_id,shopify_customer_id`).

   Then link that owner to the ticket customer. Authoritative when the customer misremembers which email they ordered under (ticket 23fe617c). See [[../lifecycles/customer-link-confirmation]] Phase 2.

Linking pre-Sonnet lets `get_customer_account` return the merged set so the orchestrator routes straight to the right journey.

## Exports

### `autoLinkCustomerFromMessage` — function

```ts
async function autoLinkCustomerFromMessage(admin: SupabaseClient, workspaceId: string, ticketId: string, customerId: string): Promise<AutoLinkResult>
// AutoLinkResult = { linkedCount: number; linkedEmails: string[] }
// linkedEmails entries are labels, e.g. "kzcosmetiks@gmail.com (order SC132076)"
```

## Callers

- [[../inngest/unified-ticket-handler]] — `auto-link-from-inbound` step (before the Sonnet orchestrator).

## Gotchas

- **Links commit silently** — an explicit mention IS the confirmation. No inline confirm step (that's Phase 3, for name-match *candidates*).
- **Over-matching is harmless** — every order-number candidate is validated against a real order before linking; junk tokens resolve to nothing. Capped at 5 Shopify lookups per run.
- **Bare numerics only match in an explicit "order #…" context** — keeps phone numbers / zips / dollar amounts from triggering Shopify lookups.
- **Never throws** — order resolution (incl. the Shopify call) is wrapped; a linking miss never blocks the orchestrator.
- **Phone extraction is not implemented** despite older docs — emails + order numbers only.

---

[[../README]] · [[../../CLAUDE]] · [[../lifecycles/customer-link-confirmation]]
