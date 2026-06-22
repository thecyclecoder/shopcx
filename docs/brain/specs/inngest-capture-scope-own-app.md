# Scope the Inngest failure-capture to our own app (filter foreign-app noise) ⏳

**Owner:** [[../functions/platform]] · **Parent:** extends [[error-feed-monitoring]] + [[control-tower]].

The Inngest error feed surfaced `shopgrowth-amazon-sync-orders: Invalid prisma.aiJob.update() invocation` — but **that function isn't in this repo** (no `shopgrowth-amazon-sync-orders`, no Prisma, no `aiJob` anywhere in `src/`). It's a **sibling app on the same Inngest account** bleeding into our feed: the `inngest-failure-capture` fn ([[../inngest/inngest-failure-capture]]) triggers on the account-wide `inngest/function.failed` event, which fires for **every app's** failures, not just ours. So our Control Tower shows another project's errors — false signal that erodes trust in the panel ("is this ours?").

## Fix
- **Filter to our app's functions.** In `inngest-failure-capture`, only record a failure whose `function_id` belongs to **this app** — match against our served-function ids (reuse `src/lib/inngest/registered-functions.ts` from [[control-tower-complete-coverage]]) or our Inngest `appId`/function-id prefix. A `function.failed` for a function we don't serve → **ignore** (don't `recordError`).
- Keep it fail-open on *our* side: an unknown-but-plausibly-ours id still records (better a rare foreign row than dropping a real one) — but a clearly-foreign app (`shopgrowth-*`, Prisma-based) is excluded.

## Verification
- A failure in one of *our* served functions → still captured in the Inngest panel (unchanged).
- A `shopgrowth-*` / non-served function failure → **not** recorded; the existing `shopgrowth-amazon-sync-orders` incident stops recurring + can be resolved.
- The Inngest panel only ever shows functions that exist in `registered-functions.ts`.

## Phase 1 — function-id scoping in the failure capture ⏳
`inngest-failure-capture` checks `function_id` against our served-function set before `recordError`; foreign-app failures are ignored. Brain: [[../inngest/inngest-failure-capture]] · [[../inngest/registered-functions]] · [[error-feed-monitoring]].
