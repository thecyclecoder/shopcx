# inngest/migration-integrity-sweep

Daily back-audit: seeds a one-off [[../tables/migration_audits]] row for every internal sub that was **never audited** (migrated under the OLD logic, before the smart-pricing + monitor build) and runs the checklist — catching pre-existing problems the inline monitor never saw.

**File:** `src/lib/inngest/migration-integrity-sweep.ts`

## Functions

### `migration-integrity-sweep-cron`
- **Trigger:** cron `30 4 * * *` (daily at 04:30)
- **Retries:** 1
- **Concurrency:** `concurrency: [{ limit: 1 }]`

Selects `is_internal=true` subs (limit 1000) that have **no** prior `migration_audits` row, then `recordMigrationAudit` + `verifyMigration` each ([[../libraries/migration-audit]]). Back-audits pass `appstleContractId=""` / `preMigrationChargeCents=0`, so checks 4 (`appstle_cancelled`) and 6 (`pricing_preserved`) degrade gracefully — the structural checks (1–3, 8) still catch real problems (Shopify ids still on items, double-discount pricing, a never-cancelled Appstle contract). **Idempotent** — only seeds subs with no audit row, so it converges; thereafter the [[migration-audit-retry]] loop re-touches pending rows. Returns `{ seeded, passed, flagged }`. First run flagged 5 cancelled subs with Shopify-id items.

## Downstream events sent

_None._

## Tables written

- [[../tables/migration_audits]] (via `recordMigrationAudit` + `verifyMigration`)
- [[../tables/subscriptions]] (when `verifyMigration` self-heals item UUIDs)

## Tables read (not written)

- [[../tables/subscriptions]]
- [[../tables/migration_audits]]

## Header notes

```
Inngest cron: standalone migration integrity sweep.

verifyMigration runs at migration time, but subs migrated under the OLD logic
(before the smart-pricing + monitor build) never got an audit. This daily sweep
seeds a one-off audit for any internal sub that has NEVER been audited and runs
the checklist — surfacing pre-existing problems on the /dashboard/migrations
monitor. Idempotent: only seeds audits for subs with no prior audit row.
```

---

[[../README]] · [[../integrations/inngest]] · [[../libraries/migration-audit]] · [[migration-audit-retry]] · [[../dashboard/migrations]] · [[../../CLAUDE]]
