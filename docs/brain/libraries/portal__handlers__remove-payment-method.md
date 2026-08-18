# libraries/portal/handlers/remove-payment-method

Portal route: revoke a saved payment method the customer no longer wants on file.

**File:** `src/lib/portal/handlers/remove-payment-method.ts`
**Route:** `POST /api/portal?route=remove_payment_method` (aliases: `removePaymentMethod`, `removepaymentmethod`)

## Why

Ticket `9bc2e674` (G esposito) surfaced a product gap: the customer asked 4+ times to remove three duplicate saved Mastercards (all ending 9009). The portal previously only LISTED cards and ADDED new ones (via [[portal__handlers__payment-methods]] and [[portal__handlers__payment-method-update]]) — there was no delete/revoke path anywhere on `customer_payment_methods`, and the orchestrator's `switch_payment_method` action only changes the default, not removes a card. The AI extrapolated to "scroll to Payment Methods and remove the duplicates" — an instruction the portal could not fulfill, which is the root of the customer's repeated frustration. This handler + the paired `getPaymentMethods` orchestrator-tool wording fix closes that gap.

## Guardrails (deliberate customer-only / PCI stance)

- **Customer-only** — same auth+ban gate as every other portal handler. There is NO agent-side removal action; support cannot revoke a card on the customer's behalf, per the deliberate customer-only / PCI stance called out in the ticket. If a signed-out customer asks, the answer is "sign in and remove it there," not "we'll do it for you."
- **Braintree-vaulted cards only.** Shopify-Payments cards live in Shopify's vault; a local flip would be re-mirrored back — `syncShopifyPaymentMethods` in [[dunning]] hard-sets `status: "active"` on any existing row it still sees, so a manual "cleanup" of those rows silently resurrects itself. Refuse with `not_removable_here`. Since ticket `c969f235` those cards are no longer listed by [[portal__handlers__payment-methods]] at all, so the customer cannot reach this refusal through the UI; the guard remains for direct API callers. **Never** answer a Shopify-vaulted card by pointing the customer at a Shopify account page (see [[portal-urls]]).
- **Blocked on active-subscription pin.** A card currently pinned to an active/paused *internal* subscription cannot be removed — losing it mid-cycle breaks the next renewal. Response is `409 pinned_to_active_subscription` with the offending `subscription_ids` so the caller can prompt the customer to switch that sub's card first (via [[portal__handlers__set-subscription-payment-method]]) or add a replacement.
- **Blocked when this is the LAST card funding an active subscription.** The renewal charge path in [[../inngest/internal-subscription-renewals]] (see `src/lib/inngest/internal-subscription-renewals.ts:694-722`) reads `sub.payment_method_id` first and, when null, falls back to the link group's `is_default` active card; if neither resolves the renewal returns `{ skip: true, reason: "no_payment_method" }` and silently does not charge. The pinned guard above therefore only covers subscriptions that explicitly pin this card — removing the ONLY active Braintree card in the link group would still silently break every sub that relies on the default-card fallback. So the handler ALSO refuses removal with `409 last_card_for_active_subscription` (with the blocking `subscription_ids`) when no replacement card exists AND at least one internal subscription in the link group is still active/paused. The decision is factored out as the pure exported predicate `shouldBlockLastCardRemoval({ replacementCardId, activeInternalSubCount })` (returns true iff `replacementCardId === null && activeInternalSubCount > 0`) so a test can pin the rule without mocking Supabase — the same shape [[action-executor]] uses for `pickChargeableVaultedPm` in `src/lib/action-executor.vaulted-pm-guard.test.ts`. Cover in `src/lib/portal/handlers/remove-payment-method.guard.test.ts` (registered as `test:remove-payment-method-guard` in `package.json`).
- **Default promotion.** When the removed card was `is_default`, the most-recently-created active Braintree card belonging to anyone in the customer's link group is promoted to default in the same request.
- **Write order is local-first, error-checked, then best-effort vault.** The previous order (Braintree delete → local flip → default promotion, none of them error-checked) could destroy the vault entry while leaving the local row still reading `status='active'` + `is_default=true`, and the next renewal would pick it and charge a token that no longer exists. The corrected order is: (1) flip the local row to `status='removed'` + `is_default=false` and CHECK the error (500 on failure — the vault is NOT touched); (2) promote the replacement default and CHECK the error (500 on failure); (3) best-effort Braintree `paymentMethod.delete`. A vault failure after a successful local flip is now an orphaned vault entry (harmless), never a live local row pointing at a dead token.
- **Credential-free by rule: the vaulted Braintree token is never interpolated into any log line.** The security review of the first build flagged `String(pm.braintree_payment_method_token).slice(0, 8)` inside the Braintree-delete `catch` block as a credential leak — the token is a charge/delete credential and even a prefix of it is credential material. The remediation removed the interpolation entirely; the delete-failure `console.warn` now logs only `payment_method_id` + `workspace_id` and a sanitized error via `errText(e)` from [[error-text]]. A future edit that reintroduces the token in a log line is blocked by [[../../../scripts/_check-no-braintree-token-in-log.ts]] — a static-analysis check that scans every backtick template literal in the handler for the substring `braintree_payment_method_token` and fails `predeploy:static`. The vault delete stays best-effort: a Braintree outage after the local flip is an orphaned vault entry (harmless), never a live local row pointing at a dead token.
- **Every `customer_payment_methods` update is `workspace_id`-scoped.** Both the local flip (`status='removed'`, `is_default=false`) and the default-promotion update carry `.eq("workspace_id", auth.workspaceId)` in addition to the row id. The id came from a workspace-scoped select so this is defense in depth, not a live hole — but every other write in this file carries the predicate and this one matches, so an id collision across tenants can never write across workspaces even if the read-side filter regressed.

## Request / response

```ts
POST /api/portal?route=remove_payment_method
Body: { paymentMethodId: string }

// Success
{ ok: true, removed: { id, brand, last4 }, new_default_id: string | null, already_removed?: true }

// Errors (all `{ ok: false, error: <code>, … }`)
// 400 missing_paymentMethodId
// 400 not_removable_here   (provider !== "braintree")
// 401 not_logged_in
// 403 payment_method_not_in_group
// 404 customer_not_found | payment_method_not_found
// 409 pinned_to_active_subscription  (with pinned_subscription_ids: string[])
// 409 last_card_for_active_subscription  (with subscription_ids: string[])
// 500 local_flip_failed  (row-update error — vault NOT touched)
// 500 default_promotion_failed  (row-update error on the new-default row)
```

## Exports

### `removePaymentMethod` — const

```ts
const removePaymentMethod: RouteHandler
```

### `shouldBlockLastCardRemoval` — function

```ts
function shouldBlockLastCardRemoval(args: {
  replacementCardId: string | null;
  activeInternalSubCount: number;
}): boolean
```

Returns `true` iff there is no replacement card AND at least one active/paused internal subscription in the link group. Pure — extracted so `remove-payment-method.guard.test.ts` can pin the rule without mocking Supabase.

## Callers

- Registered in [[portal__handlers__index]] `routeMap` under `removePaymentMethod` / `removepaymentmethod` / `remove_payment_method`.
- No agent-side caller — deliberate PCI stance (customer-only).

## Related knowledge fix

The Sonnet orchestrator's `getPaymentMethods` tool output (`src/lib/sonnet-orchestrator-v2.ts`) previously told the AI "customer can add/remove/set-default there" as one blanket line, which was paraphrased into the false "remove duplicates via the portal" instruction that Shopify-Payments cards could never satisfy. It now distinguishes STOREFRONT-VAULTED (add + remove supported here) from SHOPIFY PAYMENT METHODS (legacy vault, not listed in our portal, nothing for the customer to do) and states the billing-safe truth about duplicate cards (dunning dedupes by last4 + expiry, so a duplicate never causes a double charge) so the AI can reassure without inventing a self-serve step. Ticket `c969f235` closed the second half: the URL it quotes is now OUR portal via [[portal-urls]], and the Shopify bullet no longer tells the AI to send the customer to a Shopify account page — the instruction that kept G esposito hunting for a delete button that did not exist.

## Gotchas

- The handler does NOT participate in `MUTATION_GATED_ROUTES` — the first-delivery gate is subscription-scoped, and wallet removal is customer-scoped (no `contractId` in the request).
- `already_removed: true` is returned on a repeat call (idempotent) instead of a 404 — a client's optimistic UI can safely retry after a network hiccup.
- A card belonging to a linked account in the same group is removable by any member of the group, matching how the wallet is presented across the linked profiles in [[portal__handlers__payment-methods]].

---

[[../README]] · [[../../CLAUDE]]
