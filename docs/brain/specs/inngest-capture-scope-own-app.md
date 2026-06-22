# Scope the Inngest failure-capture to our own app (filter foreign-app noise) ✅

**Owner:** [[../functions/platform]] · **Parent:** extends [[error-feed-monitoring]] + [[control-tower]].

The Inngest error feed surfaced `shopgrowth-amazon-sync-orders: Invalid prisma.aiJob.update() invocation` — but **that function isn't in this repo** (no `shopgrowth-amazon-sync-orders`, no Prisma, no `aiJob` anywhere in `src/`). It's a **sibling app on the same Inngest account** bleeding into our feed: the `inngest-failure-capture` fn ([[../inngest/inngest-failure-capture]]) triggers on the account-wide `inngest/function.failed` event, which fires for **every app's** failures, not just ours. So our Control Tower shows another project's errors — false signal that erodes trust in the panel ("is this ours?").

## Fix
- **Filter to our app's functions.** In `inngest-failure-capture`, only record a failure whose `function_id` belongs to **this app** — match against our served-function ids (reuse `src/lib/inngest/registered-functions.ts` from [[control-tower-complete-coverage]]) or our Inngest `appId`/function-id prefix. A `function.failed` for a function we don't serve → **ignore** (don't `recordError`).
- Keep it fail-open on *our* side: an unknown-but-plausibly-ours id still records (better a rare foreign row than dropping a real one) — but a clearly-foreign app (`shopgrowth-*`, Prisma-based) is excluded.

## Verification
- In `src/lib/inngest/inngest-failure-capture.ts`, the handler now calls `isOurFunction(function_id)` before `recordError` and returns `{ skipped: "foreign-app", function_id }` for anything outside our app.
- On the Control Tower Inngest panel (`/dashboard/control-tower`), watch the existing `shopgrowth-amazon-sync-orders: Invalid prisma.aiJob.update()` incident → expect **no new occurrences** (its `count`/`last_seen_at` stop bumping); it can now be resolved without re-firing.
- Force/observe a failure in one of *our* served functions (e.g. a real `amazon-sync-orders` retry-exhaustion, reported as `shopcx-amazon-sync-orders`) → expect a fresh `error_events` row with `source='inngest'`, same as before (scoping does **not** drop our own failures).
- In a node/tsx check importing `servedFunctionIds` from `registered-functions.ts`: `servedFunctionIds.has("shopcx-amazon-sync-orders")` → `true`; `isOurFunction("shopgrowth-amazon-sync-orders")` → `false`; `isOurFunction("shopcx-some-future-fn")` → `true` (fail-open on our prefix).

## Phase 1 — function-id scoping in the failure capture ✅
`inngest-failure-capture` checks `function_id` against our served-function set + app-id prefix (fail-open) before `recordError`; foreign-app failures return `{ skipped: "foreign-app" }`, never recorded. Served-id sets (`servedFunctionIds`, `servedFunctionBareIds`, `APP_FUNCTION_ID_PREFIX`) exported from `registered-functions.ts`. Brain: [[../inngest/inngest-failure-capture]] · [[error-feed-monitoring]].
