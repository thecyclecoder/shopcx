# migration_audits

One row per **Appstle→internal migration**. Records the verification checklist + status so the monitor surfaces stuck migrations and a retry loop re-verifies before flagging. **North star:** after `status='passed'`, the sub is guaranteed to bill on its next renewal; a `failed` row is a renewal at risk.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id · ON DELETE CASCADE |
| `subscription_id` | `uuid` | — | → [[subscriptions]].id · ON DELETE CASCADE |
| `appstle_contract_id` | `text` | ✓ | the **old** numeric Appstle contract id (pre-flip) — re-fetched to confirm cancellation |
| `internal_contract_id` | `text` | ✓ | the new `internal-*` contract id after the flip |
| `pre_migration_charge_cents` | `int4` | ✓ | sum of the live Appstle per-line charge (currentPrice × qty) at migration time — check 6 compares this to the internal engine's charge |
| `is_recovery` | `bool` | — | default `false` — set when migration ran via the payment-recovery flow (adds the card-pinned + immediate-charge checks) |
| `status` | `text` | — | default `'pending'` — `pending` \| `passed` \| `failed` |
| `checks` | `jsonb` | — | default `'[]'` — `[{ key, ok, detail }]` |
| `retry_count` | `int4` | — | default `0` — incremented each re-verify; at `MAX_RETRIES=3` a still-failing audit flips to `failed` |
| `last_error` | `text` | ✓ | concatenated failing-check details |
| `created_at` / `updated_at` | `timestamptz` | — | default `now()` |

## The checklist (8 checks)

Run by `verifyMigration` in [[../libraries/migration-audit]]:
1. `is_internal` true · 2. `internal_contract_id` is `internal-*` · 3. `items_on_uuids` (no Shopify variant ids) · 4. `appstle_cancelled` (re-fetch the old contract, confirm `CANCELLED`) · 5. `cancel_reason` = "migrated to shopcx" (best-effort) · 6. `pricing_preserved` (engine charge ≈ `pre_migration_charge_cents`, ±2¢/line) · 7. recovery: `card_pinned` + `immediate_charge` succeeded · 8. `no_double_bill` (internal live AND Appstle cancelled).

## Lifecycle

- **Written** by [[migrate-to-internal]] — `recordMigrationAudit` (pending) then `verifyMigration` inline after each flip.
- **Re-verified** by the [[../inngest/migration-audit-retry]] cron (every 10 min) — pending rows only; flips to `passed`/`failed`.
- **Back-filled** by the [[../inngest/migration-integrity-sweep]] cron (daily) — seeds a one-off audit for any internal sub never audited.
- **Read** by `/api/migrations` → the [[../dashboard/migrations]] monitor (owner-only).

## Common queries

```ts
// At-risk migrations (renewals at risk) for a workspace
const { data } = await admin.from("migration_audits")
  .select("*").eq("workspace_id", workspaceId)
  .in("status", ["failed", "pending"]).order("created_at", { ascending: false });
```

## Gotchas

- A `passed` row is a point-in-time assertion; the renewal still does its own authoritative charge.
- Check 5 (`cancel_reason`) is best-effort — Appstle doesn't reliably return the cancellation feedback on the contract fetch, so it passes when the field is absent rather than false-failing the whole audit.

---

[[../README]] · [[../lifecycles/subscription-billing]] · [[../libraries/migration-audit]] · [[../dashboard/migrations]] · [[../archive]] · [[../../CLAUDE]]
