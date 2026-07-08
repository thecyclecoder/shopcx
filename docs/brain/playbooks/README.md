# Playbooks

Structured decision trees that guide BOTH AI and human agents through complex customer issues. They combine deterministic policy logic with AI-generated communication, ensuring consistent resolution regardless of who handles the ticket.

Settings → Playbooks (own settings card, not under AI).

See [[../playbooks/README]] for the full data model and [[../playbooks/README]] for the universal communication patterns that apply across playbooks.

## Active playbooks

| Playbook | Slug (`playbooks.slug`) | Trigger intents | Description |
|---|---|---|---|
| [[refund]] | `refund` | refund_request, return_request, money_back, 30_day_guarantee, unwanted_charge, subscription_dispute, charged_without_permission, unauthorized_charge | Handles customers who were charged for a subscription renewal they didn't expect or want |
| [[replacement-order]] | `replacement-order` | missing_items, not_received, damaged_items, where_is_my_order, expired_items | Order replacement for delivery errors, missing/damaged items, wrong addresses |

The Missing / Lost Order playbook exists in the DB (`is_active=false`) — folded into [[replacement-order]].

**Slug column.** Every playbook row carries a `slug` (URL-safe identifier, unique per workspace). Sol names it on the Direction (`ticket_directions.plan.playbook_slug`) when she picks `chosen_path='playbook'` at first-touch — the writer at [[../libraries/ticket-directions]] `writeDirection` looks it up and rejects unknown slugs there, not at executor step 0. See [[../specs/sol-session-chosen-playbook-selection-retire-brittle-triggers]] Phase 1.

## Data model

```
playbooks                 — playbook header + global tunables (exception_limit, stand_firm_max)
├── playbook_steps        — step_order + type + name + instructions + config
├── playbook_policies     — name + description + conditions JSONB + ai_talking_points + sort_order
└── playbook_exceptions   — tiered carve-outs per policy; conditions JSONB; resolution_type; tier
```

The orchestrator picks a playbook by matching `trigger_intents` (case-insensitive) OR `trigger_patterns` keywords against the inbound message + Sonnet's intent classification.

[[../tables/playbooks]] · [[../tables/playbook_steps]] · [[../tables/playbook_policies]] · [[../tables/playbook_exceptions]] · [[../tables/playbook_simulations]]

## Lifecycle of an active playbook

```
Customer message → orchestrator picks playbook → playbookExecutor.start()
                                                   │
                                                   ▼
                                       tickets.active_playbook_id = pb.id
                                       tickets.playbook_step = 0
                                       tickets.playbook_context = {}
                                                   │
                                                   ▼
                                       Run step 0 — usually identify_order
                                                   │
                                                   ▼
                                       Each new inbound message routes to
                                       playbookExecutor instead of Sonnet
                                                   │
                                                   ▼
                                       Step types decide whether to advance,
                                       launch a journey, propose an exception,
                                       stand firm, or terminate
```

Playbook ownership of the ticket persists until a terminal step fires: refund applied, replacement order created, customer cancelled mid-flow, agent intervened, or stand-firm limit hit.

### Manual apply (agent applies a playbook from the dashboard)

`POST /api/tickets/[id]/apply-playbook` sets `active_playbook_id` + `playbook_step=0` + `playbook_context` (with the agent's free-text context inserted as an internal inbound message), then **kicks step 0 by firing `ticket/inbound-message` with `message_body:"playbook-apply"`** (a sentinel the [[../inngest/unified-ticket-handler]] routes straight to the executor — see its sentinel short-circuit). Without that event the playbook just sits at step 0 until the customer next replies.

> **Gotcha (fixed 2026-06-17, ticket 23fe617c):** that trigger event must be sent via the `inngest` SDK client (`inngest.send`), NOT a raw `fetch` to `https://inn.gs/e` with an `Authorization: Bearer` header. The `/e` endpoint (no key in path) returns **HTTP 404** — Inngest's event API wants the key in the URL *path* (`/e/<key>`). The old raw-fetch call 404'd on every apply and the error was swallowed by a bare `catch`, so manually-applied playbooks never triggered a step run (Katherine's Refund playbook sat at step 0 until the event was re-fired correctly). If an applied playbook isn't advancing, re-fire `ticket/inbound-message` / `message_body:"playbook-apply"` via the SDK.

## Step types

Common across playbooks (`playbook_steps.type`):

| Step type | What it does |
|---|---|
| `identify_order` | Disambiguate which order the customer is asking about |
| `identify_subscription` | Disambiguate which sub. Uses [[../journeys/select-subscription]] if multiple. |
| `check_tracking` | Call EasyPost / Shopify tracking; classify as delivered / in_transit / lost |
| `classify_issue` | Sonnet classifies the customer's exact complaint into a sub-category |
| `select_missing_items` | Launch [[../journeys/missing-items]] |
| `confirm_shipping_address` | Launch [[../journeys/shipping-address]] |
| `check_other_subscriptions` | See if customer has other active subs (re-frames offers) |
| `apply_policy` | Sonnet explains the policy via timeline / brief format |
| `offer_exception` | Tier-up — propose an exception (refund without return, store credit, etc.) |
| `stand_firm` | Customer declined the exception; restate the position |
| `initiate_return` | Launch [[../lifecycles/return-pipeline]] via `createFullReturn()` |
| `create_replacement` | Build a Shopify draft order via [[../lifecycles/return-pipeline]] adjacent logic |
| `cancel_subscription` | Launch [[../journeys/cancel]] |
| `adjust_subscription` | Frequency / next-date / item modifier mutations |

## Universal communication patterns

From [[../playbooks/README]]. Applies to ALL playbooks regardless of issue type.

### Human touch

- **First AI message** on a ticket — introduce by name: "Hi, I'm Suzie and I'm here to help you resolve this right away." Name comes from `ai_personalities.name` linked to the channel.
- **Every sign-off** — personality's `sign_off` field, e.g. "- Suzie, Customer Support at Superfoods Company."
- **No re-greeting** — only greet once on the very first message.

### Customer-facing formatting

- **Never show technical IDs** — no order numbers (`SC127106`), no contract numbers (`#27855388845`). Refer by date + amount: "your April 4th order for $5.87." Log internal IDs in system notes.
- **Order lists for identification** — clean HTML, bold dates, bulleted items:
  ```html
  <p><b>April 4th</b> - $5.87</p>
  <ul><li>Creatine Prime+</li><li>Ashwavana Guru Focus</li></ul>
  ```
- **Messages get shorter as the conversation progresses** — first policy explanation is detailed; exception offers are one paragraph with math; stand firm is one paragraph restating offer; final stand firm is one sentence.

### Cancel detection (global)

After step 2 (subscription identified), cancel detection is **always active**. If the customer mentions cancel at any point:

1. Pause the playbook (keep state, don't clear).
2. Check subscriptions:
   - All cancelled → "Your subscription is cancelled. No more orders will be sent."
   - One active → launch [[../journeys/cancel]] mini-site.
   - Multiple active → launch cancel for the identified sub, then ask about others.
3. After cancel journey completes, confirm result.
4. **Don't mention the refund.** Wait for customer to bring it back up.
5. If customer replies about refund → playbook resumes from where it paused.

### Policy explanation

**First time** — timeline format from real data (subscription `created_at`, order dates, [[../tables/customer_events]] for portal actions):
```html
<p><b>March 25</b><br>You checked out and selected subscribe-and-save. Your first order shipped + a recurring subscription was set up to renew in 4 weeks.</p>
<p><b>April 4</b><br>Your renewal order processed.</p>
```

**After cancel journey resumes** — brief + policy link: "Our policies (link) state that renewal orders aren't eligible for return. I can confirm your subscription is cancelled."

### Pre-exception stand firm

Brief statement + policy link. No hints at future offers.

- NEVER hint at future offers or escalations.
- NEVER say "let me check" or "let me review."
- NEVER ask what the customer would prefer.
- Just restate the policy position with the link.

### Exception offers

One paragraph, exact breakdown ("$5.87 store credit"), direct yes/no question. See feedback_exception_offer_format.

### Between-tier stand firm

Restate offer with policy contrast for perceived value: "Our policies don't allow refunds on renewals, but I can offer you a store credit if that works for you?" See feedback_stand_firm_after_exception.

### Never repeat context

After the first mention, never repeat order details, subscription info, or timeline. Each subsequent message gets shorter. See feedback_never_repeat_context.

### Return failure → escalate, don't close

Return / API failures leave the ticket OPEN, escalated to agent. Don't close. See feedback_return_failure_escalation.

## Disqualifiers

`playbooks.exception_disqualifiers` (JSONB array) — conditions that block exceptions:

- `previous_exception` — customer already got one before → blocks `exceptions_only` (in-policy returns still allowed).
- `has_chargeback` — customer has any chargeback → blocks `exceptions_only`.
- `has_chargeback_on_order` — chargeback on the SPECIFIC order being returned → blocks even `in_policy_return`.

`disqualifier_behavior`:
- `silent` — playbook proceeds without offering the blocked path; never mentions disqualification.
- `block_exceptions` — explicit "we can't offer an exception this time" wording.

> **Auto-grant removed 2026-06-03.** The `playbook_exceptions.auto_grant` + `auto_grant_trigger` columns are retained for backward compatibility but no longer drive any behavior. The original triggers (`duplicate_charge` / `cancelled_but_charged` / `never_delivered`) were stubbed for months; in practice the orchestrator (Sonnet) escalates these scenarios directly, and `never_delivered` is handled by the replacement flow. Removing the feature simplifies the executor.

## Skip stand-firm

`playbook_exceptions.skip_stand_firm` — when true, accepting this exception skips the stand-firm tier-up loop. Used for edge cases where standing firm would be customer-hostile.

## Files

| File | Purpose |
|---|---|
| `src/lib/playbook-executor.ts` | Step engine — picks playbook, runs steps, handles cancel detection + stand-firm |
| `src/lib/inngest/unified-ticket-handler.ts` | Routes inbound messages to playbook executor when `active_playbook_id` is set |
| `src/lib/sonnet-orchestrator-v2.ts` | Picks playbook by trigger_intents / trigger_patterns |
| `src/lib/action-executor.ts` | `startPlaybook()` initializer |
| `src/lib/improve-actions.ts` | Improve-tab actions for agent overrides on playbook tickets |
| `src/lib/improve-tools.ts` | Tools the improve tab exposes |
| `src/app/dashboard/settings/playbooks/page.tsx` | Settings UI for editing playbooks / steps / policies / exceptions |
| `src/app/api/playbooks/[id]/simulate/route.ts` | Dry-run simulator → [[../tables/playbook_simulations]] |

## Related

[[../README]] · [[../tables/playbooks]] · [[../tables/playbook_steps]] · [[../tables/playbook_policies]] · [[../tables/playbook_exceptions]] · [[../tables/policies]] · [[../tables/sonnet_prompts]] · [[../lifecycles/ticket-lifecycle]] · [[../lifecycles/ai-multi-turn]]
