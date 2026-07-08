# Cancel flow

When a customer asks to cancel, we never just cancel. The Sonnet orchestrator routes the message to the cancel journey, which presents AI-selected retention remedies — coupons, pauses, frequency changes, swaps, free products — and only cancels if the customer declines them all. This page traces the flow from "cancel intent detected" to either "saved" or "cancelled," with all the database-driven config + AI selection + execution paths.

## Cast

- Detection: [[../inngest/unified-ticket-handler]] + [[ai-multi-turn]] (Sonnet sees `j:cancel` in trigger_intents and routes).
- Journey build: `src/lib/cancel-journey-builder.ts` + `src/lib/journey-step-builder.ts`.
- AI remedy selection: `src/lib/remedy-selector.ts` (Haiku) + open-ended chat (Sonnet, max 3 turns).
- Customer-facing: `/journey/{token}` mini-site, embedded chat forms, customer portal.
- Subscription mutations: [[../integrations/appstle]] (cancel, pause, skip, frequency-change, apply-discount).
- State: [[../tables/journey_sessions]], [[../tables/journey_step_events]], [[../tables/remedies]], [[../tables/remedy_outcomes]], [[../tables/coupon_mappings]].
- Config: [[../tables/workspaces]]`.portal_config.cancel_flow.reasons` + [[../tables/remedies]] table.
- Social proof: [[../tables/product_reviews]] (synced from [[../integrations/klaviyo]]).

## Why journeys, not direct cancels

Sonnet's rule pack ([[../tables/sonnet_prompts]]) has a hard rule: cancel requests ALWAYS route to the cancel journey. Save actions = just do it. Cancel = route to journey. The reasoning: cancellation is the most retention-sensitive moment we have. Anyone who got far enough to ask deserves a tailored save attempt, and that requires the journey's structured offer-and-track loop, not a one-shot AI improvisation.

## Phase 1 — intent detection

Sonnet sees the inbound message + the orchestrator's pre-context. The cancel-journey [[../tables/journey_definitions]] row has `match_patterns: ["cancel", "cancellation", "unsubscribe", "stop subscription", "end subscription"]` and `trigger_intent: "cancel_subscription"`. The orchestrator returns:

```json
{
  "action_type": "journey",
  "handler_name": "cancel_subscription",
  "response_message": "Sure — let me help you with that.",
  "reasoning": "Cancel intent."
}
```

`src/lib/action-executor.ts` matches `handler_name` against [[../tables/journey_definitions]].`name` and `trigger_intent` (case-insensitive) → finds the cancel journey → calls `launchJourneyForTicket()`.

## Phase 2 — journey session

`launchJourneyForTicket()` in `src/lib/journey-launcher.ts`:

1. Pulls the customer's [[../tables/subscriptions]] (active + paused) across linked accounts.
2. Inserts a [[../tables/journey_sessions]] row with token, `journey_definition_id`, `customer_id`, `ticket_id`, and a subscription id if there's exactly one. If 0 active subs → bail with a "you don't have any active subscriptions" message. If multiple → first step is subscription selection.
3. Builds the steps via `src/lib/cancel-journey-builder.ts` — see below.
4. Delivers based on channel (`src/lib/journey-delivery.ts`):
   - email / help_center → CTA email through [[../integrations/resend]] threaded into the existing Gmail conversation (using `email_message_id`).
   - chat → embedded multi-step form rendered by the widget.
   - SMS / Meta DM → plain text + URL link.
   - social_comments → **never**. Hard rule.

The customer-facing artifact is the mini-site at `/journey/{token}` — same render path as email. Steps are rebuilt live on every click, never persisted.

**The orchestrator NEVER pre-binds a subscription for the cancel journey.** Subscription selection is code-driven: the builder shows the picker when the customer has >1 sub and auto-selects when there's exactly 1 (`cancel-journey-builder.ts`). For non-cancel journeys (pause, skip) the orchestrator may still resolve a `subscription_id` from the action's `contract_id`, but for cancel it deliberately passes none (`action-executor.ts` `handleJourney`, `isCancelJourney` guard). Pre-binding would skip the picker (`api/journey/[token]/route.ts:82`), and the old `find(a => a.contract_id)` grabbed the contract from *any* emitted action — including a side action (e.g. `remove_item`) on a *different* sub — which once silently ran a cancel against the wrong subscription (ticket 178ae5a7). Letting the AI choose the cancel target is a Goodhart trap; the code-driven picker owns it.

## Phase 3 — steps

`src/lib/cancel-journey-builder.ts` is the single source of truth. Other code delegates here (see `src/lib/journey-step-builder.ts`).

### Step 1 — subscription selection (skip if only one)

Collapsible cards from `getCustomerSubscriptions()`. Each card shows:

- Product list (from `subscription.items` JSONB).
- Frequency + next billing date.
- Total monthly price.
- Shipping protection as a green badge, NOT a line item.

For first-renewal subs (`subscription_age_days < billing_interval_days`), the card shows "Your first shipment" instead of a renewal date to avoid payment anxiety.

### Step 2 — cancel reason

Reasons come from [[../tables/workspaces]]`.portal_config.cancel_flow.reasons` (managed in Settings → Cancel Flow). Each reason:

- `slug` (e.g. `too_expensive`, `too_much_product`, `just_a_break`)
- `label` (customer-facing)
- `type` — `remedy` (show AI-selected remedies) or `ai_conversation` (open Sonnet chat).
- `sort_order`, `enabled`, `suggested_remedy_id` (optional override).

If the settings array is empty, the step renders empty. There are no hardcoded defaults — admin must configure.

### Step 3 — remedies OR AI chat

#### `type='remedy'`

The browser POSTs to `/api/journey/{token}/remedies` → `src/lib/remedy-selector.ts` selects top 3 remedies via Claude Haiku.

The Haiku call gets:

- Customer LTV, retention score, subscription age.
- First-renewal flag.
- All [[../tables/remedies]] for the workspace (with their type-specific config — coupon_mapping_id, pause_days, skip_count, frequency_interval, product_variant_id).
- Per-(reason, remedy) historical acceptance stats from [[../tables/remedy_outcomes]] (per-reason if 200+ data points, else global).
- The customer's cancel reason slug.

Haiku returns three remedy ids ranked by predicted save probability. The mini-site renders the three options + a "No thanks, please cancel" button.

Below the remedies, a social-proof review from [[../tables/product_reviews]] (Klaviyo-synced) — AI-summarized to ≤ 15 words, with a "Read full review" expand.

#### `type='ai_conversation'`

Opens Sonnet-driven empathetic chat (`/api/journey/{token}/chat`) — max 3 turns. Used for open-ended reasons like "just need a break" / "reached goals" / "something else." Sonnet may surface a remedy mid-conversation or just acknowledge + advance to the confirm step.

Used as a deferral mechanism — Sonnet's job isn't to debate, it's to validate the customer's feeling and offer one tailored remedy if it fits.

### Step 4 — execute remedy (if accepted)

If the customer picks a remedy, action executor handles it by type:

- **`coupon`** — `applyDiscountWithReplace()` ([[../integrations/appstle]] `subscription-contracts-apply-discount`, removes any existing first via [[../tables/coupon_mappings]] lookup). One coupon per sub — never stack. Grandfathered-pricing subs are blocked from sale coupons (loyalty OK).
- **`pause`** — `appstleSubscriptionAction("pause")`. Schedule auto-resume via [[../inngest/portal-auto-resume]] at `pause_resume_at = now() + config.pause_days`.
- **`skip`** — `appstleSkipNextOrder()`. Disabled in production (see project_appstle_disabled_features) — Appstle's skip endpoint is unreliable.
- **`frequency_change`** — `appstleUpdateBillingInterval()`.
- **`free_product`** — `appstleAddFreeProduct()`.
- **`line_item_modifier`** — Multi-step frontend flow (add/remove/swap items via `src/lib/subscription-items.ts`).

The remedy outcome is written to [[../tables/remedy_outcomes]] with `outcome='accepted'`, `cancel_reason`, `subscription_id`, `first_renewal`, `session_id`. Feeds future Haiku selection.

#### Internal subs (`is_internal = true`)

Remedy execution does **not** branch on sub type at the call site. Each `appstle*` helper (and `applyDiscountWithReplace`) checks `isInternalSubscription()` at the top and, if true, delegates to the matching `internal-subscription.ts` function (same signature + return shape). So coupon, pause/cancel/resume, frequency_change, free_product, and line_item_modifier all work on internal subs unchanged. Detection keys on `subscriptions.shopify_contract_id` — every internal sub has one (migrated subs keep the numeric Appstle id; native subs get a synthetic `internal-…` id), so the lookup never misses.

**`skip` is implemented as a reschedule.** Appstle's dedicated skip endpoint (`subscription-contracts-skip`) returns **405** and is unreliable (see project_appstle_disabled_features), so `appstleSkipNextOrder` does *not* call it. Instead it advances `next_billing_date` by one billing cycle — internal subs via `internalSubSkipNextOrder`, Appstle subs via the working `subscription-contracts-update-billing-date` endpoint (`appstleUpdateNextBillingDate`). Functionally identical to a skip, and works on both sub types. (Occasionally returns a transient "billing operation in progress" 400 if a charge is mid-flight — a retry-later condition, not a hard failure.)

### Step 5 — confirm cancel (if all remedies declined)

"Are you sure?" — not guilt-trippy, just a clean confirmation. Final cancel button.

On confirm:

- `appstleSubscriptionAction("cancel", reason=slug, cancelledBy=display_name)` via [[../integrations/appstle]] DELETE endpoint with `cancellationFeedback` + `cancellationNote`.
- Write [[../tables/customer_events]] `subscription.cancelled`.
- Update [[../tables/customers]] subscription_status if this was their last active sub.
- Tag the ticket `j:cancel`, `jo:negative`.
- Write `outcome='cancelled'` to [[../tables/remedy_outcomes]] for each remedy that was shown but not accepted (so we capture the missed-save signal).

## Phase 4 — outcome tags

Outcomes drive analytics. Tags applied:

- `j:cancel` always.
- `jo:positive` — customer accepted a remedy (saved).
- `jo:negative` — customer cancelled.
- `jo:neutral` — never used for cancel; the outcome is binary.

Outcome is set in `/api/journey/{token}/complete/route.ts` based on the final state.

## Phase 5 — re-nudge for declined

If the customer abandons mid-journey (clicks the CTA, sees the form, never submits), there's no re-nudge for cancel. The journey is opt-in — abandonment means they reconsidered.

Discount Signup journey has a re-nudge for declines. Cancel doesn't.

## DB-driven from end to end

- Cancel reasons: [[../tables/workspaces]]`.portal_config.cancel_flow.reasons`.
- Remedies: [[../tables/remedies]].
- Per-remedy historical performance: [[../tables/remedy_outcomes]].
- Coupon resolution: [[../tables/coupon_mappings]] (VIP tier-aware).
- Social proof: [[../tables/product_reviews]].
- Per-channel delivery rules: [[../tables/journey_definitions]]`.channels` array.

No remedy options, reasons, or coupons are hardcoded. AI selects from configured data; admins configure the data.

## Grandfathered pricing

Customers with sub prices below the workspace's `coupon_price_floor_pct` of MSRP get filtered out of coupon remedies entirely. They already have a good deal — adding a coupon underwater on top is policy-bad. Loyalty coupons are always allowed (separate tier system). See project_grandfathered_pricing.

## First-renewal aggressiveness

Customers who haven't renewed yet get more aggressive save offers (25-40% discounts, "extend your trial" framing). Detected via `subscription_age_days < billing_interval_days`. Tracked as `first_renewal=true` in [[../tables/remedy_outcomes]] so we can measure first-renewal save rate separately from steady-state.

## Portal path

When the customer clicks "Cancel subscription" from the customer portal, the same flow fires. `src/lib/portal/handlers/cancel-journey.ts` is the portal-side handler — it launches a journey session and returns the steps for inline rendering. Same builder, same remedy selector, same Appstle calls.

The customer-portal mini-app embedded in the Shopify storefront uses identical logic. See feedback_minisite_mirrors_chat — mini-site and live chat must produce identical human-readable ticket messages.

## Customer portal vs mini-site UX

- Mini-site (`/journey/{token}`): standalone, branded, mobile-friendly multi-step page.
- Customer portal: same multi-step UI embedded in the storefront under the customer's account tab.
- Live chat: same forms rendered inline in the chat widget.

All three produce the same [[../tables/ticket_messages]] rows + the same [[../tables/customer_events]] entries — the rendering differs but the audit trail doesn't.

## Files touched

| File | Purpose |
|---|---|
| `src/lib/journey-launcher.ts` | Single launcher (chat inline + email CTA) |
| `src/lib/cancel-journey-builder.ts` | THE cancel journey builder — steps + metadata |
| `src/lib/journey-step-builder.ts` | Switch that delegates to per-journey builders |
| `src/lib/remedy-selector.ts` | Haiku remedy selection + Sonnet open-ended chat |
| `src/lib/journey-delivery.ts` | Channel-aware delivery |
| `src/lib/journey-seed.ts` | Default remedies seed (DEFAULT_REMEDIES) |
| `src/lib/journey-tokens.ts` | Token generation + verification |
| `src/lib/appstle.ts` | All Appstle calls (cancel, pause, skip, frequency, discount) |
| `src/lib/appstle-discount.ts` | applyDiscountWithReplace (remove old → apply new atomically) |
| `src/lib/subscription-items.ts` | line_item_modifier flow |
| `src/lib/klaviyo.ts` | Reviews fetch for social proof |
| `src/lib/inngest/portal-auto-resume.ts` | Pause-auto-resume cron |
| `src/lib/ticket-tags.ts` | j:cancel / jo:* tags |
| `src/lib/portal/handlers/cancel-journey.ts` | Customer portal path |
| `src/app/journey/[token]/page.tsx` | Mini-site renderer |
| `src/app/api/journey/[token]/remedies/route.ts` | Haiku remedy selection endpoint |
| `src/app/api/journey/[token]/chat/route.ts` | Sonnet open-ended chat endpoint |
| `src/app/api/journey/[token]/complete/route.ts` | Final action execution |
| `src/app/api/journey/[token]/step/route.ts` | Per-step submission |

## Status / open work

**Shipped:** Cancel journey with Haiku remedy selection, customer-facing mini-site, Appstle subscription mutations, outcome tracking, social-proof reviews, open-ended Sonnet conversation — all functional end-to-end. Internal-sub support via the `isInternalSubscription()` delegation pattern (see Step 4 → Internal subs).

**Fixed 2026-06-15 (audit):**
- **Skip remedy 405.** `appstleSkipNextOrder` no longer calls Appstle's dead skip endpoint — it now reschedules `next_billing_date` forward one cycle (works for Appstle + internal). The "Skip next order" remedy was failing on every Appstle sub with a 405 (`customer_events.portal.error` → `remedy_action_failed`); now succeeds.
- **Admin dashboard skip.** `appstleSkipUpcomingOrder` now delegates to internal subs.
- **`subRemoveItem`** now checks internal *before* falling through to Appstle (a lineId-only call on an internal sub returns a clear error instead of hitting Appstle).

**Fixed 2026-06-19 (ticket 178ae5a7):**
- **Cancel journey no longer pre-binds a subscription.** `handleJourney` (`action-executor.ts`) now skips `subscription_id` resolution for cancel journeys (`isCancelJourney` guard) — selection is fully code-driven via the picker. Previously `find(a => a.contract_id)` could grab a side action's contract on a *different* sub, mis-bind the cancel session, and skip the picker. Jodi (ticket 178ae5a7) asked to cancel her Superfood Tabs sub but the journey bound to her Ashwavana sub (a concurrent `remove_item` was first in `actions[]`); she accepted a 20%-off save that landed on the wrong sub while the Tabs sub renewed full-price. Remedied: 20% refund on SC132928 + coupon removed from the Ashwavana sub.

**Fixed 2026-07-08 (ticket 472310cc):**
- **Refund-playbook pause step is skipped when the identified subscription is already cancelled.** A `pause_subscription`/`pause` step in the Refund playbook now routes through `decidePauseSubscriptionStep` in `playbook-executor.ts`: if the target sub's status is `cancelled`, the step advances with no action and no response (nothing for the step-level claim-guard to block); on active/paused the pause still fires with `backedActions: ["pause_timed", "pause"]`. Previously the step tried to pause an already-cancelled sub, the "I've paused your subscription" claim was unbacked, and the guard dead-ended the run in escalation. See [[../playbooks/refund]] § Communication rules.

**Known gaps / open work:**
- **Internal-sub billing/dunning not wired.** `appstleAttemptBilling` / dunning have no internal path (Braintree renewal scheduler not built — see `internal-subscription.ts` stubs). Internal subs don't generate Appstle billing attempts, so this isn't reached in normal flow, but bill-now / dunning admin paths assume Appstle.

**Recent activity:**
- `a6844aaa` CSAT: resolution-gate survey + cron-driven send + dashboard (cross-system)
- `12f954ff` docs/brain: lifecycles/ — 12 narrative pages tracing key flows end-to-end

**Open questions:** Wire a Braintree renewal scheduler so internal-sub billing/dunning works (currently stubbed).

## Related

[[ticket-lifecycle]] · [[ai-multi-turn]] · [[../integrations/appstle]] · [[../integrations/anthropic]] · [[../integrations/klaviyo]] · [[../tables/journey_definitions]] · [[../tables/journey_sessions]] · [[../tables/remedies]] · [[../tables/remedy_outcomes]] · [[../tables/coupon_mappings]] · [[../tables/product_reviews]] · [[../inngest/portal-auto-resume]] · [[../journeys/cancel]]
