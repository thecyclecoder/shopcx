# libraries/add-payment-method-journey-builder

Builds the add-payment-method journey: a single card-entry step that mounts Braintree Hosted Fields in the mini-site, fed a client token via `/api/journey/[token]/client-token` (mirrors the portal's `braintreeClientToken` handler but auth'd by the journey token).

**File:** `src/lib/add-payment-method-journey-builder.ts`

## File header

```
Add Payment Method Journey Builder

One-step flow — customer with no vaulted card enters one via Braintree Hosted
Fields in the mini-site. Follows the shape of shipping-address-journey-builder.ts.

Steps:
1. add_card — payment_method step, mounts Braintree Hosted Fields.
```

## Exports

### `buildAddPaymentMethodSteps` — function

```ts
async function buildAddPaymentMethodSteps(admin: Admin, workspaceId: string, customerId: string, ticketId: string): Promise<BuiltJourneyConfig>
```

Reads the customer's name + email and returns a single-step config: one `payment_method` step whose `metadata` carries the cardholder name for the Hosted Fields cardholder-line pre-fill.

## Callers

- `src/lib/journey-step-builder.ts` — `buildJourneySteps` dispatches to it for `case "add_payment_method"`.

## Related

- [[journey-step-builder]] — the dispatcher; adds the `payment_method` step type to the shared union.
- [[vault-and-migrate-payment-method]] — the extracted vault → save → migrate sequence. The mini-site journey's `submit-payment` endpoint AND the portal's `updatePaymentMethod` handler both call it, so the two flows never drift.
- [[portal__handlers__payment-methods]] — the portal's "add a card" handler; now a thin wrapper around the shared helper.
- [[migrate-to-internal]] — `migrateCustomerAppstleSubsToInternal` runs synchronously right after the vault so the customer lands on internal billing before the journey signals done.
- [[../integrations/braintree]] — Hosted Fields, client token, vault.

## Gotchas

- Phase 1 delivered the definition + builder + mini-site render (Braintree Hosted Fields mounted via the storefront's `HostedFieldsCard`). **Phase 2** now wires the vault + save + migrate submit via `POST /api/journey/[token]/submit-payment` → `vaultAndMigratePaymentMethod`. Migration is synchronous (Option A migrate-first). On vault failure the session stays `in_progress` (fail closed): the client shows a retry, no completion signal. `migratedCount` + `payment_method_id` are recorded under `journey_sessions.responses._payment_result`. The **completion signal** back to the awaiting playbook is Phase 3.
- Journey config is DB-driven — the `journey_definitions` row (slug `add-payment-method`, `trigger_intent = 'add_payment_method'`) is seeded per-workspace by migration `20260707000000_seed_add_payment_method_journey.sql`. The `config` JSONB is empty by design; this builder generates the shape at click time.
- Mini-site and live-chat MUST emit identical ticket messages — that parity comes from `journey-delivery.ts`, which is channel-driven; the CTA link body is identical across channels.

---

[[../README]] · [[../../CLAUDE]]
