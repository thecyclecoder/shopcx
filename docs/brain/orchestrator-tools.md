# orchestrator-tools

What Sonnet can DO when handling a ticket. Two layers:

1. **Data tools** — read-only fetchers Sonnet calls on demand during deliberation (Pass-1: tool_use loop). Each returns formatted text it can reason over.
2. **Direct actions** — write mutations the action-executor runs after Sonnet returns its `SonnetDecision`.

This page is the agent-readable catalog. The runtime source of truth is `buildToolDefinitions()` in `src/lib/sonnet-orchestrator-v2.ts` (tools) + `directActionHandlers` in `src/lib/action-executor.ts` (actions).

## Data tools — what Sonnet can read

Sonnet decides which to call based on the customer message. Minimal pre-context is loaded; everything else is on-demand to keep the model focused.

| Tool | When Sonnet calls it | What it returns |
|---|---|---|
| `get_customer_account` | Account questions (subs, orders, billing, loyalty) | Subscriptions, last 3 orders, loyalty points + unused coupons, linked accounts, grandfathered-pricing detection. RECENT ORDERS lines surface a **computed per-unit realized price** (`line total ÷ qty`, rounded to the cent — the model never divides MSRP-ish `price_cents` by hand) alongside the **resolved product variant / flavor** from `products.variants[].title` on the matched `variant_id` — so Sleep Gummies shows `(variant: Berry)` instead of forcing the model to infer it. See [[libraries/sonnet-orchestrator-v2]] § Gotchas → RECENT ORDERS line surface. |
| `get_customer_timeline` | "When did X happen?" / sequence-of-events questions | Chronological `customer_events` log — portal actions, sub mutations, journey responses |
| `get_product_knowledge` | Product / policy questions | Product catalog + descriptions, all macros with body text, KB article matches via RAG. An **active OOS crisis overrides a stale positive `inventory_quantity`** — a crised variant moves to the OUT OF STOCK list with its `expected_restock_date`, never the available-flavors list. |
| `get_product_nutrition` | **Nutrition questions** — calories/sodium/potassium/sugar/carbs/protein/caffeine amount, ingredient dosages, "supplement facts", macros, diet fit (keto/low-sodium/…) | Per-variant Supplement Facts from `product_variants.supplement_facts` (serving size, servings/container, each nutrient + %DV, proprietary blend, footer notes, other ingredients), grouped by product → flavor. Only variants with **populated** facts appear; if a product isn't listed we have no verified facts (the tool says so — don't guess). Same column the storefront panel + KB mirror use. |
| `check_inventory` | **Missing item / "didn't receive X" / "is X in stock" / before promising a reship** | Per-variant on-hand qty + in-stock vs OUT OF STOCK for matches, plus a full out-of-stock list with restock dates (`crisis_events`). Treats qty ≤ 0 as OOS even if Shopify's `available` flag is stale. **An active OOS crisis is authoritative and forces OUT OF STOCK regardless of a stale positive qty** (matched by Shopify variant id → SKU → product title) — the row is flagged "inventory count is not authoritative" with the restock date, so the AI never claims a crised SKU is back in stock or promises its reship (ticket 9a7f9481). **Covers single-SKU products that `get_product_knowledge` hides** (it skips the variant list for 1-variant products). Excludes virtual products (shipping protection). |
| `get_returns` | Return / exchange / refund status | Return requests with status, items, tracking, refund amount |
| `get_fraud_cases` | Fraud-flag questions or when behavior looks suspicious | Fraud case rows, severity, rule that triggered |
| `get_crisis_status` | Crisis tags on ticket or OOS mentions | Crisis tier responses, swap options, coupon info, pause/remove status |
| `get_chargebacks` | Disputes, unauthorized charges | Chargeback events with reason, status, amount |
| `get_email_history` | "Didn't receive email" questions | Last 10 email events with open/click/bounce status |
| `get_dunning_status` | Payment failures, billing issues | Dunning cycles, payment failure attempts |
| `get_payment_methods` | "Update my card", payment method questions | Payment methods from Shopify, deduped by last4+expiry |
| `get_order_refund_ledger` | **Refund-amount dispute · "how much can I still refund?" · out-of-band refund suspected · before quoting/proposing a refund** | LIVE Shopify transaction ledger for ONE order (arg: `order_number`), reconciled against `public.order_refunds`: `saleCents`, `refundedCents`, `pendingCents`, `refundableCents` (max(0, sale − refunded − pending) — the CEILING for a new refund), `outOfBandCents` (settled Shopify refunds NOT in our local mirror — someone refunded outside ShopCX). Backed by [[libraries/refund-ledger]] `getOrderRefundLedger`. `outOfBandCents > 0` is the exact signal that would have resolved SC133086 (2026-07-20) at first touch. |

Pre-loaded context (no tool call needed): customer name + email, ticket tags (includes crisis tags), conversation history (last 8 messages + action completion notes), available handler names (journeys, playbooks, workflows), AI personality.

Two-bucket reasoning: account question → `get_customer_account` first; product/policy question → `get_product_knowledge` first. If first bucket doesn't have the answer → try the other. If neither → escalate (genuine knowledge gap).

**Missing-item triage:** for "an item is missing from my order" / "I didn't receive X", call `check_inventory` before offering a reship — an out-of-stock item is omitted from fulfillment (and not charged), so the right answer is to *explain that*, not promise to "make it right." This was added after a missing **ACV Gummies** ticket got a hollow acknowledge-and-close: the product is a single-SKU item at qty 0, which `get_product_knowledge` never surfaced (it skips the variant list for 1-variant products). `check_inventory` exists precisely to close that blind spot.

## Direct actions — what Sonnet can do

Sonnet returns `{action_type, actions: [...]}` with the action type and params; the action-executor dispatches via `directActionHandlers`. Per the [[operational-rules]] § Orchestrator discipline rule, **Sonnet returns IDs only** — hardcoded code paths fetch + validate + execute.

### Subscription mutations
- `pause` — pause indefinitely (alias of `pause_timed`; defaults to 30 days)
- `pause_timed` — pause + schedule resume via [[inngest/portal-auto-resume]]. **`pause_days` is 30 or 60 ONLY** — never 14/90/other. The value is coerced with `Number()` before the guard, because the orchestrator and journey configs carry it as a string (`"60"`); a strict `=== 60` against the string silently rejected a valid 60-day request (Susan Maex, 2026-06-12). The matching `sonnet_prompts` rule tells the agent to only ever *offer* 30 or 60.
- `resume` — un-pause active
- `skip_next_order` — advance `next_billing_date` by one cycle
- `change_frequency` — update billing interval
- `change_next_date` — set explicit next billing date
- `bill_now` — fire an immediate Appstle billing attempt (charge the current upcoming order right away; flavor-aware — internal subs fire the Braintree renewal pipeline, Appstle subs attempt the upcoming Appstle billing via `subscriptionOrderNow` / `orderNowByContract`). Selective-clarify covers it: at confidence < 0.7 the executor inserts a confirm-first turn before the charge fires.
- `order_now` — customer-facing name for `bill_now` — SAME `subscriptionOrderNow` charge. Registered as its own key in `directActionHandlers` because the portal handler (`src/lib/portal/handlers/order-now.ts`) and `portal/mutation-guard.ts` both name the capability `order_now`, so the orchestrator/Sol sometimes emit that name; without the entry the emission landed on "Unknown action type" and the model rationalized the miss as "no bill_now action exists for non-emergency requests" (ticket 0a9e4d7f, Judy — the incident this fix retires). **Always reachable for any active sub** — never emergency-only, never crisis-only. The orchestrator prompt's `ORDER-NOW / BILL-NOW IS ALWAYS REACHABLE` hard rule forbids the "doesn't exist" claim. Selective-clarify covers `order_now` on the same threshold as `bill_now`.
- `reactivate` — reactivate a cancelled sub
- `add_item` / `remove_item` / `swap_variant` / `change_quantity` — line-item mutations (RECURRING lines — an `add_item` recurs every renewal)
- `add_one_time_gift` — add a **one-time** item to the sub's NEXT renewal that ships once then drops off (never recurs). This is the "add a frother as a gift with my next order" / "add a bag to my next order" mechanism (the [[libraries/sol-outcome-claim-guard|add_bag_to_next_order]] outcome kind's executor). `free` defaults **true** (a $0 goodwill gift — `is_gift`); set `free:false` + `base_price_cents` for a paid one-time add-on. Internal-aware via [[libraries/subscription-items]] `subAddOneTimeGift`: internal subs get a native one-time line (`one_time_next_renewal:true` — the [[inngest/internal-subscription-renewals]] engine drops it after the order ships); Appstle subs use `replace-variants-v3` `newOneTimeVariants`, and a free gift that **can't be confirmed as $0 is rolled back** (a gift never silently charges — caller falls back to a $0 gift order). Do NOT use `add_item` for a next-order gift — that recurs.
- `update_line_item_price` — price override (see [[recipes/change-line-item-price]] for the 25% Subscribe-&-Save baked-in math)
- `apply_coupon` / `remove_coupon` — discount management
- `apply_loyalty_coupon` — apply a previously-redeemed loyalty code

### Order mutations
- `partial_refund` — Shopify partial refund (or Braintree-direct fallback for the new internal-checkout path)
- `create_return` — initiate a return via [[lifecycles/return-pipeline]] (EasyPost label + `returns` row)
- `create_replacement_order` — free draft order, $0 via 100% PERCENTAGE discount
- `update_shipping_address` — update address on a pending order

### Loyalty
- `redeem_points` — spend points to generate a Shopify discount code
- `redeem_points_as_refund` — apply points value as a refund instead of a coupon

**One coupon per order — never offer to "redeem all points."** Only one coupon applies per order (and one per subscription renewal), so redeeming a big balance into many codes mints coupons the customer can't stack — pointless, and "9 codes for all your points" reads as absurd. When a customer asks to redeem all their points, explain one-coupon-per-order and offer the single **highest tier they can afford** (e.g. 1,500 pts → $15), then redeem just that one. Enforced in the orchestrator's loyalty context (`sonnet-orchestrator-v2.ts`), which lists the tiers + this rule.

### Customer
- `update_customer_info` — name / phone / email updates
- `link_account_by_email` — confirm an account link
- `reject_account_link` — record a customer-rejected link suggestion (never re-offer)
- `unsubscribe_email_marketing` / `unsubscribe_sms_marketing` / `unsubscribe_all_marketing` — marketing consent flips via Shopify
- `marketing_signup` — sign up for email + SMS marketing
- `reassign_ticket_customer` `{to_customer_id, reason}` — **Improve-only** (not a Sonnet runtime action). Re-points `tickets.customer_id` to the correct customer for the typo'd / duplicate-account case, recording a from→to internal note. See [[libraries/improve-actions]].
- `send_magic_link` `{}` — **Improve-only**. Mints a portal login link via `generateMagicLinkURL` for the ticket's **current** customer and emails it to that customer's **on-file address only** (no free-text recipient — account access never goes to an arbitrary inbox). Pair it *after* `reassign_ticket_customer` in one plan so the link resolves to the corrected account. See [[libraries/magic-link]].
- `link_customer_accounts` `{primary_customer_id, duplicate_customer_id, reason}` — **Improve-only**. The **root-cause** fix for the duplicate/typo'd-account mess: links the duplicate **empty shell** into the real account (one `customer_links` group) so future tickets + magic links resolve to one identity. **Highest blast-radius:** (1) **founder-gated** — only the workspace `owner` can approve it (the Improve route 403s any other role; the agent_todo path is owner/admin-only); (2) the executor enforces the **empty-shell heuristic** on every path — it refuses unless `duplicate_customer_id` is a clear empty shell (0 orders / 0 subs / 0 loyalty points), so two real accounts are never auto-merged. See [[libraries/improve-actions]].

### Payment
- `switch_payment_method` — change the default card on a sub
- (new-card recovery is webhook-driven; see [[lifecycles/dunning]])

### Crisis (see [[lifecycles/crisis-campaign]])
- `crisis_pause` — pause sub due to crisis (auto-resume on resolution)
- `crisis_remove` — remove the affected item but keep the sub running
- `crisis_enroll` — enroll a sub in an active crisis campaign
- `crisis_set_auto_readd` — toggle the auto-readd-on-resolution flag

### Ticket
- `close_ticket` — explicit close (e.g. OOO auto-reply handling); `_closedThisRun` flag set so the post-execute path doesn't reopen
- `deactivate_ticket` — soft-deactivate (used for system-generated tickets that don't need a human reply)

### Action types vs handler dispatch

`SonnetDecision.action_type` is one of:
- `direct_action` — execute the actions array immediately (above handlers)
- `journey` — launch a journey by name OR trigger_intent
- `playbook` — start a playbook (lookup by name OR trigger_intents)
- `workflow` — run a workflow (lookup by name OR trigger_tag OR template)
- `macro` — send Sonnet's personalized macro response
- `kb_response` / `ai_response` — send Sonnet's generated response
- `escalate` — assign to agent, send holding message

Per the [[operational-rules]] § Orchestrator discipline rule, the **confirmed-fraud gate runs BEFORE the orchestrator** — any matched customer with `fraud_cases.status='confirmed_fraud'`, an `amazon_reseller` flag, or a known-reseller address short-circuits to escalate before any of the above fires.

### Improve parity — the CX co-pilot uses the SAME executor

The box-hosted ticket **Improve** tab can do **anything the orchestrator can** to a customer, through this exact `executeSonnetDecision` path — not a parallel executor. The box proposes an approval-gated `orchestrator_action` plan kind carrying a typed `SonnetDecision`; on approval [[libraries/improve-plan-executor]] builds an `ActionContext` from the ticket (`workspaceId`, `ticketId`, `customerId`, `channel` from `tickets.channel`) and calls `executeSonnetDecision`, so journeys/playbooks/workflows/macros/escalate + every direct action run with production-correct portal/email/chat/sms delivery ([[libraries/ticket-delivery]] is the per-channel sink — portal-aware, unlike the old `send_message`). The hand-rolled direct-action cases in [[libraries/improve-actions]] now delegate to the shared `directActionHandlers` registry — **one customer-action code path** (CLAUDE.md North star + "identical ticket messages"). Same path `scripts/apply-coupon-via-executor.ts` drives one-off. Built by `improve-orchestrator-action-parity` (2026-06-20).

A few customer actions are **Improve-only** and live as bespoke cases in [[libraries/improve-actions]] (no Sonnet-runtime equivalent — the conversation orchestrator never re-points a ticket, re-sends a login link, or merges accounts): `reassign_ticket_customer`, `send_magic_link`, and `link_customer_accounts` — the account-repair set for the duplicate/typo'd-account login mess (Mindy Freeman `a89dcf76`). They live OUTSIDE `directActionHandlers` and are dispatched through the shared `runImproveOnlyAccountAction` so the Improve tab **and** the escalation-triage `customer_action` todo executor ([[lifecycles/agent-todo-system]], `agent-todos/execute.ts`) run identical logic — one code path. Same approval gate (the box **proposes** a `customer_action` plan, the founder/CX manager approves, the route executes). `send_magic_link` is account-access-sensitive, so it always targets the ticket's **current** on-file customer email and runs *after* `reassign_ticket_customer` in the same plan. `link_customer_accounts` is **founder-gated** (owner-only) + empty-shell-guarded. The **escalation-triage solver** now auto-detects the duplicate-account pattern and proposes this set ([[box-escalation-triage]]). Built by `improve-account-fix-actions` P1 + P2 (2026-06-20).

## Related

[[lifecycles/ai-multi-turn]] · [[lifecycles/ticket-lifecycle]] · [[libraries/sonnet-orchestrator-v2]] · [[libraries/action-executor]] · [[libraries/improve-plan-executor]] · [[libraries/improve-actions]] · [[libraries/ticket-delivery]] · [[customer-voice]] · [[operational-rules]] · [[tables/sonnet_prompts]] · [[recipes/change-line-item-price]] · [[recipes/issue-replacement]]
