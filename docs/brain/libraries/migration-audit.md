# migration-audit.ts

`src/lib/migration-audit.ts` — the **migration verification monitor**. After an Appstle→internal migration, runs a per-sub checklist and records it in [[../tables/migration_audits]]. North star: after `status='passed'`, the sub is guaranteed to bill on its next renewal; a `failed` row is a renewal at risk.

Full flow: [[../lifecycles/subscription-billing]] § Migration path (verified + archived — see [[../archive]]).

## Exports

- **`recordMigrationAudit(input) → auditId`** — creates the `pending` row at migration time. `input`: `{ workspaceId, subscriptionId, appstleContractId (old, pre-flip), internalContractId, preMigrationChargeCents, isRecovery? }`.
- **`verifyMigration(auditId) → { status, checks }`** — runs the 8-check checklist, **self-heals** mechanically-fixable failures, then re-verifies; updates the row. `passed` when all checks ok; else `retry_count++` → `pending` until `MAX_RETRIES = 3`, then `failed`.

**Self-heal (`autoHealMigration`):** before flagging, fixable failures are auto-repaired — `items_on_uuids` (resolve each Shopify-id item → its catalog UUID + product_id) and `appstle_cancelled`/`no_double_bill` (cancel the lingering Appstle contract). Pricing mismatches are NOT auto-fixed (need judgment) and an item with no catalog match can't be resolved → those flag for human review on `/dashboard/migrations`. So only genuinely-stuck migrations surface.

**Failure event → migration-fix box agent ([[../specs/migration-fix-agent]]):** when `finalize()` flips a row to `failed` (the TRANSITION — prior status ≠ `failed`), it enqueues a `kind='migration-fix'` [[../tables/agent_jobs]] job `{audit_id, subscription_id}` via [[migration-fix]] `enqueueMigrationFixJob` (idempotent + best-effort — it must never break verification). **This is an event hook, not a cron** — the box agent attempts the *judgment* fixes auto-heal punts (pricing reconcile, variant backfill + remap, lingering Appstle cancel), gated behind owner approval, then re-runs `verifyMigration`. Unfixable one-off (no billable card) → stays `failed` with the box's written diagnosis. A **recurring code/data gap** → the box escalates to a permanent fix spec committed to `docs/brain/specs/` (surfaced on the Roadmap board), still leaving this row `failed`. The resume's re-verify won't re-enqueue (audit already `failed` → transition guard + active-job dedupe).

## The 8 checks

1. `is_internal` true · 2. `internal_contract_id` is `internal-*` (no Shopify contract id lingering) · 3. `items_on_uuids` (zero Shopify variant ids, excluding the shipping-protection line) · 4. `appstle_cancelled` — **re-fetches** the old Appstle contract and confirms `status === CANCELLED` (404 = gone = ok; `ACTIVE` = FAIL, double-bill risk) · 5. `cancel_reason` = "migrated to shopcx" (best-effort; passes if Appstle doesn't return the field) · 6. `pricing_preserved` — internal engine `product_subtotal_cents` ≈ `pre_migration_charge_cents` (±2¢/line) · 7. recovery only: `card_pinned` (`payment_method_id` set) + `immediate_charge` (last renewal txn `succeeded`) · 8. `no_double_bill` — NOT (internal live AND Appstle not cancelled).

**`card_pinned` is really a "billable card" check** (fixed 2026-06-10): it passes when the sub has a pinned `payment_method_id` **OR** the link group has an active default Braintree card — the exact fallback the renewal ([[../inngest/internal-subscription-renewals]]) and the sub-detail display use. A sub with no pinned card bills on the default, so it's still billable; the check only fails when there's **no card anywhere in the link group**. This is why a cancelled-but-reactivatable sub passes — if reactivated it charges the default. `immediate_charge` (recovery only) additionally requires the sub be live (a recovery that ended cancelled never charged).

`items_on_uuids` stays **strict** against `product_variants` — we never resolve variants from the `products.variants` JSONB; that table is the source of truth. If a variant is genuinely missing a row, **backfill the row**, don't loosen the check. (The two subs that flagged on 2026-06-10: Mary Carter's superseded 3-pack — no pinned card, now passes on her link-group default; and a Dylan test sub whose ACV-Gummies item pointed at a **stale Shopify variant id** that had been re-created — remapped to the live variant row. The variant table itself was already complete: 22/22 rows.)

## Flow

- [[migrate-to-internal]] calls `recordMigrationAudit` (capturing the live Appstle pre-migration charge) then `verifyMigration` inline after each flip; `isRecovery` threads from the payment-recovery flow.
- The [[../inngest/migration-audit-retry]] cron (every 10 min) re-verifies `pending` rows so transient failures (Appstle cancel propagation, a settling recovery charge) self-heal before flagging `failed`.
- The [[../inngest/migration-integrity-sweep]] cron (daily) back-audits internal subs that were never audited (old-logic migrations).
- On a `failed` transition, `finalize()` hands the audit to the [[../specs/migration-fix-agent|migration-fix box agent]] via [[migration-fix]] `enqueueMigrationFixJob` (event, not a cron).
- `/api/migrations` → [[../dashboard/migrations]] (owner-only) surfaces failed/pending with their failing checks + the migration-fix agent's diagnosis/proposed fix.

---

[[../README]] · [[../tables/migration_audits]] · [[migrate-to-internal]] · [[appstle-pricing]] · [[migration-fix]] · [[../specs/migration-fix-agent]] · [[../inngest/migration-audit-retry]] · [[../inngest/migration-integrity-sweep]] · [[../dashboard/migrations]]
