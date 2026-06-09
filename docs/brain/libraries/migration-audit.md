# migration-audit.ts

`src/lib/migration-audit.ts` — the **migration verification monitor**. After an Appstle→internal migration, runs a per-sub checklist and records it in [[../tables/migration_audits]]. North star: after `status='passed'`, the sub is guaranteed to bill on its next renewal; a `failed` row is a renewal at risk.

See [[../specs/appstle-pricing-heal-and-migration-monitor]] § Phase 3.

## Exports

- **`recordMigrationAudit(input) → auditId`** — creates the `pending` row at migration time. `input`: `{ workspaceId, subscriptionId, appstleContractId (old, pre-flip), internalContractId, preMigrationChargeCents, isRecovery? }`.
- **`verifyMigration(auditId) → { status, checks }`** — runs the 8-check checklist, **self-heals** mechanically-fixable failures, then re-verifies; updates the row. `passed` when all checks ok; else `retry_count++` → `pending` until `MAX_RETRIES = 3`, then `failed`.

**Self-heal (`autoHealMigration`):** before flagging, fixable failures are auto-repaired — `items_on_uuids` (resolve each Shopify-id item → its catalog UUID + product_id) and `appstle_cancelled`/`no_double_bill` (cancel the lingering Appstle contract). Pricing mismatches are NOT auto-fixed (need judgment) and an item with no catalog match can't be resolved → those flag for human review on `/dashboard/migrations`. So only genuinely-stuck migrations surface.

## The 8 checks

1. `is_internal` true · 2. `internal_contract_id` is `internal-*` (no Shopify contract id lingering) · 3. `items_on_uuids` (zero Shopify variant ids, excluding the shipping-protection line) · 4. `appstle_cancelled` — **re-fetches** the old Appstle contract and confirms `status === CANCELLED` (404 = gone = ok; `ACTIVE` = FAIL, double-bill risk) · 5. `cancel_reason` = "migrated to shopcx" (best-effort; passes if Appstle doesn't return the field) · 6. `pricing_preserved` — internal engine `product_subtotal_cents` ≈ `pre_migration_charge_cents` (±2¢/line) · 7. recovery only: `card_pinned` (`payment_method_id` set) + `immediate_charge` (last renewal txn `succeeded`) · 8. `no_double_bill` — NOT (internal live AND Appstle not cancelled).

## Flow

- [[migrate-to-internal]] calls `recordMigrationAudit` (capturing the live Appstle pre-migration charge) then `verifyMigration` inline after each flip; `isRecovery` threads from the payment-recovery flow.
- The `migration-audit-retry` Inngest cron (every 10 min) re-verifies `pending` rows so transient failures (Appstle cancel propagation, a settling recovery charge) self-heal before flagging `failed`.
- `/api/migrations` → `/dashboard/migrations` (owner-only) surfaces failed/pending with their failing checks.

---

[[../README]] · [[../tables/migration_audits]] · [[migrate-to-internal]] · [[appstle-pricing]]
