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

## Callers

- `src/lib/inngest/unified-ticket-handler.ts`

## Gotchas

- **30-day MBG flow must create the return for real, not promise one.** `handle30DayFlow`'s `confirm_return` case is the terminal step of the 30-day money-back-guarantee flow (Refund playbook). When the customer confirms, it **must** call `createFullReturn()` (Shopify return + EasyPost label) and deliver the label **inline in the same reply**. It receives `tid` (threaded down from `handleApplyPolicy`) so the Shopify return links to the ticket. See [[../lifecycles/return-pipeline]] § "30-day flow regression".
  - _Historical bug (fixed 2026-06-08, commit pending):_ the old code inserted a bare `returns` row with `status:"pending_label"` + `resolution_type:"refund"` and told the customer "we're generating your label and will email it shortly." **Both values are invalid** — valid statuses are `label_created`/`open`/`in_transit`/…, valid resolution types are the four `*_return`/`*_no_return` enums. Postgres rejected the insert, the error was **silently swallowed** (no `.select()`/error check), so the row never persisted, no label was ever bought, and `pending_label` was a dead-end status nothing processed. Customers got a label promise that was never fulfilled. Affected Jill Howe (b97f558e), Dolores Flynn (f5c47b1b) — both manually remediated via `createFullReturn()` + threaded label email.
- **`complete` overrides your systemNote.** When a step returns `action:"complete"`, `executePlaybookStep` replaces the step's `systemNote` with `[Playbook Complete] {name}\n{summary}`. So a custom completion note (e.g. the 30-day "return approved" note) never shows in the thread — the `[Playbook Complete]` summary does. Don't rely on a completion-step systemNote being visible.
- **Stand-firm exits when the customer stops pursuing the refund.** Before a pre-exception stand-firm round, `handleOfferException` runs `detectStillPursuing(msg)`; if the customer is grateful / satisfied / dropped the ask (a "thank you" misrouted into the playbook by the Haiku drift-classifier), it returns `action:"complete"` — which clears `active_playbook_id` and closes the ticket with **no** customer message — instead of replying "your order falls outside our return window." Companion fixes: the positive-close path in `unified-ticket-handler` now also clears `active_playbook_id` (a closed ticket must not leave a live playbook to re-fire), and the drift-classifier treats pure gratitude as NEW_TOPIC. _Bug (fixed 2026-06-14, ticket 6e44c252):_ a resolved loyalty conversation kept drawing stand-firm 1/2 + 2/2 on "RIGHT ON! Thank you!" because the refund playbook stayed active after positive close.
- **Every `aiGenerate` userPrompt must include `Customer data:\n${dataCtx}`.** `basePrompt` instructs the model to "refer to orders by date and amount" — so if a call omits `dataCtx`, the model has no date/amount and emits unrendered placeholders (`your order from [date] for $[amount]`) that reach the customer (there is NO substitution step). _Bug (fixed 2026-06-14):_ the `handleOfferException` stand-firm branch was the only call missing `dataCtx`; Opus on the hardship path printed `[date]`/`[amount]` to a customer (graded 4/10 via the broken-action hard cap). Fixes: stand-firm now passes `dataCtx`; `basePrompt` bans placeholder tokens; and `aiGenerate` has a backstop that regenerates (then strips) any `[...]`/`{{...}}` placeholder before it can leave. When adding a new `aiGenerate` call, pass `dataCtx`.

---

[[../README]] · [[../../CLAUDE]]
