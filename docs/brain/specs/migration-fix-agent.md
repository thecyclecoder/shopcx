# Migration-Fix Agent (box session on migration failure) ⏳

**Owner:** [[../functions/retention]] · **Parent:** Retention mandate "Subscription continuity & billing integrity" ([[../lifecycles/subscription-billing.md]] § Migration path). Box-agent family with [[box-escalation-triage]] · [[box-ticket-improve]].

A box agent that **fixes internal subs stuck in migration** — the Appstle→internal migrations that `verifyMigration`'s mechanical auto-heal **couldn't** repair and that land on `/dashboard/migrations` as `failed`. It fires **on the failure event, not a cron**: the moment a `migration_audits` row goes `failed`, it spins up a `claude -p` Max session to diagnose the failing checks + attempt the *judgment* fixes the auto-heal punts, then re-verifies. A `failed` migration = a renewal at risk, so the faster it's worked, the fewer bad/missed bills.

**Outcome:** a migration that flags `failed` (e.g. a `pricing_preserved` mismatch or an unresolved variant) is, within minutes, either **auto-repaired + re-verified to `passed`** (dashboard goes green) or surfaced with a concrete diagnosis (and, where it's a code gap, a proposed fix spec) — instead of sitting on the migrations board waiting for a human to reverse-engineer it.

## Trigger — on failure, not a cron
- Hook **`verifyMigration`** (`src/lib/migration-audit.ts`): when a row transitions to **`failed`** (auto-heal + `MAX_RETRIES` exhausted), enqueue a `migration-fix` job for that audit/sub. **Event-driven** — there is no migration-fix cron (the existing `migration-audit-retry` 10-min cron handles transient `pending` re-verification; the box agent only engages once a migration is genuinely `failed`).
- (Backstop, not a schedule: the daily `migration-integrity-sweep` that back-audits old subs can mark a sub `failed`, which is the *same* event hook — so back-audited failures route to the agent too.)

## Mechanism
- **New `agent_jobs.kind='migration-fix'`** in a concurrency-1 lane (`claim_agent_job(['migration-fix'])`), `runMigrationFixJob` in `scripts/builder-worker.ts`. `spec_slug` = the `migration_audits.id`; `instructions` = `{audit_id, subscription_id}`.
- **🚨 Max only** — top-level `claude -p` (`env -u ANTHROPIC_API_KEY`, web search on, keeps DB/Appstle/crypto secrets for read + the gated executor) running a **`migration-fix` skill**. It loads the failed audit + its **failing checks**, the sub, the **live Appstle contract** (re-fetch), and the catalog, and works each failing check:
  - **`pricing_preserved` mismatch** → recompute the true grandfathered base (`inferAppstleLineBase` logic) and reconcile the item `price_override_cents` so the internal engine subtotal ≈ pre-migration charge (the judgment fix auto-heal refuses).
  - **`items_on_uuids` unresolved variant** → the item points at a Shopify variant with **no `product_variants` row** → **backfill the catalog row** (never loosen the check) + remap the item to the UUID. (The fix the 2026-06-10 incident did by hand.)
  - **`appstle_cancelled` / `no_double_bill`** → force-cancel the lingering Appstle contract (double-bill risk).
  - **`card_pinned` / no billable card** → cannot be invented → surface as **human-needed** (the customer must add a card; or it's a comp sub → see [[comp-subscriptions]]).
- After fixing, **re-run `verifyMigration(audit_id)`**: `passed` → the audit clears and the dashboard goes green; still failing → surface.

## Guardrails (supervisable autonomy)
- **Billing blast radius is real** — these mutate live subscriptions. The box **proposes** the fix plan; prod mutations (price reconcile, variant backfill, Appstle cancel) execute **server-side on approval** (the [[build-approval-gates]] pattern), never by the secret-stripped box session silently. **Never re-bill blindly.**
- **Fail-closed to a human.** What the agent can't safely fix (no card anywhere, an ambiguous pricing history, a genuine code gap) stays `failed` on `/dashboard/migrations` **with the box's written diagnosis** — and (stretch) a proposed code-fix spec via the [[box-spec-chat]] finalize path (e.g. "variant table missing row X", "pricing inference gap for case Y"), like [[box-escalation-triage]] routes analyzer fixes.
- **Idempotent + re-verify-gated:** a fix only "counts" when `verifyMigration` re-passes; the agent never marks an audit passed itself.

## Verification
- Force a `migration_audits` row to `failed` with a `pricing_preserved` mismatch → within a poll cycle a `migration-fix` job runs; the box proposes a `price_override_cents` reconcile; on approval it applies + `verifyMigration` re-passes → the row clears from `/dashboard/migrations`. API console flat (Max).
- An unresolved-variant failure → the box proposes a `product_variants` backfill + item remap; approve → re-verify passes.
- A no-billable-card failure → the agent does NOT fabricate a card; it surfaces human-needed with a diagnosis (no silent fix, no re-bill).
- No cron: the agent fires only off the `failed` transition, never on a timer.

## Phase 1 — failure hook + box fix + re-verify ⏳
`migration-fix` kind + lane + `runMigrationFixJob`; the `verifyMigration`→`failed` enqueue hook; the `migration-fix` skill (diagnose failing checks → propose the judgment fixes → gated execute → re-verify); surface unfixable with diagnosis on `/dashboard/migrations`. Brain: [[../tables/agent_jobs]] (new kind/lane) · [[../libraries/migration-audit]] (failure → agent) · [[../dashboard/migrations]] (box diagnosis surfaced) · [[../recipes/build-box-setup]] (lane) · the `migration-fix` skill page.

## Phase 2 — code-gap escalation ⏳
For failures rooted in a code/data gap (missing catalog rows class, pricing-inference edge case), propose a fix spec ([[box-spec-chat]]) / route like [[box-escalation-triage]], so recurring migration failures become permanent fixes.
