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
async function startPlaybook(admin: Admin, ticketId: string, playbookId: string,) : Promise<void>
```

### `PlaybookExecResult` — interface

### `decideCheckVaultedPmStep` — function

```ts
function decideCheckVaultedPmStep(input: CheckVaultedPmDeciderInput): CheckVaultedPmDecision
```

Pure state machine for the `check_vaulted_pm` step wired by the assisted-purchase-playbook spec Phase 2. Given `(rows, parked, journey)` returns one of `advance | launch | wait | resume_still_missing` — the four transitions the outer step handler turns into side effects. Exported so unit tests can pin each transition without a live DB. Prefers the customer's vaulted PM over any journey signal — a customer who already has an active PM is never sent through add_payment_method redundantly.

### `CheckVaultedPmDeciderInput` — interface

### `CheckVaultedPmDecision` — type

## Callers

- `src/lib/inngest/unified-ticket-handler.ts`

## Gotchas

- **30-day MBG flow must create the return for real, not promise one.** `handle30DayFlow`'s `confirm_return` case is the terminal step of the 30-day money-back-guarantee flow (Refund playbook). When the customer confirms, it **must** call `createFullReturn()` (Shopify return + EasyPost label) and deliver the label **inline in the same reply**. It receives `tid` (threaded down from `handleApplyPolicy`) so the Shopify return links to the ticket. See [[../lifecycles/return-pipeline]] § "30-day flow regression".
  - _Historical bug (fixed 2026-06-08, commit pending):_ the old code inserted a bare `returns` row with `status:"pending_label"` + `resolution_type:"refund"` and told the customer "we're generating your label and will email it shortly." **Both values are invalid** — valid statuses are `label_created`/`open`/`in_transit`/…, valid resolution types are the four `*_return`/`*_no_return` enums. Postgres rejected the insert, the error was **silently swallowed** (no `.select()`/error check), so the row never persisted, no label was ever bought, and `pending_label` was a dead-end status nothing processed. Customers got a label promise that was never fulfilled. Affected Jill Howe (b97f558e), Dolores Flynn (f5c47b1b) — both manually remediated via `createFullReturn()` + threaded label email.
- **`complete` overrides your systemNote.** When a step returns `action:"complete"`, `executePlaybookStep` replaces the step's `systemNote` with `[Playbook Complete] {name}\n{summary}`. So a custom completion note (e.g. the 30-day "return approved" note) never shows in the thread — the `[Playbook Complete]` summary does. Don't rely on a completion-step systemNote being visible.
- **Stand-firm exits when the customer stops pursuing the refund.** Before a pre-exception stand-firm round, `handleOfferException` runs `detectStillPursuing(msg)`; if the customer is grateful / satisfied / dropped the ask (a "thank you" misrouted into the playbook by the Haiku drift-classifier), it returns `action:"complete"` — which clears `active_playbook_id` and closes the ticket with **no** customer message — instead of replying "your order falls outside our return window." Companion fixes: the positive-close path in `unified-ticket-handler` now also clears `active_playbook_id` (a closed ticket must not leave a live playbook to re-fire), and the drift-classifier treats pure gratitude as NEW_TOPIC. _Bug (fixed 2026-06-14, ticket 6e44c252):_ a resolved loyalty conversation kept drawing stand-firm 1/2 + 2/2 on "RIGHT ON! Thank you!" because the refund playbook stayed active after positive close.
- **Purchase-intent routing to the assisted-purchase playbooks is DB-driven** ([[../specs/assisted-purchase-playbook]] Phase 3, seeded by `supabase/migrations/20260731140000_seed_assisted_purchase_sonnet_prompt.sql`). The two Phase-2 playbooks carry `trigger_intents` covering `create_order` / `assisted_purchase_order` / `buy` / `reorder` (order) and `create_subscription` / `assisted_purchase_subscription` / `add_subscription` / `subscribe` (subscription); `matchPlaybookScored` scores each at 1.0 for the exact-match cases the intent classifier produces, above the 0.65 `DEFAULT_DEFER_THRESHOLD` gate so a purchase-intent ticket routes to the playbook automatically (not a stateless direct create). A [[../tables/sonnet_prompts]] rule (`Assisted purchase (prefer playbook over bare create)`, category='rule', sort_order 31) reinforces this at Sonnet's decision-time — the model is instructed NOT to emit a bare `create_order` / `create_subscription` direct_action for a purchase intent, so the vaulted-PM gate always runs. Phase-1's fail-closed guard on the direct handlers is the belt; this is the suspenders — a purchase intent never reaches an ungated create. Pinned by `playbook-executor.assisted-purchase-routing.test.ts`. Unrelated intents (cancel_subscription, refund, address_change) score 0 against the assisted-purchase triggers so those tickets fall through to their own playbook/journey.

- **The assisted-purchase playbooks pair `check_vaulted_pm` with a terminal `create_order` / `create_subscription` step** ([[../specs/assisted-purchase-playbook]] Phase 2, seeded by `supabase/migrations/20260707150000_seed_assisted_purchase_playbook.sql`). Step 0's handler reads [[../tables/customer_payment_methods]] across [[../tables/customer_links]] siblings, filters via [[action-executor]] `pickChargeableVaultedPm`, and either (a) advances with `vaulted_payment_method_id` in ctx, (b) launches the [[../journeys/add-payment-method]] journey via [[journey-delivery]] `launchJourneyForTicket` + parks with `paused_for_add_pm=true` in `playbook_context`, (c) waits when parked-and-journey-still-open (no re-launch, no message), or (d) surfaces "still missing" when the journey completed but the customer left no PM. The four transitions are the pure `decideCheckVaultedPmStep` decider — pinned by `playbook-executor.check-vaulted-pm.test.ts`. The terminal `create_order` / `create_subscription` step handler reads `ctx.assisted_purchase_params` + step config defaults (e.g. `vendor='internal'`), refuses to dispatch without a stashed `vaulted_payment_method_id` (carries the Phase-1 fail-closed invariant into the playbook path), and calls the SAME [[action-executor]] `directActionHandlers[type]` the direct-create path uses — one effector, two entry paths. Steps are DB rows: removing or reordering a `playbook_steps` row changes behavior (spec Phase-2 verification bullet 3, "no hardcoding").

- **Every `aiGenerate` userPrompt must include `Customer data:\n${dataCtx}`.** `basePrompt` instructs the model to "refer to orders by date and amount" — so if a call omits `dataCtx`, the model has no date/amount and emits unrendered placeholders (`your order from [date] for $[amount]`) that reach the customer (there is NO substitution step). _Bug (fixed 2026-06-14):_ the `handleOfferException` stand-firm branch was the only call missing `dataCtx`; Opus on the hardship path printed `[date]`/`[amount]` to a customer (graded 4/10 via the broken-action hard cap). Fixes: stand-firm now passes `dataCtx`; `basePrompt` bans placeholder tokens; and `aiGenerate` has a backstop that regenerates (then strips) any `[...]`/`{{...}}` placeholder before it can leave. When adding a new `aiGenerate` call, pass `dataCtx`.

---

[[../README]] · [[../../CLAUDE]]
