# inngest/migration-audit-retry

Re-verifies `pending` [[../tables/migration_audits]] rows so transient migration-check failures self-heal before they're flagged. North star: a migration only reaches `failed` after it genuinely can't pass — not because an Appstle cancel hadn't propagated or a recovery charge was still settling.

**File:** `src/lib/inngest/migration-audit-retry.ts`

## Functions

### `migration-audit-retry-cron`
- **Trigger:** cron `*/10 * * * *` (every 10 min — recovery charges settle fast, no backoff)
- **Retries:** 1
- **Concurrency:** `concurrency: [{ limit: 1 }]`

Finds up to 100 `status='pending'` audits (oldest first) and calls `verifyMigration` ([[../libraries/migration-audit]]) on each. `verifyMigration` self-heals mechanically-fixable failures, re-checks, and increments `retry_count`; once `retry_count` hits `MAX_RETRIES = 3` a still-failing audit flips to `failed` for the `/dashboard/migrations` monitor ([[../dashboard/migrations]]) to surface. Returns `{ rechecked, passed, stillPending, failed }`.

## Downstream events sent

_None._

## Tables written

- [[../tables/migration_audits]] (via `verifyMigration`)
- [[../tables/subscriptions]] (when `verifyMigration` self-heals item UUIDs)

## Tables read (not written)

- [[../tables/migration_audits]]

## Header notes

```
Inngest cron: re-verify pending migration audits.

verifyMigration runs inline at migration time. If a check fails (e.g. an Appstle
cancel hadn't propagated yet, or an immediate recovery charge is still settling),
the audit stays `pending`. This loop re-runs verification on pending rows; once
retry_count hits MAX_RETRIES, verifyMigration flips them to `failed` for the
monitor to surface.
```

---

[[../README]] · [[../integrations/inngest]] · [[../libraries/migration-audit]] · [[migration-integrity-sweep]] · [[../lifecycles/subscription-billing]] · [[../../CLAUDE]]
