# customer_tax_exemptions

Per-customer sales-tax exemption records. One row per (customer, certificate). Phase 2 passes the LIVE row to [[../integrations/avalara]] as `exemptionNo` + `entityUseCode` on both `transactions/create` and `transactions/createoradjust`, so an exempt buyer is not charged tax at the source rather than refunded after the fact. See [[../specs/a-customer-can-be-recorded-as-sales-tax-exempt]].

Written exclusively through [[../libraries/customer-tax-exemptions]] (the SDK chokepoint at `src/lib/customer-tax-exemptions.ts`). A raw `.from('customer_tax_exemptions')` outside the SDK fails `npm run check:customer-tax-exemptions-sdk-compliance` (wired into `predeploy`).

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id · ON DELETE CASCADE |
| `customer_id` | `uuid` | — | → [[customers]].id · ON DELETE CASCADE — the buyer the certificate applies to |
| `exemption_no` | `text` | — | the certificate/permit reference the state issued (Avalara's `exemptionNo` request field). CHECK: non-empty after trim |
| `entity_use_code` | `text` | — | Avalara `entityUseCode` — the stable reason code for WHY the buyer is exempt (e.g. Oklahoma 100% disabled veteran, government purchase, reseller). MUST match Avalara's definitions endpoint or Avalara silently downgrades the transaction to fully-taxable with a 200 OK (the trap on [[../integrations/avalara]] § Silent-degrade). CHECK: non-empty after trim |
| `jurisdiction_region` | `text` | — | two-letter region (state / province) the certificate covers, e.g. `'OK'`. Uppercased at the SDK writer. CHECK: `~ '^[A-Z]{2}$'`. The Phase-2 resolver matches on this + the ship-to region so an OK certificate does not zero a TX shipment |
| `expires_at` | `timestamptz` | ✓ | optional expiry. `resolveCustomerTaxExemption` treats a row with `expires_at <= now()` as non-live, so tax is charged normally from that instant. NULL means "no expiry on file" |
| `notes` | `text` | ✓ | free-text prose the recorder captured alongside the certificate (DAV number, which state office issued the permit). Not agent-facing |
| `recorded_by` | `uuid` | ✓ | → [[workspace_members]].id — the member who recorded the certificate (Phase 3 stamps this from the founder-approving user's UUID). NULL only for an initial data-import row |
| `recorded_at` | `timestamptz` | — | default `now()` — server-set on insert |
| `revoked_at` | `timestamptz` | ✓ | NULL = live; non-NULL = revoked (a superseding certificate was recorded, or the certificate was voided). Retained for audit. Compare-and-set on NULL — a concurrent second revoke is a typed rejection, not a silent no-op |
| `revoked_by` | `uuid` | ✓ | → [[workspace_members]].id — the member who revoked the certificate |
| `revoked_reason` | `text` | ✓ | free-text prose the revoker captured (superseded by cert #X, state voided the permit) |
| `created_at` | `timestamptz` | — | default `now()` |

**Indexes:**
- `(workspace_id, customer_id, recorded_at DESC)` — the per-customer "live + history" read the SDK's `listCustomerTaxExemptions` uses.
- **partial UNIQUE** `(customer_id, jurisdiction_region) WHERE revoked_at IS NULL` — the **one-live-certificate-per-region** invariant. A superseding certificate for the same region MUST revoke the prior one first — same "confirming predicate at the action point" pattern the `ticket_directions` partial unique enforces (CLAUDE.md § Coaching learning #11).

**Constraints:**
- `customer_tax_exemptions_region_two_letter` — `jurisdiction_region ~ '^[A-Z]{2}$'`.
- `customer_tax_exemptions_exemption_no_nonempty` — `length(btrim(exemption_no)) > 0`.
- `customer_tax_exemptions_entity_use_code_nonempty` — `length(btrim(entity_use_code)) > 0`.

## Foreign keys

**Out:** `workspace_id` → [[workspaces]].id · `customer_id` → [[customers]].id · `recorded_by` → [[workspace_members]].id · `revoked_by` → [[workspace_members]].id.

**In:** none — the row is an authoring artifact the Avalara wrappers read (Phase 2), not a spine.

## Read paths

**Phase 2** — [[../libraries/customer-tax-exemptions]] `resolveCustomerTaxExemption(admin, workspaceId, customerId, shipToRegion)` returns the LIVE certificate matching the ship-to region as `{ exemptionNo, entityUseCode, jurisdictionRegion }`, or `null` when no live matching certificate exists (an unregistered buyer). Callers: `src/lib/avalara-cart.ts` (checkout) and `src/lib/avalara-subscription.ts` (`quoteSubscriptionTax`, `ensureFreshSubscriptionTaxQuote`, `commitSubscriptionRenewalTax`). The two fields land on [[../integrations/avalara]]'s request body in `transactions/create` + `transactions/createoradjust`.

**Support / CFO audit** — `listCustomerTaxExemptions(admin, workspaceId, customerId)` returns every row (live + revoked + expired), most-recently-recorded first, so a reviewer can retrace what was in effect when a given transaction was quoted.

## Row lifecycle

1. **Insert (`recorded_at`, `revoked_at IS NULL`)** — Phase 3's founder-approved action calls `recordCustomerTaxExemption` from a support session; the writer trims + validates + uppercases the region and enforces the shape constraints before the row lands. `recorded_by` stamps the approving user.
2. **Revoke (`revoked_at` compare-and-set on NULL)** — a superseding certificate calls `revokeCustomerTaxExemption` first, which stamps `revoked_at + revoked_by + revoked_reason` via a compare-and-set; a second call for the same row raises `already_revoked`. A fresh `recordCustomerTaxExemption` then inserts the new live row.
3. **Expiry** — no action is taken at expiry; the resolver simply stops returning the row (`expires_at <= now()` reads as non-live). The row stays in the audit trail.

## RLS

Service-role only (RLS enabled with no policies). Every read/write goes through `createAdminClient()` from the SDK — per CLAUDE.md's "All writes go through `createAdminClient()`" invariant.

## Invariants

- **One live certificate per (customer, region).** Enforced by the partial UNIQUE `(customer_id, jurisdiction_region) WHERE revoked_at IS NULL`. Superseding is `revokeCustomerTaxExemption` then `recordCustomerTaxExemption`, never an in-place UPDATE — the audit trail always shows the supersede.
- **Expired = non-live.** The resolver's freshness check is in code (`expires_at !== null && expires_at.getTime() <= now`), not a fragile PostgREST `.or('expires_at.is.null,expires_at.gt.now')`. An expired certificate is treated as absent and tax is charged normally from that instant.
- **Recording an exemption is never silent.** Phase 3 gates the write on the founder-approval pattern (same rail as money-moving actions) — an AI agent must never mark an account tax-exempt on a customer's say-so alone; the certificate is the evidence.
- **`entity_use_code` is verified against Avalara.** The SDK trims + rejects empty, but Avalara's silent-degrade means an unrecognized code still returns 200 OK with full tax. Phase 3's founder-approval UX MUST verify the code against Avalara's definitions endpoint before offering it as a choice.

## Migration

`supabase/migrations/20270101120000_customer_tax_exemptions.sql`. Idempotent — creates the table, both indexes (the per-customer read + the partial UNIQUE on `(customer_id, jurisdiction_region) WHERE revoked_at IS NULL`), the three CHECK constraints, and enables RLS with no policies. Column comments (`COMMENT ON COLUMN`) live in the migration for schema-level provenance.
