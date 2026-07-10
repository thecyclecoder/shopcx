# Recipes

How-to pages for common operational tasks. Each page is structured the same way:

- **Helper to call** + file path
- **Params** with types
- **Minimal example** of the call
- **Gotchas** discovered from reading the code

These supplement the [[../libraries]] reference. Libraries describe what a file exposes; recipes describe how to do a thing.

## Subscriptions

- [[change-line-item-price]] — `subUpdateLineItemPrice` (note the 0.75 SubSave multiplier)
- [[swap-variant]] — `subSwapVariant`
- [[change-quantity]] — `subChangeQuantity`
- [[pause-sub]] — `appstleSubscriptionAction("pause")`
- [[resume-sub]] — `appstleSubscriptionAction("resume")`
- [[cancel-sub-via-journey]] — `launchJourneyForTicket("cancel_subscription")`
- [[bill-now]] — `appstleAttemptBilling` or internal-sub equivalent
- [[change-next-date]] — `appstleUpdateNextBillingDate`
- [[apply-coupon]] — `applyDiscountWithReplace`
- [[apply-loyalty-coupon]] — loyalty redeem → coupon → apply-to-sub flow

## Orders + returns

- [[issue-replacement]] — `createReplacementOrder`
- [[create-return]] — `createFullReturn`
- [[issue-refund]] — `partialRefundByAmount`
- [[partial-refund]] — same as issue-refund but customer-initiated path

## Loyalty

- [[redeem-loyalty]] — generate Shopify discount code via `spendPoints` + `loyalty-redeem` handler
- [[apply-loyalty-coupon]] — apply loyalty coupon to a subscription

## Tickets + comms

- [[escalate-ticket]] — `handleEscalation`
- [[send-email-reply]] — `sendTicketReply`
- [[send-chat-reply]] — insert outbound `ticket_messages` row with `pending_send_at`

## Social

- [[ban-meta-user]] — `banUser`
- [[hide-comment]] — `applyModerationDecision({decision:'hide'})`
- [[link-meta-sender-to-customer]] — upsert `meta_sender_customer_links`

## Growth / DR content

- [[dr-content]] — Carrie's DR-content lane: reuse existing [[../tables/product_media]] before opening a real-evidence [[../tables/lander_content_gaps]] row ([[../libraries/lander-blueprints]] `findExistingRealAsset`, category+slot/alt match, source<>generated compliance rail)

## Infra

- [[fire-an-inngest-event]] — `inngest.send({name, data})`
- [[write-a-migration-apply-script]] — `scripts/apply-*.ts` pattern using `pg` client
- [[pitr-disaster-recovery]] — the under-fire runbook when a migration/agent destroyed live data: scoped loss → restore-to-a-new-project + extract + re-import (zero prod downtime); total → in-place PITR restore. The reversibility backstop for [[../specs/destructive-migration-safety-rails]]
- [[raise-work-mem]] — owner-approval-only raise of `work_mem` on the `authenticated` role (the DB Health Agent's `raise_work_mem` fix for the `dbhealth:instance:temp_spill_pressure` signature — sizing math + rollback + verification)
- [[db-vacuum-tune-customers]] — owner-approval-only per-table autovacuum tune + one-off `VACUUM (ANALYZE)` on `public.customers` (the DB Health Agent's `vacuum_tuning` fix for the `dbhealth:bloat:customers` signature — no data is deleted; reloption math + rollback + verification)
- [[db-vacuum-tune-orders]] — owner-approval-only per-table autovacuum tune + one-off `VACUUM (ANALYZE)` on `public.orders` (the DB Health Agent's `vacuum_tuning` fix for the `dbhealth:bloat:orders` signature — no data is deleted; reloption math + rollback + verification)
- [[dev-message-center-db]] — read-only prod-DB queries from the Developer Message Center (throwaway `scripts/_*.ts`, SELECT-only, never committed)
- [[what-makes-a-buildable-spec]] — the single definition of a sound, buildable spec (owner/parent/intent/verification/grounding). Authors write to it; Vale's [[../../.claude/skills/spec-review|spec-review]] gates on it — one referenced artifact so author + reviewer can't drift. The [[../../.claude/skills/submit-spec|submit-spec]] skill points here.
- [[pm-flow-data-sources]] — the PM flow's post-purge call graph (DB row → typed reader → consumer) + every surviving consumer of `serializeSpecRowToMarkdown` ([[../specs/retire-md-reads-from-pm-flow]])
- [[pipeline-doctor]] — `diagnosePipeline` / `scripts/pipeline-status.ts`: an INSTANT read-only diagnosis of the whole spec pipeline (derived status + jobs/gates + what's stuck and WHY, via named anomaly detectors). Composes the canonical readers — never re-derives status with raw SQL.
- [[next16-authinterrupts-forbidden-flag]] — why blueprint PDP landers 500 on non-owner requests instead of returning a 403 (missing `experimental.authInterrupts` flag when calling `forbidden()` from `next/navigation`), and the `scripts/_check-authinterrupts-when-forbidden-imported.ts` predeploy guard that couples the flag to imports
- [[next16-metadata-boundary-csr-bail]] — why /store, /widget, /portal, /help bail to CSR under cacheComponents (Next's `botType && isRoutePPREnabled` metadata short-circuit) + the `src/proxy.ts` bot-UA-neutralization fix
- [[next16-empty-generate-static-params-preview-build]] — why spec-build PREVIEW deploys fail with `EmptyGenerateStaticParamsError` while prod builds clean (empty build-time DB query + cacheComponents PPR), and the `__placeholder__`-sentinel fix in the storefront `generateStaticParams` helpers (NOT an env-var issue — preview & prod share the same DB)
- [[founder-pulse-capture]] — the local-Mac session capture wiring (launchd timer + SessionEnd hook) that feeds the `founder-pulse` Pulse: the digest chain, the `scripts/pulse-digest.ts` path contract the build must honor, and how to disable/uninstall on the local machine

## Build & ops skills (committed Claude Code skills)

The recipes above document **runtime orchestrator actions** — what the AI does live during customer service (pause/refund/return/coupon/loyalty…), exposed as `directActionHandlers` in [[../libraries/action-executor]]. **Don't conflate** those with **Claude Code skills**: the reusable *build/ops* procedures a Claude agent draws on — the box's headless top-level `claude -p` builds ([[build-box-setup]]) **or** an interactive session. Skills live in `.claude/skills/{name}/SKILL.md` (committed, or the harness can't see them) and each carries a `## Related` cross-link to the source recipe(s)/script genre that proves the pattern is real. Many of the recipes above are the source pattern behind a skill.

**Shared foundation:** all ~230 `scripts/*.ts` run via `npx tsx`, load `.env.local`, and use `createAdminClient()`. The committed `script-conventions` skill documents this, backed by `scripts/_bootstrap.ts` (`loadEnv()` / `createAdminClient()` / `pgClient()` / `poolerConnectionString()` — replacing ~150 hand-copied env-loader blocks; the `.env.local` read is `existsSync`-guarded so it's a no-op on the box, where secrets come from the `EnvironmentFile`).

The committed catalog, by tier:

- **P0 (the unblockers):** `build-spec` (read `specs/{slug}.md` → implement → `tsc` gate → `claude/*` PR — the procedure the box worker's `runBuild` invokes directly, [[../lifecycles/roadmap-build-console]]), `probe-db` (read-only "database is the spec" inspection), `write-migration` ([[write-a-migration-apply-script]]), `customer-remedy` (UUID-keyed, dry-run-first one-customer fix through `directActionHandlers`).
- **P1:** `fold-to-brain` (shipped spec → fold + `git rm`, [[../project-management]]), `write-brain-page`, `backfill` (26 `backfill-*` scripts), `audit-reconcile` (9 `audit-*`/`reconcile-*`), `deploy` ([[../operational-rules]]).
- **P2:** `regenerate-brain` (the `_gen-brain-*.ts` generators), `verify-schema`, `edit-shopify-theme` ([[edit-shopify-theme]]), `build-portals`, `run-orchestrator-action` (`apply-coupon-via-executor.ts`), `fire-inngest-event` ([[fire-an-inngest-event]]).
- **P3:** `render-static` ([[../lifecycles/ad-static]]), `generate-ad` ([[generate-ad]]). _(Later additions `plan-goal` follow the same shape.)_

**Invariants:** `build-spec` uses native tools only — never spawns a *nested* `claude` (recursion / the `CLAUDECODE=1` guard); on the box it *is* the top-level `claude -p`, Max-billed (no `ANTHROPIC_API_KEY` in the build env). `probe-db` is read-only, always. `write-migration`/`backfill`/`customer-remedy` are idempotent + dry-run-first. Internal joins use UUIDs, never `shopify_*_id`. All DB writes go through `createAdminClient()`.

## Related

[[../README]] · [[../libraries]] · [[../lifecycles/return-pipeline]] · [[../lifecycles/cancel-flow]] · [[../lifecycles/dunning]]
