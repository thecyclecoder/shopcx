# libraries/playbook-executor

Step engine for [[../playbooks]]. Routes inbound messages through playbook steps when `active_playbook_id` is set on the ticket.

**File:** `src/lib/playbook-executor.ts`

## File header

```
Playbook Executor — runs playbook steps against live customer data.
Called from the unified ticket handler when a playbook is active or matched.
Each step fetches live data, evaluates conditions, generates AI response,
and advances (or waits for customer reply).
```

## Exports

### `executePlaybookStep` — function

```ts
async function executePlaybookStep(workspaceId: string, ticketId: string, customerMessage: string, personality: { name?: string; tone?: string; sign_off?: string | null } | null,) : Promise<PlaybookExecResult>
```

### `matchPlaybook` — function

```ts
async function matchPlaybook(admin: Admin, wsId: string, intent: string, msg: string,) : Promise<
```

### `startPlaybook` — function

```ts
async function startPlaybook(
  admin: Admin, ticketId: string, playbookId: string,
  opts?: { seed_context?: Record<string, unknown> },
) : Promise<void>
```

Stamps the ticket onto a playbook: `active_playbook_id = playbookId`, `playbook_step = 0`, `playbook_context = seed_context ?? {}`, `playbook_exceptions_used = 0`, plus the `pb` + `pb:<slug>` tags. Called by:

- **Deterministic matcher** — `unified-ticket-handler.routeExec` § 2b (Phase-2 rename in [[../specs/sol-session-chosen-playbook-selection-retire-brittle-triggers]]). Omits `seed_context`, so `playbook_context = {}`, matching pre-Phase-2 behavior.
- **Sol's session-chosen path** — `unified-ticket-handler.routeExec` § 2a (Phase 2 of the same spec). Passes `{ seed_context: direction.plan.playbook_seed_context }` so the ids Sol already picked (order / subscription / customer) land on step 0 without the executor re-deriving them.
- **Followup selection** (cancel-flow, etc.) — same shape, no seed.

`seed_context` merges shallow-into an empty fresh context (a starting playbook has no prior context), so callers can pass whatever the target playbook's step 0 reads (e.g. `refund` reads `order_id`; `assisted-purchase-classic` reads `subscription_id`). Non-object values are ignored (guarded to `{}`).

### `PlaybookExecResult` — interface

### `extractAssistedPurchaseIntentFromDecision` — function

```ts
function extractAssistedPurchaseIntentFromDecision(
  decision: { actions?: Array<{ type?: string; variant_id?: string; quantity?: number; interval?: string; interval_count?: number; date?: string }> },
  slug: "assisted-order-purchase" | "assisted-subscription-purchase",
): RawAssistedPurchaseIntent | null
```

Pure — no DB, no network. Derives a `RawAssistedPurchaseIntent` from a `SonnetDecision` the live orchestrator emits when it routes `action_type:'playbook'` at one of the two assisted-purchase playbook slugs. The extracted shape is fed to [[#`resolveAssistedPurchaseIntentToParams`]] which does the DB-backed variant → internal-UUID resolution before writing `ctx.assisted_purchase_params`.

Why it exists — spec [[../specs/live-orchestrator-assisted-purchase-carries-picked-item]]: the Sol Direction boundary (`src/lib/ticket-directions.ts` `resolvePlaybookForDirection`) already populates `plan.playbook_seed_context.assisted_purchase_params` from Sol's confirmed `purchase_intent`. The live Sonnet orchestrator had NO such wiring — it could pick `pb:assisted_subscription_purchase` directly and reach [[action-executor]] `handlePlaybook`, which used to call `startPlaybook` with no seed context; `handleAssistedCreate` then read an empty `ctx.assisted_purchase_params` and `assistedCreateMissingItemsGuard` refused every turn, causing the orchestrator to loop on its canned "which product and flavor would you like me to order?" reply (ticket `083201b5` — Maria D James). This helper closes that gap at the routing boundary, mirroring the Direction path exactly.

Extraction rules: prefers the exact `type` match (`create_order` / `create_subscription`), falls back to any action carrying a `variant_id` (the model has been seen attaching the create as a supplementary action alongside the playbook route). Returns null when no action carries a `variant_id` — the caller (`handlePlaybook`) then escalates instead of starting the playbook with empty params.

Sec:real-vuln trust boundary (same as `resolveAssistedPurchaseIntentToParams`): `unit_cents` and `vendor` are DELIBERATELY not read from the decision — price flows from the resolved `product_variants.price_cents`, vendor from the playbook step's `config.vendor` default. A prompt-injected customer cannot steer per-item pricing or the vendor branch through this path.

Pinned by `playbook-executor.orchestrator-assisted-intent.test.ts`.

### `decideCheckVaultedPmStep` — function

```ts
function decideCheckVaultedPmStep(input: CheckVaultedPmDeciderInput): CheckVaultedPmDecision
```

Pure state machine for the `check_vaulted_pm` step wired by the assisted-purchase-playbook spec Phase 2. Given `(rows, parked, journey)` returns one of `advance | launch | wait | resume_still_missing` — the four transitions the outer step handler turns into side effects. Exported so unit tests can pin each transition without a live DB. Prefers the customer's vaulted PM over any journey signal — a customer who already has an active PM is never sent through add_payment_method redundantly.

### `CheckVaultedPmDeciderInput` — interface

### `CheckVaultedPmDecision` — type

### `decidePauseSubscriptionStep` — function

```ts
function decidePauseSubscriptionStep(subscription: Subscription): 'advance' | 'execute_pause'
```

Pure decision function for the `pause_subscription` step in the Refund playbook. Given a subscription, returns `advance` (no action) if the subscription is already `cancelled`, or `execute_pause` if the subscription is active/paused and should be paused. Exported so unit tests can pin the decision logic without a live subscription. If the identified subscription is cancelled, there's nothing to pause — skipping the step removes the unbacked-pause-claim block that was dead-ending the playbook run in escalation.

## Callers

- `src/lib/inngest/unified-ticket-handler.ts`

## Gotchas

- **30-day MBG flow must create the return for real, not promise one.** `handle30DayFlow`'s `confirm_return` case is the terminal step of the 30-day money-back-guarantee flow (Refund playbook). When the customer confirms, it **must** call `createFullReturn()` (Shopify return + EasyPost label) and deliver the label **inline in the same reply**. It receives `tid` (threaded down from `handleApplyPolicy`) so the Shopify return links to the ticket. See [[../lifecycles/return-pipeline]] § "30-day flow regression".
  - _Historical bug (fixed 2026-06-08, commit pending):_ the old code inserted a bare `returns` row with `status:"pending_label"` + `resolution_type:"refund"` and told the customer "we're generating your label and will email it shortly." **Both values are invalid** — valid statuses are `label_created`/`open`/`in_transit`/…, valid resolution types are the four `*_return`/`*_no_return` enums. Postgres rejected the insert, the error was **silently swallowed** (no `.select()`/error check), so the row never persisted, no label was ever bought, and `pending_label` was a dead-end status nothing processed. Customers got a label promise that was never fulfilled. Affected Jill Howe (b97f558e), Dolores Flynn (f5c47b1b) — both manually remediated via `createFullReturn()` + threaded label email.
- **`complete` overrides your systemNote.** When a step returns `action:"complete"`, `executePlaybookStep` replaces the step's `systemNote` with `[Playbook Complete] {name}\n{summary}`. So a custom completion note (e.g. the 30-day "return approved" note) never shows in the thread — the `[Playbook Complete]` summary does. Don't rely on a completion-step systemNote being visible.
- **Stand-firm exits when the customer stops pursuing the refund.** Before a pre-exception stand-firm round, `handleOfferException` runs `detectStillPursuing(msg)`; if the customer is grateful / satisfied / dropped the ask (a "thank you" misrouted into the playbook by the Haiku drift-classifier), it returns `action:"complete"` — which clears `active_playbook_id` and closes the ticket with **no** customer message — instead of replying "your order falls outside our return window." Companion fixes: the positive-close path in `unified-ticket-handler` now also clears `active_playbook_id` (a closed ticket must not leave a live playbook to re-fire), and the drift-classifier treats pure gratitude as NEW_TOPIC. _Bug (fixed 2026-06-14, ticket 6e44c252):_ a resolved loyalty conversation kept drawing stand-firm 1/2 + 2/2 on "RIGHT ON! Thank you!" because the refund playbook stayed active after positive close.
- **Purchase-intent routing to the assisted-purchase playbooks is DB-driven** ([[../specs/assisted-purchase-playbook]] Phase 3, seeded by `supabase/migrations/20260731140000_seed_assisted_purchase_sonnet_prompt.sql`). The two Phase-2 playbooks carry `trigger_intents` covering `create_order` / `assisted_purchase_order` / `buy` / `reorder` (order) and `create_subscription` / `assisted_purchase_subscription` / `add_subscription` / `subscribe` (subscription); the pure `scorePlaybookAgainst` scorer still returns 1.0 on the exact-match cases (kept unchanged so `playbook-executor.assisted-purchase-routing.test.ts` still holds), BUT — per [[assisted-purchase-direction]] Phase 4 (session-chosen-only exclusion) — the DB wrappers `matchPlaybookScored` + `matchPlaybook` now skip both playbooks via `isSessionChosenOnlyPlaybook(slug)` BEFORE scoring, so they only dispatch via Sol's session-chosen selection (`chosen_path='playbook'` + `plan.playbook_slug='assisted-order-purchase' | 'assisted-subscription-purchase'` — M4 of [[../specs/sol-session-chosen-playbook-selection-retire-brittle-triggers]]). The old brittle over-fire on purchase-adjacent language ("when can I reorder?") no longer starts the create-order playbook. Pinned by `playbook-executor.session-chosen-only-exclusion.test.ts`; the pre-existing routing test still covers the pure scorer.

- **The terminal `create_order` / `create_subscription` step escalates the ticket + mints a CEO card on failure** ([[../specs/create-subscription-internal-branch-cannot-create-a-subscription]] Phase 2, derived from ticket `687b2e7a` — Susan Bellamy). `handleAssistedCreate` now invokes [[assisted-purchase-failure-escalate]] `escalateAndCardOnAssistedPurchaseFailure` whenever the direct-action handler returns `success: false`. That helper (shared with cs-director's `handleApproveRemedy`) writes `tickets.status='open'` + `escalated_at=now()` (compare-and-set on workspace_id + id) so the ticket does NOT sit `open` + `escalated_to = null`, then inserts a CEO `dashboard_notifications` `agent_approval_request` card via [[assisted-purchase-failure-card]] `buildAssistedPurchaseFailureCard` naming the customer + the plan agreed to + the concrete failure + `origin: 'playbook'`. The `interpretAssistedCreateResult` verdict (customer-visible response, systemNote, backedActions) is UNCHANGED — the escalate/card side effects run in parallel, best-effort, so a failed escalate write cannot swallow the honest "ran into an issue" reply. A purchase a customer has already agreed to must not fail quietly; Susan's ticket sat open + unowned across two silent failures precisely because this rail was missing.

- **The assisted-purchase playbooks pair `check_vaulted_pm` with a terminal `create_order` / `create_subscription` step** ([[../specs/assisted-purchase-playbook]] Phase 2, seeded by `supabase/migrations/20260707150000_seed_assisted_purchase_playbook.sql`). Step 0's handler reads [[../tables/customer_payment_methods]] across [[../tables/customer_links]] siblings, filters via [[action-executor]] `pickChargeableVaultedPm`, and either (a) advances with `vaulted_payment_method_id` in ctx, (b) launches the [[../journeys/add-payment-method]] journey via [[journey-delivery]] `launchJourneyForTicket` + parks with `paused_for_add_pm=true` in `playbook_context`, (c) waits when parked-and-journey-still-open (no re-launch, no message), or (d) surfaces "still missing" when the journey completed but the customer left no PM. The four transitions are the pure `decideCheckVaultedPmStep` decider — pinned by `playbook-executor.check-vaulted-pm.test.ts`. The terminal `create_order` / `create_subscription` step handler reads `ctx.assisted_purchase_params` + step config defaults (e.g. `vendor='internal'`), refuses to dispatch without a stashed `vaulted_payment_method_id` (carries the Phase-1 fail-closed invariant into the playbook path), and calls the SAME [[action-executor]] `directActionHandlers[type]` the direct-create path uses — one effector, two entry paths. Steps are DB rows: removing or reordering a `playbook_steps` row changes behavior (spec Phase-2 verification bullet 3, "no hardcoding"). Per [[assisted-purchase-direction]] Phase 4 (interpret result), the result→response mapping is extracted into the pure exported `interpretAssistedCreateResult` — success returns `action:'complete'` with the truthful placement claim + `backedActions:[actionType]`, failure returns `action:'respond'` with an honest "ran into an issue" reply and NO `backedActions` (the truthful signal for downstream guards). Pinned by `playbook-executor.assisted-create.test.ts` — every code-path assertion for exactly-one-order-at-the-right-price + execute-then-confirm.

- **The live orchestrator's `handlePlaybook` mirrors the Sol Direction routing boundary for the two assisted-purchase slugs** ([[../specs/live-orchestrator-assisted-purchase-carries-picked-item]]). When Sonnet picks `action_type:'playbook'` targeting `assisted-order-purchase` or `assisted-subscription-purchase`, [[action-executor]] `handlePlaybook` calls [[#`extractAssistedPurchaseIntentFromDecision`]] on the decision's `actions[]`, hands the result to [[#`resolveAssistedPurchaseIntentToParams`]] for the DB-backed variant → internal-UUID resolution, and passes the resolved params through `startPlaybook`'s `seed_context.assisted_purchase_params` — EXACTLY the shape `handleAssistedCreate` reads at the terminal step. If the intent cannot be resolved (no `variant_id` on any action, or `findVariant` returns null for a cross-workspace / bogus reference), `handlePlaybook` escalates with `reason='assisted_purchase_orchestrator_missing_intent:<slug>'` INSTEAD of calling `startPlaybook` with an empty context. Rationale: starting with empty params only trips the sibling `assistedCreateMissingItemsGuard` on every subsequent turn, and the orchestrator emits its canned "which product and flavor..." reply in an infinite loop (ticket `083201b5` — Maria D James, confirmed 3× Cocoa French Roast on a vaulted card, looped ~4 times before escalating `no_progress_context_cap`). The escalation hands the ticket back to Sol so `resolvePlaybookForDirection`'s DB-backed resolver runs against a fresh Sol-authored Direction with the customer still in the conversation. Trust boundary is preserved: `unit_cents` + `vendor` are NEVER sourced from the decision — see the sec:real-vuln note on `resolveAssistedPurchaseIntentToParams`.

- **Sol's playbook short-circuit is an earlier entry point** ([[../specs/sol-cheap-execution-over-ticket-direction]] § Phase 4). When a follow-up turn arrives on a ticket whose live [[../tables/ticket_directions]] row is `chosen_path='playbook'` AND [[../tables/tickets]].`active_playbook_id` is still set, [[../inngest/unified-ticket-handler]]'s Step 3.98 calls `executePlaybookStep` DIRECTLY and skips the Sonnet orchestrator — a zero-cost turn. Stamps a [[../tables/ticket_resolution_events]] row with `reasoning='sol:playbook-shortcircuit'` (same stage → send → CAS-shipped_at pattern as `sendFirstTouchAck`) so cost analytics can count zero-cost turns without a heuristic classifier. When `chosen_path='playbook'` but `active_playbook_id` is null (playbook completed or its exception retries exhausted), the short-circuit falls through to the standard Sonnet Step 4 path so the ticket keeps making progress. One effector (`executePlaybookStep`), two entry paths (Sonnet-orchestrated `handlePlaybook`, and this direct short-circuit).

- **Every `aiGenerate` userPrompt must include `Customer data:\n${dataCtx}`.** `basePrompt` instructs the model to "refer to orders by date and amount" — so if a call omits `dataCtx`, the model has no date/amount and emits unrendered placeholders (`your order from [date] for $[amount]`) that reach the customer (there is NO substitution step). _Bug (fixed 2026-06-14):_ the `handleOfferException` stand-firm branch was the only call missing `dataCtx`; Opus on the hardship path printed `[date]`/`[amount]` to a customer (graded 4/10 via the broken-action hard cap). Fixes: stand-firm now passes `dataCtx`; `basePrompt` bans placeholder tokens; and `aiGenerate` has a backstop that regenerates (then strips) any `[...]`/`{{...}}` placeholder before it can leave. When adding a new `aiGenerate` call, pass `dataCtx`.

---

[[../README]] · [[../../CLAUDE]]
