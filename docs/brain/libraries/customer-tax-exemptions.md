# libraries/customer-tax-exemptions

Per-customer sales-tax exemption records — the SDK chokepoint for reading and writing [[../tables/customer_tax_exemptions]].

**File:** `src/lib/customer-tax-exemptions.ts`

## File header

```
customer-tax-exemptions SDK — the single sanctioned read/write surface for
`public.customer_tax_exemptions`.

Phase 1 of a-customer-can-be-recorded-as-sales-tax-exempt.

WHY. A customer asked on 2026-08-07 how to apply Oklahoma's sales-tax exemption for one-hundred-
percent disabled veterans. We answered we could not; the answer has changed now that our own
tax engine is live and Avalara identifies the buyer by their email (the same key it uses for a
stored exemption). This SDK is where the exemption record lives so Phase 2 (avalara-cart +
avalara-subscription) can thread it into every `transactions/create` /
`transactions/createoradjust` call, and Phase 3 (support-side founder-approved action) can
record a certificate from a ticket.

⚠️ CLAUDE.md § Raw `.from(...)` with no SDK → STOP. Every read/write to
`public.customer_tax_exemptions` MUST go through this file — the shape gotchas (partial
UNIQUE on `(customer_id, jurisdiction_region) WHERE revoked_at IS NULL`, region uppercased,
expiry honored) all live inside `resolveCustomerTaxExemption` / `recordCustomerTaxExemption` /
`revokeCustomerTaxExemption` so no caller repeats them. Enforced by
`scripts/_check-customer-tax-exemptions-sdk-compliance.ts` (wired into `predeploy`).
```

## Exports

### `resolveCustomerTaxExemption` — function

```ts
async function resolveCustomerTaxExemption(
  admin: Admin,
  workspaceId: string,
  customerId: string,
  shipToRegion: string,
): Promise<CustomerTaxExemptionForAvalara | null>
```

The Phase-2 reader — the single entry point [[avalara-cart]] and [[avalara-subscription]] reach for when building a transaction body. Returns the LIVE certificate matching the ship-to region as `{ exemptionNo, entityUseCode, jurisdictionRegion }`, or `null` when no live matching certificate exists (which is what an unregistered buyer looks like: Avalara falls through to computing tax the normal way).

"Live" means: `revoked_at IS NULL` AND (`expires_at IS NULL` OR `expires_at > now()`). Region matching is exact on the uppercased two-letter code; a caller shipping to OK will not accidentally hit a TX certificate for the same customer. The partial-UNIQUE on `(customer_id, jurisdiction_region) WHERE revoked_at IS NULL` guarantees at most one live row per (customer, region).

### `listCustomerTaxExemptions` — function

```ts
async function listCustomerTaxExemptions(
  admin: Admin,
  workspaceId: string,
  customerId: string,
): Promise<CustomerTaxExemptionRow[]>
```

List every exemption on record for a customer, live and historical, most-recently-recorded first. The support UI and CFO audit path read this — it includes revoked / expired rows so a reviewer can retrace what was in effect when a given transaction was quoted.

### `recordCustomerTaxExemption` — function

```ts
async function recordCustomerTaxExemption(
  admin: Admin,
  input: {
    workspace_id: string;
    customer_id: string;
    exemption_no: string;
    entity_use_code: string;
    jurisdiction_region: string;
    expires_at?: string | null;
    notes?: string | null;
    recorded_by?: string | null;
  },
): Promise<CustomerTaxExemptionRow>
```

Phase 3 writer — records a new exemption certificate. Trims + validates the shape (exemption_no non-empty, entity_use_code non-empty, region matches `^[A-Z]{2}$`) and uppercases the region before inserting. Enforces the partial UNIQUE on `(customer_id, jurisdiction_region) WHERE revoked_at IS NULL` — attempting to record a second live certificate for the same region raises a typed rejection. Must be called with explicit human confirmation via the [[../orchestrator-tools]] `record_tax_exemption` action (founder-approval-only — the certificate is the evidence).

### `revokeCustomerTaxExemption` — function

```ts
async function revokeCustomerTaxExemption(
  admin: Admin,
  input: {
    workspace_id: string;
    id: string;
    revoked_by?: string | null;
    revoked_reason?: string | null;
  },
): Promise<CustomerTaxExemptionRow>
```

Revoke a live certificate via compare-and-set on `revoked_at IS NULL`. Stamps `revoked_at` + `revoked_by` + `revoked_reason`. A second call for the same row raises `already_revoked`. Used when superseding a certificate — call revoke first, then `recordCustomerTaxExemption` for the new live row.

### `CustomerTaxExemptionError` — class

Typed rejection raised by the writer/revoker for a shape or state violation (e.g., `exemption_no_missing`, `entity_use_code_missing`, `region_invalid`, `already_revoked`).

### `CustomerTaxExemptionRow` — interface

Row shape mirrors `public.customer_tax_exemptions`. See [[../tables/customer_tax_exemptions]].

### `CustomerTaxExemptionForAvalara` — interface

The projection Phase 2 threads into Avalara — just the two fields the wrapper's `CreateTransactionParams` extension carries (`exemptionNo` + `entityUseCode` + `jurisdictionRegion`). Avalara keys the exemption by the buyer's email (the `customerCode` already sent); the SDK does not re-transmit the customer's email here.

## Callers

- `src/lib/avalara-cart.ts` — checkout quote (Phase 2)
- `src/lib/avalara-subscription.ts` — subscription quote + renewal commit (Phase 2)
- `src/lib/action-executor.ts` — support-side `record_tax_exemption` action (Phase 3)

## Gotchas

- **Expired = non-live.** The reader's freshness check is in code (`expires_at !== null && expires_at.getTime() <= now`), not a fragile PostgREST `.or()` builder. An expired certificate is treated as absent and tax is charged normally from that instant.
- **Recording is never silent.** Phase 3 gates the write on the founder-approval pattern (same rail as money-moving actions) — an AI agent must never mark an account tax-exempt on a customer's say-so alone; the certificate is the evidence.
- **entity_use_code must be verified against Avalara.** The SDK trims + rejects empty, but Avalara's silent-degrade means an unrecognized code still returns 200 OK with full tax. Phase 3's founder-approval UX MUST verify the code against [[../integrations/avalara]]'s definitions endpoint before offering it as a choice.

---

[[../README]] · [[../../CLAUDE]]
