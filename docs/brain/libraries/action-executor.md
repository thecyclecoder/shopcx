# libraries/action-executor

**Status:** Mutation handlers migrated to [[../libraries/commerce__*]] (M4). All subscription/order/return/refund/loyalty actions route through unified Commerce SDK entry points.

Dispatches `SonnetDecision` JSON. Handles direct_action / journey / playbook / workflow / macro / kb_response / ai_response / escalate. Resolves handler_name against journeys, playbooks, workflows by name OR trigger_intent (case-insensitive). Single source of truth for executing AI decisions.

**Plain-reply claim-guard backing** — on `kb_response` / `ai_response` the [[claim-guard]] `unbackedEffectClaim` is called with a `backed` set populated by [[completed-effect-backing]] `backedEffectsForCompletedEffects` (completed journeys on this ticket + subscriptions already in the claimed end state). A truthful post-journey follow-up like "your subscription has been cancelled" AFTER a completed cancel journey now passes; an invented promise still hits `escalateTicket(ctx, "blocked_unbacked_claim:<effect>")` exactly as before. Fail-safe: helper returns an empty set on any lookup error, reproducing today's blocking behavior. Phase 1 of [[../specs/claim-guard-backs-completed-effects-on-post-journey-followups]].

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

Last-resort strip of any `{{token}}` / `[UPPER_TOKEN]` a composer failed to fill so the literal brace text can never reach a customer. **Since [[../specs/no-send-path-can-emit-an-unsubstituted-placeholder]] Phase 1 the authoritative caller is [[ticket-delivery|resolvePlaceholderSafeMessage]] at the send chokepoint** — this helper still runs from `substituteActionPlaceholders` and its historical composing sites, but a composer that forgets it can no longer leak because every outbound customer message runs through the chokepoint. Ethel Hutton (BBB complaint, ticket `2305546a`) and Julianne Peters (15 days unresolved, ticket `de357c10`) hit the pre-rail failure on 2026-07-28..29, both agent-authored replies that composed `{{label_url}}` without calling this helper; the delivery-owned rail closed that class.

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

### `MAX_LOYALTY_REGEN_ATTEMPTS` — const

```ts
const MAX_LOYALTY_REGEN_ATTEMPTS: number
```

Phase-2 defensive ceiling on how many times the `apply_loyalty_coupon` regen branch retries the mint's APPLY step before giving up (spec: loyalty-coupon-apply-resolves-contract-owning-member-no-doomed-regen). Points ledger is unaffected — `claimRegenSpendSlot` still fires the single spend once, so the retry loop only touches Shopify/Appstle and re-reads the sub's `applied_discounts`. A persistently-rejecting upstream can never infinite-loop inside the regen branch.

### `resolveContractOwnerShopifyCustomerId` — function

```ts
async function resolveContractOwnerShopifyCustomerId(
  admin: Admin,
  workspaceId: string,
  contractId: string,
): Promise<string | null>
```

Phase-2 helper (spec: loyalty-coupon-apply-resolves-contract-owning-member-no-doomed-regen). Resolves the target contract's owning Shopify customer id: `subscriptions.customer_id` → `customers.shopify_customer_id`, workspace-scoped on both reads. The regen mint uses this instead of the aggregate loyalty member's `shopify_customer_id` — points combine across a link group but a code cannot, so a code minted for a sibling member (the canonical high-balance identity that `aggregateLinkedMembers` returns) is a guaranteed apply failure on this contract. Returns null when the sub row / customer row / `shopify_customer_id` is missing so the regen falls back to `member.shopify_customer_id` — behavior is unchanged on unknown-provenance sub rows.

### `verifyLoyaltyCouponAppliedToContract` — function

```ts
async function verifyLoyaltyCouponAppliedToContract(
  admin: Admin,
  workspaceId: string,
  contractId: string,
  code: string,
): Promise<boolean>
```

Phase-2 predicate (spec: loyalty-coupon-apply-resolves-contract-owning-member-no-doomed-regen). Re-reads `subscriptions.applied_discounts` and returns true only when `code` is actually present — case-insensitive match across the tolerant shape family used by `subscriptionHasLoyaltyCoupon` (bare string · `{title}` · `{code}`). Called in the regen branch AFTER `subscriptionApplyCoupon` returns success, before the handler reports success back to the caller: Shopify's "success" is not the same as the code landing on the contract (a race with a concurrent apply/remove or an Appstle sync lag can report success on a request that didn't stick). Missing sub row ⇒ false — unknown-provenance is treated as "didn't land" so the caller retries or exhausts, rather than trusting an ambiguous upstream ack.

### `stillHasDiscountCode` — function

```ts
function stillHasDiscountCode(appliedDiscounts: unknown, code: string): boolean
```

Executor-level read-back predicate for `verifyActionInDB`'s `remove_coupon` case. True when `subscriptions.applied_discounts` still carries `code` under ANY of the stored shapes the codebase writes (bare string · `{title}` · `{code}` · `{id}`), case-insensitive because `resolveCoupon` returns the caller's casing. Load-bearing: pre-fix, `verifyActionInDB` had no `remove_coupon` case and the switch hit `console.warn(uncovered action type — assuming OK: remove_coupon)`, letting a silent no-op remover (the shape mismatch fixed in Phase 1) ship an "I removed it" message onward (Randi Stier 2026-08-10, ticket `c2bc8bd8-2aca-4eeb-968b-dd968a3d0dbc`). The new case re-reads `applied_discounts` after the removal and returns `verified=false` when this predicate is still true, so the same class of false success cannot pass even if a future variant of the shape mismatch re-emerges. Tests: `src/lib/action-executor.verify-remove-coupon.test.ts`.

**Uncovered mutating actions audit:** `bill_now` / `order_now` are NAMED explicitly in `verifyActionInDB` — not left to the silent default warn — with a `return true` comment noting that no cheap synchronous post-read exists (the vendor accepts, then charges async). The confirming predicate for the charge lives in the async `commerce/order-now.verify` re-check dispatched by [[../libraries/commerce__order-now-verify]] `subscriptionOrderNowVerified`, which stamps the `ticket_resolution_events` row on the REAL outcome; the executor's return-time verify would false-negative a legitimately-pending charge, so trusting the async verify is the correct semantic. Making the case explicit means the exposures named in the coupon-remove audit ("`bill_now` also logged `uncovered action type — assuming OK`, and it CHARGES money") can't hide behind the generic branch.

### `refuseLoyaltyCouponIfCustomerMismatch` — function

```ts
async function refuseLoyaltyCouponIfCustomerMismatch(
  admin: Admin,
  workspaceId: string,
  contractId: string,
  code: string,
): Promise<ActionResult | null>
```

Phase-1 upfront guard for `apply_loyalty_coupon` (spec: loyalty-coupon-apply-resolves-contract-owning-member-no-doomed-regen). A loyalty code is minted with `customerSelection.customers.add`, so it's locked to ONE Shopify customer; points combine across a link group but a code does not. Resolves the contract's owning Shopify customer (`subscriptions.customer_id` → `customers.shopify_customer_id`) and the code's owning Shopify customer (`loyalty_redemptions.member_id` → `loyalty_members.shopify_customer_id`); a definite mismatch returns a refusal `ActionResult` naming both. The refusal fires BEFORE the 2s Shopify propagation delay and BEFORE the apply→regen self-heal so Appstle is never called (its apply path strips existing automatic discounts first, so a doomed apply is worse than a no-op) and regen never mints a second doomed code. When the link group carries a sibling reward of the same `discount_value` whose member IS the contract owner, the error also suggests that code. Either side unresolvable ⇒ returns null; the ordinary apply path runs and the existing verify+retry surfaces the failure — a resolvable ambiguity must never become a refusal. Precedent: ticket 2b7ea029 (Sandra Lutz). Tests: `src/lib/action-executor.apply-loyalty-coupon-owner-mismatch.test.ts`.

### `claimRegenSpendSlot` — function

```ts
async function claimRegenSpendSlot(
  admin: { from: (t: string) => { update: (patch: Record<string, unknown>) => { eq: (col: string, val: unknown) => unknown } } },
  workspaceId: string,
  origRedemptionId: string,
): Promise<boolean>
```

Compare-and-set primitive that gates idempotent coupon regeneration for `apply_loyalty_coupon`. When a Shopify verify fails and the apply handler retries, the original redemption may already have been regenerated and minted to a new code by an earlier retry — this guard detects that and prevents a second spend. Atomically attempts to flip the original `loyalty_redemptions` row from `status='active'` → `status='expired'` (using `.eq('status','active')` as the predicate on the UPDATE itself), returning `true` only if the row was still active. If `false` is returned, the caller — who would have called `spendPoints` — instead routes to `replaySuccessorApply` to apply the successor code without re-spending. Exported for unit testing the atomic claim behavior.

### `reconcileLoyaltyRefundCoupons` — function

```ts
async function reconcileLoyaltyRefundCoupons(
  admin: Admin,
  workspaceId: string,
  memberId: string,
  ticketId: string,
): Promise<number>
```

Compare-and-set guard that closes the SC135320 double-payout class: a Tier-0 Loyalty Save turn issued `redeem_points` (minting an ACTIVE LOYALTY-* coupon, ~$15 spendable) AND a separate cash `partial_refund` — two payout vehicles for one 1,500-pt redemption; a later drifted turn then applied the dangling LOYALTY-* coupon to the customer's paused sub. Invoked from both loyalty cash-refund handlers (`redeem_points_as_refund` after the refund settles + new redemption row inserts, and the `partial_refund` handler after `r.success` — via a member lookup by `customer_id`). Atomically flips any `active` LOYALTY-* redemption for that member minted in the ticket window (`created_at >= ticket.created_at`) to `redeemed_as_refund` using `.eq('status','active')` as the predicate on the UPDATE — mirrors `claimRegenSpendSlot`. Ticket-window bounding means a routine shipping refund on an unrelated ticket cannot consume an older legit LOYALTY-* the customer earned in a prior session. Idempotent no-op on the common case (no LOYALTY-* minted). Returns the number of reconciled rows.

**Also stamps `consumed_via='refund'`** on every reconciled row (Phase 2 of [[../specs/loyalty-redemption-marked-used-when-consumed]]) so the schema records HOW the reward was delivered alongside `used_at`. Status stays `redeemed_as_refund` (not `used`) so the SC135320 semantic — reconciled-out-from-under-a-refund — remains distinguishable from consumed-on-order; `consumed_via` is the parallel dimension that captures the delivery kind. This function does NOT route through [[loyalty]] `consumeRedemption` because that helper's compare-and-set is scoped to `status IN ('active','applied') → 'used'`; reconcile's `active → redeemed_as_refund` transition is a different semantic and would break the tenant-scope test that asserts the exact status.

### `replaySuccessorApply` — function

```ts
async function replaySuccessorApply(
  ctx: Pick<ActionContext, "admin" | "workspaceId">,
  contractId: string,
  memberId: string,
  origCode: string,
  initialApplyError: string | undefined,
): Promise<ActionResult>
```

Idempotent-replay recovery for `apply_loyalty_coupon` when `claimRegenSpendSlot` returns false (an earlier regen already ran for this code). Looks up the most-recently-inserted `active` loyalty redemption for the same member+workspace — the successor code that the completed regen minted — and re-invokes the coupon apply against that successor code without calling `spendPoints` again. If the successor apply succeeds, the caller sees an ordinary success result, so a verify-fail→retry can converge on a clean apply without a second spend. Returns a well-formed `ActionResult` so the handler can `return await …` directly. Exported for unit testing the fallback logic.

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

- **`redeem_points` → `apply_loyalty_coupon` is an atomic pair: both succeed (coupon lands + points spent) or neither (points intact).** The executor enforces two mechanisms: (1) **code threading fallback** — `substituteActionParams` (exported). When the next action is `apply_loyalty_coupon` and its `code` is missing / empty / unsubstituted, the executor threads the `couponCode` from a prior successful `redeem_points` result directly; (2) **rollback on apply failure** — `rollbackLoyaltyRedemptionOnApplyFailure` (exported). If the apply handler failed (or self-heal gave up), the executor re-credits the `points_spent` to the member via an `adjustment`-type row in `loyalty_transactions`, flips the `loyalty_redemptions` row from `active` → `rolled_back`, and emits a `[Rollback]` system note for the audit trail. The contract is documented in [[../libraries/loyalty]]; tests are in `src/lib/action-executor.atomic-redeem-apply.test.ts` (11 tests, in-memory fake admin). Precedent: ticket `0a9e4d7f` (Judy — 1,500 points burned, `LOYALTY-15-HC6UFJ` never applied because the redeem→apply chain lacked the `{{coupon_code}}` template).

- **`apply_loyalty_coupon` is idempotent — Shopify verify-fail→retry never double-deducts.** The handler's self-heal path (when the original code is rejected by Shopify) regenerates a new code and retries the apply. Because retries can fire multiple times — a verify failure that triggers self-heal + a caller-level timeout → retry — the regen branch is guarded by `claimRegenSpendSlot(admin, workspaceId, origRedemptionId)` (exported). This atomic compare-and-set (via `.eq('status', 'active')` on the UPDATE) flips the original redemption to `expired` and returns `true` only on the first winner; all competing/retrying callers receive `false` and route to `replaySuccessorApply` instead, which applies the already-minted successor code WITHOUT calling `spendPoints` again. One applied coupon = exactly one 1,500-pt spend, no matter how many verify/heal retries fire (spec: loyalty-coupon-apply-self-heal-must-not-double-deduct-points Phase 2). Idempotency keys on the original discount code + member_id + workspace_id; two distinct coupon applies with different original codes still produce two legitimate spends. Tests: `src/lib/action-executor.apply-loyalty-coupon-double-spend.test.ts` (8 tests covering Susan's multi-retry patterns, verify the single-spend invariant + no-reentry guard + cross-workspace isolation).

- **Both direct-action handler-lookup sites (`executeActionsInline` and `handleDirectAction`) consult the [[../tables/action_handler_aliases]] catalog on a miss before falling through to `Unknown action type`.** The lookup is one-shot via [[action-handler-aliases]] `resolveAlias(ctx.admin, ctx.workspaceId, action.type)`; on a hit we sysNote `alias resolved: {source}→{target}`, rewrite `action.type` to the canonical handler key, and fire the handler as normal. That closes the silent-miss branch for Sonnet's `cancel_subscription` / `refund_partial` / `pause_subscription` / `resume_subscription` near-misses (seeded globally by the Phase-1 migration).

- **On a resolver miss the executor records the hit for admin review.** [[proposed-action-aliases]] `recordUnknownActionType` upserts a `(workspace_id, source_type)` row in [[../tables/proposed_action_aliases]] with a bumped `occurrences` and refreshed `last_seen` + most-recent `ticket_id`. Once `occurrences >= 3` and the row is still `pending`, a small Haiku call proposes a target from the passed-in `Object.keys(directActionHandlers)` list — validated against that same list before write so a hallucinated handler name cannot make it into the queue. The admin approves/declines at `/dashboard/settings/ai/handler-aliases`; the approve route dual-writes an [[../tables/action_handler_aliases]] row (workspace-scoped, `active=true`) so the very next hit resolves cleanly.

- **Order-creating actions route through the address resolver.** `create_replacement_order`, `create_order`, and all [[../libraries/commerce__order]] handlers ship to the customer's current canonical address via [[../libraries/customer-shipping-address]] `resolveCustomerShippingAddress()`—not a stale cited-order snapshot (ticket 49ddd6c4). Priority: override > `customers.default_address` > active subscription address > cited order address > most-recent order. When the cited order's address differs from the canonical current one chosen, a divergence note is logged so the move is never silent.

- **`direct_action` opens with the selective-clarify gate** ([[selective-clarify]] — Phase 2 of [[../specs/confidence-gated-problem-lockin-and-selective-clarify]]). Before `handleDirectAction` runs, `shouldClarify(decision)` intersects the decision's `actions[].type` with a workspace-scoped IRREVERSIBLE_SET (default `{partial_refund, cancel, bill_now, subscriptionOrderNow}`; overridable via a `slug='irreversible_actions'` [[../tables/policies]] row) and its `confidence` against a threshold (default `0.7`). On a hit we send a scoped confirmation-turn (`buildClarificationMessage`), stamp [[../tables/ticket_resolution_events]] `verified_outcome='clarified'`, and skip execution entirely. Sandbox mode bypasses the gate (its stamped-note dry-run is already non-destructive). This is the ~6% intersection the parent goal picks up — the alternative is the 38% blanket-clarify regime it rejects.

- **`create_order` / `create_subscription` open with an unconditional vaulted-PM guard** ([[../specs/assisted-purchase-playbook]] Phase 1). The guard reads [[../tables/customer_payment_methods]] for the customer (expanding [[../tables/customer_links]] siblings), keeps only `status='active'` rows via `pickChargeableVaultedPm`, and — on a miss — launches the [[../journeys/add-payment-method]] journey via [[journey-delivery]] `launchJourneyForTicket`, writes an internal `[System] {action} deferred — no vaulted payment method` note on the ticket, and returns `{ success: false, error: 'no_vaulted_payment_method', summary: '{action} deferred …' }` WITHOUT calling the commerce effector. Fail-closed and unconditional (no flag bypass) — a missing PM can never reach `createOrder` / `createSubscription`. Pinned by `action-executor.vaulted-pm-guard.test.ts`.

- **`executeSonnetDecision` returns `{ messageSent, escalated, closed, statusManaged }`.** The `workflow` case returns `statusManaged: true` (via `handleWorkflow`, which returns `true` only when a workflow actually ran) because the workflow executor sets the authoritative final status itself in `sendReply` ([[workflow-executor]]: `account_login` → closed, `return_to_sender` → open). The post-execute block in [[../inngest/unified-ticket-handler]] (`postExecuteStatusAction`) must leave a status-managed ticket untouched — do NOT copy the journey case's `messageSent = true`, which routes through `setStatus` and always forces `closed`, wrongly closing an intentionally-open workflow. (Ticket `a89dcf76` Mindy Freeman: `account_login` magic-link close was being reopened as "no customer message sent".) See [[../lifecycles/ticket-lifecycle]] Phase 5.

- **`update_line_item_price` and `partial_refund` no longer accept the agent's arithmetic as a sanctioned source for a price correction — the computed rate is the ONLY sanctioned source, and agents may TRIGGER a correction but not AUTHOR the number.** `update_line_item_price` resolves the subscription for `p.contract_id`, calls [[subscription-overcharge]] `detectOvercharge`, and hands the (signal + agentBase + projector) to `deriveRestoreBase` from the same module. When a signal names the target variant its `restore_base_cents` wins and `p.base_price_cents` is only logged; when no signal exists the handler refuses a raise, refuses an immaterial change (>= $1 AND >= 2%, the floor `detectForSubscription` uses at detection — the 2026-08-02 $0.01 catalog-drift failure mode), and confirms the projected realized via [[pricing]] `resolveSubscriptionPricing` so an internal sub's stacked quantity break can't overshoot the established rate. `partial_refund` clamps to the signal's per-unit-correct `delta` on over-ask (Sol's $5.18 refund vs the correct $15.01 was the failure), logs under-asks so a systematic under-refund is visible, and applies the same materiality floor whenever the action is claimed as overcharge remediation (signal present OR reason mentions "overchar"). Every successful line-price write emits a `customer_events` row (event_type=`subscription.line_price_changed`, exactly as the spec names it) carrying the previous realized per-unit, the new one, the source (`overcharge_signal` vs `agent_supplied`), the ticket id, and the raw signal + agent bases — the audit trail whose absence made the r.aycock $54.78 overwrite of a verified $44.96 restore invisible for a day. Every refused raise (either the no-signal `raise_no_signal` predicate or the signal path's `exceeds_established` guard) emits an `agent_message` [[../tables/dashboard_notifications]] row for the CEO — a price increase on an existing subscriber is a decision an objective-owner should see, per the CLAUDE.md north-star rule: hitting a rail escalates, it does not execute. Tests: `src/lib/subscription-overcharge.derive-restore-base.test.ts` pins the three verification scenarios (signal overrides agent · raise-no-signal refused · lower-no-signal allowed) purely — no live DB, the projector is a fixture. Spec: [[../specs/a-price-correction-must-use-the-computed-rate-not-an-agents-arithmetic]].

- **`change_quantity` is a self-swap — verified as an `add`, not as a `swap`.** The handler calls `subSwapVariant(_, _, variantId, variantId, quantity)` — old === new — because Appstle's `replace-variants-v3` is the only rail that touches a subscription line's quantity. Under the strict `swap` identity verdict (new present AND old absent) a self-swap can NEVER verify — the old variant IS the new variant, so it is always still on the contract. That false failure skips [[subscription-items]] `syncItemsAfterMutation` AND the `capturedUnitCents` grandfathered-price re-apply, silently resetting the customer's rate to catalog (Yvonne Carreon, 2026-08-05: $52.95 → $59.96 per box, only recovered by a manual `update_line_item_price`). [[subscription-items]] `identityExpectationForSwap` handles this at the verifier: `old === new` → verify as `{ kind: 'add', variantId, quantity }` (present at ≥ requested); genuine variant-to-variant swap keeps the strict `swap` verdict so the 2026-07-30 partial-apply defense holds. Spec: [[../specs/change-quantity-self-swap-false-fails-identity-verdict]].

- **Per-turn AI cost is stamped inline** into [[../tables/tickets]] `ai_cost_cents` at return time by `stampTicketAiCost(ctx, turnStartedAt)`. `turnStartedAt` is captured at the top of `executeSonnetDecision` before any downstream call that might write [[../tables/ai_token_usage]] (orchestrator, playbook compiler, sub-Haiku); the stamp sums rows where `ticket_id = ctx.ticketId AND created_at >= turnStartedAt`, converts tokens → cents via [[ai-usage]] `usageCostCents`, rounds to a whole-cent integer, and atomically increments through the `add_ticket_ai_cost(uuid, bigint)` SECURITY DEFINER RPC (migration `20260929120000`). Never throws — same "never fail the executor on a ledger error" invariant as the resolution-events stampers, so a network blip or a missing RPC pre-migration silently drops the delta rather than blocking the customer-facing reply. Feeds the Sol-economics analytics tile the spec's later phases add ([[../specs/sol-cost-csat-measurement-vs-pre-sol-baseline]] Phase 3).

---

[[../README]] · [[../../CLAUDE]]
