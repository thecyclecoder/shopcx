# migration-fix.ts

`src/lib/migration-fix.ts` — the **queue plumbing + deterministic executor** behind the **migration-fix box agent** ([[../specs/migration-fix-agent]]). North star (supervisable autonomy): a `failed` [[../tables/migration_audits]] row is a renewal at risk; the box session DIAGNOSES read-only and PROPOSES a typed fix; the **worker** (the only component that mutates) executes the approved plan HERE — never freestyle DB writes, never a silent re-bill — then re-runs `verifyMigration`. Only a re-`passed` audit clears.

## Exports

- **`enqueueMigrationFixJob(admin, { auditId, subscriptionId, workspaceId }) → { enqueued, reason? }`** — insert a `kind='migration-fix'` [[../tables/agent_jobs]] row (`spec_slug = auditId`, `instructions = {audit_id, subscription_id}`). **Idempotent + best-effort:** no-op if an active migration-fix job already exists for the audit. Called inline by [[migration-audit]] `verifyMigration`→`finalize()` on the TRANSITION to `failed` (**event-driven — there is no migration-fix cron**).
- **`applyMigrationFix(admin, audit, action) → { ok, detail }`** — run ONE owner-approved typed fix against prod. Idempotent where possible. The worker (`runMigrationFixJob`) calls it per `approved` action, then re-runs `verifyMigration(auditId)`.
- Types: `MigrationFixKind = 'price_reconcile' | 'variant_backfill' | 'appstle_cancel'`; `PriceReconcilePayload` · `VariantBackfillPayload` · `AppstleCancelPayload`.

## The three fixes (the judgment auto-heal punts)

| `fix_kind` | Payload | What `applyMigrationFix` does |
|---|---|---|
| `price_reconcile` | `{ overrides: [{ variant_id (catalog UUID), price_override_cents }] }` | Sets `subscriptions.items[].price_override_cents` for each matched grandfathered line so the engine subtotal ≈ `pre_migration_charge_cents`. Validates each override is a positive int ≤ `MAX_OVERRIDE_CENTS` ($1000) — fail-closed on an absurd value (the real gate is the post-fix re-verify). |
| `variant_backfill` | `{ variant: { product_id, shopify_variant_id, title?, sku?, price_cents?, option1-3? }, item_match: { shopify_variant_id?, sku? } }` | Inserts the missing [[../tables/product_variants]] row (idempotent — reuses an existing row for that Shopify id), then remaps the matched sub item onto the new UUID + `product_id`. **Never loosens the `items_on_uuids` check** — backfills the row. The fix the 2026-06-10 incident did by hand. |
| `appstle_cancel` | `{ appstle_contract_id?, reason? }` | `appstleSubscriptionAction(workspaceId, <old contract id>, 'cancel', reason, 'ShopCX migration-fix')` — cancels the lingering Appstle contract (double-bill risk). |

`card_pinned` / no billable card has **no fix** — it's **out-of-system** (the customer must act), so the box surfaces terminal `human_needed` with a **one-line plain instruction** (never invents a card).

## Human-judgment pause + inline answer ([[../specs/migration-fix-human-input]])

When a failing check needs an owner **decision** (not an out-of-system block) — e.g. an ambiguous grandfathered price — the box doesn't dump check-jargon. It pauses the job on **`needs_input`** with **one plain-language question** parked in [[../tables/agent_jobs]]`.questions [{id,q}]`. The owner answers inline on [[../dashboard/migrations]] (`POST /api/roadmap/answer` → `queued_resume`). `runMigrationFixJob` then takes the **answer-resume** path (`answers` present, no approved/declined action): it re-runs the `migration-fix` skill **resuming the same Max session** with the owner's answer baked in, so the box proposes the concrete gated fix (the normal `propose` → `needs_approval` → **Approve & fix** flow). The deterministic executor here (`applyMigrationFix`) is unchanged — the human-input handshake is all in the worker + the skill.

## Callers

- [[migration-audit]] `verifyMigration` → `enqueueMigrationFixJob` (failure event).
- `scripts/builder-worker.ts` `runMigrationFixJob` → `applyMigrationFix` (on approval) + re-verify.
- `/api/migrations` joins the migration-fix [[../tables/agent_jobs]] row to surface the diagnosis + proposed fix on [[../dashboard/migrations]].

## Gotchas

- **Worker mutates, not the box.** The box session keeps prod secrets to *read* but emits only a proposal; `applyMigrationFix` runs in the worker on the owner's approval (the [[../specs/build-approval-gates|approval-gate]] pattern via [[../tables/agent_jobs]]`.pending_actions`).
- **Re-verify-gated.** A fix "counts" only when `verifyMigration` re-passes; `applyMigrationFix` never touches `migration_audits.status` directly.
- **No re-enqueue loop.** The failure hook fires only on the `failed` transition (prior status ≠ failed) and `enqueueMigrationFixJob` dedupes against an active job — so the resume's re-verify (audit already `failed`) never spawns a second job.

---

[[../README]] · [[../specs/migration-fix-agent]] · [[migration-audit]] · [[../tables/agent_jobs]] · [[../tables/migration_audits]] · [[../tables/product_variants]] · [[appstle]] · [[../dashboard/migrations]] · [[../recipes/build-box-setup]]
