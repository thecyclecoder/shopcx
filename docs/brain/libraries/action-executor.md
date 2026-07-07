# libraries/action-executor

**Status:** Mutation handlers migrated to [[../libraries/commerce__*]] (M4). All subscription/order/return/refund/loyalty actions route through unified Commerce SDK entry points.

Dispatches `SonnetDecision` JSON. Handles direct_action / journey / playbook / workflow / macro / kb_response / ai_response / escalate. Resolves handler_name against journeys, playbooks, workflows by name OR trigger_intent (case-insensitive). Single source of truth for executing AI decisions.

**File:** `src/lib/action-executor.ts`

## File header

```
Action Executor — executes actions from the Sonnet orchestrator's decision.
Takes a SonnetDecision (JSON action plan) and dispatches to the appropriate
handler: direct subscription actions, journeys, playbooks, workflows, macros,
KB/AI responses, or escalation.
```

## Exports

### `stripUnsubstitutedPlaceholders` — function

```ts
function stripUnsubstitutedPlaceholders(message: string) : string
```

### `executeSonnetDecision` — function

```ts
async function executeSonnetDecision(ctx: ActionContext, decision: SonnetDecision, personality: { name?: string; tone?: string; sign_off?: string | null } | null, send: SendFn, sysNote: SysNoteFn,) : Promise<
```

### `directActionHandlers` — const

```ts
const directActionHandlers: Record<
  string,
  (ctx: ActionContext, p: ActionParams)
```

### `pickChargeableVaultedPm` — function

```ts
function pickChargeableVaultedPm(rows: CustomerPaymentMethodRow[] | null | undefined): CustomerPaymentMethodRow | null
```

Pure predicate wired into the `create_order` / `create_subscription` vaulted-PM guard (assisted-purchase-playbook spec Phase 1). Picks the customer's chargeable vaulted PM from a set of [[../tables/customer_payment_methods]] rows — prefers `is_default=true` among rows with `status='active'`, else any active row; returns null when no chargeable row exists. Exported so tests can pin the fail-closed branch without a live DB.

### `CustomerPaymentMethodRow` — interface

### `SonnetDecision` — interface

### `ActionParams` — interface

### `ActionContext` — interface

### `ActionResult` — interface

## Callers

- `src/lib/inngest/ticket-research.ts`
- `src/lib/portal/handlers/account.ts`

## Gotchas

- **`bill_now` (and `change_next_date`'s ASAP/today fallback) route through [[../libraries/commerce__subscription]]'s unified entry points (M4 migration).** Internal (Braintree) subs fire `internal-subscription/renewal-attempt` ([[../inngest/internal-subscription-renewals]]); Appstle subs hit the commerce ops. Do NOT call legacy helpers directly — the unified entry points branch internally. (Historical escalation: ticket `dd67f3c7`, customer Angel — legacy direct call to `appstleAttemptBilling` was a NO-OP success on internal subs.)

- **Handlers that pass `p.contract_id` to Appstle must top-guard with `if (!p.contract_id) return { success: false, error: "Missing contract_id" }` — never trust the `!` non-null bang on an AI-populated field.** Under Sonnet, `contract_id` is optional on the decision JSON; a `!` compiles fine but URL-interpolates the literal string `undefined` into the Appstle endpoint, so the Java parser rejects it with `Failed to convert value of type String to required type Long ... For input string: undefined` (Vercel repair-signature `vercel:d1de82cb0b83d9ae`). `pause_timed` and `crisis_pause` guard at the handler boundary; keep the guard here — pushing it into `appstleSubscriptionAction` would mask the same bug in `reactivate`, `crisis_remove`, etc., that still use `p.contract_id!`. Fix each handler as its signature surfaces in Control Tower, not the shared helper.

- **Defect #2 closed: `apply_coupon` / `remove_coupon` (and `apply_loyalty_coupon`'s two internal apply calls) now route through the internal-aware coupon dispatcher — `subscriptionApplyCoupon` / `subscriptionRemoveCoupon` in [[subscription-items]].** An internal (`is_internal=true`) sub goes through `resolveCoupon` → `internalSubApplyDiscount`/`internalSubRemoveDiscount`, which mutate `subscriptions.applied_discounts`; an Appstle sub goes through `healOnTouch` → `applyDiscountWithReplace`/`removeExistingDiscounts`. The LOYALTY-* redirect from `apply_coupon` → `apply_loyalty_coupon` is preserved; that handler owns coupon regeneration self-heal. Missing-`contract_id` is top-guarded on all three handlers so we never URL-interpolate the literal `undefined` on the Appstle branch.

- **Both direct-action handler-lookup sites (`executeActionsInline` and `handleDirectAction`) consult the [[../tables/action_handler_aliases]] catalog on a miss before falling through to `Unknown action type`.** The lookup is one-shot via [[action-handler-aliases]] `resolveAlias(ctx.admin, ctx.workspaceId, action.type)`; on a hit we sysNote `alias resolved: {source}→{target}`, rewrite `action.type` to the canonical handler key, and fire the handler as normal. That closes the silent-miss branch for Sonnet's `cancel_subscription` / `refund_partial` / `pause_subscription` / `resume_subscription` near-misses (seeded globally by the Phase-1 migration).

- **On a resolver miss the executor records the hit for admin review.** [[proposed-action-aliases]] `recordUnknownActionType` upserts a `(workspace_id, source_type)` row in [[../tables/proposed_action_aliases]] with a bumped `occurrences` and refreshed `last_seen` + most-recent `ticket_id`. Once `occurrences >= 3` and the row is still `pending`, a small Haiku call proposes a target from the passed-in `Object.keys(directActionHandlers)` list — validated against that same list before write so a hallucinated handler name cannot make it into the queue. The admin approves/declines at `/dashboard/settings/ai/handler-aliases`; the approve route dual-writes an [[../tables/action_handler_aliases]] row (workspace-scoped, `active=true`) so the very next hit resolves cleanly.

- **`direct_action` opens with the selective-clarify gate** ([[selective-clarify]] — Phase 2 of [[../specs/confidence-gated-problem-lockin-and-selective-clarify]]). Before `handleDirectAction` runs, `shouldClarify(decision)` intersects the decision's `actions[].type` with a workspace-scoped IRREVERSIBLE_SET (default `{partial_refund, cancel, bill_now, subscriptionOrderNow}`; overridable via a `slug='irreversible_actions'` [[../tables/policies]] row) and its `confidence` against a threshold (default `0.7`). On a hit we send a scoped confirmation-turn (`buildClarificationMessage`), stamp [[../tables/ticket_resolution_events]] `verified_outcome='clarified'`, and skip execution entirely. Sandbox mode bypasses the gate (its stamped-note dry-run is already non-destructive). This is the ~6% intersection the parent goal picks up — the alternative is the 38% blanket-clarify regime it rejects.

- **`create_order` / `create_subscription` open with an unconditional vaulted-PM guard** ([[../specs/assisted-purchase-playbook]] Phase 1). The guard reads [[../tables/customer_payment_methods]] for the customer (expanding [[../tables/customer_links]] siblings), keeps only `status='active'` rows via `pickChargeableVaultedPm`, and — on a miss — launches the [[../journeys/add-payment-method]] journey via [[journey-delivery]] `launchJourneyForTicket`, writes an internal `[System] {action} deferred — no vaulted payment method` note on the ticket, and returns `{ success: false, error: 'no_vaulted_payment_method', summary: '{action} deferred …' }` WITHOUT calling the commerce effector. Fail-closed and unconditional (no flag bypass) — a missing PM can never reach `createOrder` / `createSubscription`. Pinned by `action-executor.vaulted-pm-guard.test.ts`.

- **`executeSonnetDecision` returns `{ messageSent, escalated, closed, statusManaged }`.** The `workflow` case returns `statusManaged: true` (via `handleWorkflow`, which returns `true` only when a workflow actually ran) because the workflow executor sets the authoritative final status itself in `sendReply` ([[workflow-executor]]: `account_login` → closed, `return_to_sender` → open). The post-execute block in [[../inngest/unified-ticket-handler]] (`postExecuteStatusAction`) must leave a status-managed ticket untouched — do NOT copy the journey case's `messageSent = true`, which routes through `setStatus` and always forces `closed`, wrongly closing an intentionally-open workflow. (Ticket `a89dcf76` Mindy Freeman: `account_login` magic-link close was being reopened as "no customer message sent".) See [[../lifecycles/ticket-lifecycle]] Phase 5.

---

[[../README]] · [[../../CLAUDE]]
