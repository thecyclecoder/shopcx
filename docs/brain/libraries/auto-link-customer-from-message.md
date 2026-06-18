# libraries/auto-link-customer-from-message

Auto-link a different customer profile that is the same person, before Sonnet runs — two strategies: identifiers in the message (email / order number) **and** an exact-after-normalization name+address match.

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

### Identity match (exact name + address) — `autoLinkCustomerByIdentity`

Some same-person splits have **no shared identifier in the message** — the customer can't quote the order number or the other email because they don't know it. A split across two email providers is the common shape: the active subscription / renewal order lives on the profile the ticket *isn't* linked to.

Motivating case — ticket f64d979b: "Pam Bensley" (`p_sb38@hotmail.com`, 4 cancelled subs, no recent order) wrote in to cancel a renewal she didn't recognize. The renewal (`SC132642`) + active sub actually live on "Pamela Bensley" (`psb71us@outlook.com`, same address "5318 S Katy Road"). Until linked, `get_customer_account` on the ticket profile showed nothing to cancel/refund and the refund playbook couldn't fire.

A name+address match is a high-confidence "same human" signal, so it links **without asking the customer** (unlike the fuzzy suggestions in the agent UI, which need human confirm). Match rule:

- **Last name** identical (case-insensitive).
- **First name** identical, or one an exact prefix of the other with the shorter ≥3 chars (`Pam`→`Pamela`, `Rob`→`Robert`; never `Al`→`Alexander`). Both must be present.
- **Address** `address1` identical after normalization (lowercase, strip `.,#`, fold USPS street/directional abbreviations: `south`→`s`, `road`→`rd`, …) **and** first-5 of `zip` identical.

Honors [[../tables/customers]] `customer_link_rejections` in **either direction** — a previously-rejected pair is never re-linked.

## Exports

### `autoLinkCustomerFromMessage` — function

```ts
async function autoLinkCustomerFromMessage(admin: SupabaseClient, workspaceId: string, ticketId: string, customerId: string): Promise<AutoLinkResult>
// AutoLinkResult = { linkedCount: number; linkedEmails: string[] }
// linkedEmails entries are labels, e.g. "kzcosmetiks@gmail.com (order SC132076)"
```

### `autoLinkCustomerByIdentity` — function

```ts
async function autoLinkCustomerByIdentity(admin: SupabaseClient, workspaceId: string, customerId: string): Promise<AutoLinkResult>
// Links every same-workspace profile that matches by exact-normalized name + address.
// No ticketId — keys off the customer's own name/default_address, not message text.
```

## Callers

- [[../inngest/unified-ticket-handler]] — `auto-link-from-inbound` step (`autoLinkCustomerFromMessage`) and `auto-link-by-identity` step (`autoLinkCustomerByIdentity`), both before the Sonnet orchestrator.

## Gotchas

- **Links commit silently** — an explicit mention IS the confirmation. No inline confirm step (that's Phase 3, for name-match *candidates*).
- **Over-matching is harmless** — every order-number candidate is validated against a real order before linking; junk tokens resolve to nothing. Capped at 5 Shopify lookups per run.
- **Bare numerics only match in an explicit "order #…" context** — keeps phone numbers / zips / dollar amounts from triggering Shopify lookups.
- **Never throws** — order resolution (incl. the Shopify call) is wrapped; a linking miss never blocks the orchestrator.
- **Phone extraction is not implemented** despite older docs — emails + order numbers only.
- **Identity match needs a full identity** — last name (≥2 chars) **and** first name **and** `default_address.address1`+`zip`. A profile missing any of these is skipped (won't auto-link on last-name+address alone — too easy to merge a parent/child or roommate). Address-exact + 5-digit-zip is what keeps same-name-different-people apart.

---

[[../README]] · [[../../CLAUDE]] · [[../lifecycles/customer-link-confirmation]]
