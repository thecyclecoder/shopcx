# Refund

Handles customers who were charged for a subscription renewal they didn't expect or want. The most-fired playbook by volume — sub-renewal disputes are the dominant subscription-side conflict.

DB row in [[../tables/playbooks]]: `name='Refund'`, `priority=100`, `exception_limit=2`, `stand_firm_max=3`, `stand_firm_before_exceptions=2`, `stand_firm_between_tiers=2`, `disqualifier_behavior='silent'`.

## Trigger

- **trigger_intents**: `refund_request`, `return_request`, `money_back`, `30_day_guarantee`, `unwanted_charge`, `subscription_dispute`, `charged_without_permission`, `unauthorized_charge`
- **trigger_patterns**: "charged without permission", "didn't sign up for subscription", "didnt sign up", "unauthorized charge", "charged me again", "stop charging me", "didn't order this", "didnt order", "cancel and refund", "want my money back", "refund me", "charged for an order I didn", "never signed up", "didn't want this order", "order I didn't make", "order I didnt make", "subscription I didn't want"
- **priority**: 100 (highest active)

## Steps

8 steps. step_order is the canonical sequence:

| Order | type | Name |
|---|---|---|
| 0 | `identify_order` | Identify the order |
| 1 | `identify_subscription` | Identify the subscription |
| 2 | `check_other_subscriptions` | Check for other active subscriptions |
| 3 | `apply_policy` | Explain the situation and policy |
| 4 | `offer_exception` | Offer exception if eligible |
| 5 | `initiate_return` | Initiate the return |
| 6 | `cancel_subscription` | Cancel the subscription |
| 7 | `stand_firm` | Stand firm if all offers rejected |

The order matters: identify order → identify sub → check for other subs → explain policy with a real timeline → only THEN offer an exception → if accepted, initiate the return + cancel → if rejected, stand firm.

## Policy

One row in [[../tables/playbook_policies]]:

- **30-Day Return Policy** — supersedes most workspaces' default policy. The canonical version lives in [[../tables/policies]] (slug=`returns` + slug=`refunds`) — the playbook references those for the customer-facing policy link.

Current policy contract:

- Renewal orders are **not eligible for return** (the customer agreed to recurring billing).
- First orders ARE eligible within 30 days.
- Damaged / wrong item / missing items go through the [[replacement-order]] playbook, not this one.

## Exceptions (3 tiers)

[[../tables/playbook_exceptions]] rows:

### Tier 1 — Return for Store Credit

- **conditions**: customer LTV ≥ $100 OR total orders ≥ 3 (long-tenured).
- **resolution_type**: `store_credit_return` (customer returns the product, gets store credit, NOT a refund to original card).
- Used as the first exception offer. Lower friction for us — store credit stays in our economy.

### Tier 2 — Return for Full Refund

- **conditions**: customer LTV ≥ $300 OR total orders ≥ 6 (very tenured).
- **resolution_type**: `refund_return` (full refund to original card).
- Reserved for customers we don't want to lose, where store credit alone would push them out.

### Auto-grant — System Error → Refund Without Return

- **conditions**: empty `{}` (always-eligible).
- **resolution_type**: `refund_no_return` (full refund, customer keeps the product).
- **auto_grant**: true (no customer agreement needed).
- Fires when a system error is detected — duplicate charge from a Shopify glitch, double-billing during dunning recovery, etc.
- Detection is partly stubbed (see project_autogrant_detection) — need cancelled_but_charged / duplicate / never_delivered triggers.

## Disqualifiers (`disqualifier_behavior='silent'`)

- **previous_exception** — customer got a playbook exception before → blocks `exceptions_only`. In-policy returns still allowed.
- **has_chargeback** — customer has any chargeback → blocks `exceptions_only`.
- **has_chargeback_on_order** — chargeback on THIS specific order → blocks even `in_policy_return`.

`silent` means the customer never hears "we can't offer an exception" — the playbook simply doesn't tier up. They go straight to stand firm.

## Stand-firm escalation

`stand_firm_before_exceptions=2` + `stand_firm_between_tiers=2` + `stand_firm_max=3`:

- After explaining the policy (step 3), if customer pushes back, stand firm up to 2 times before tiering up to an exception offer.
- Between exception tiers, stand firm up to 2 times.
- Total stand-firm reps capped at 3 before AI declares the conversation closed.

Final stand firm format: one sentence + "reply if you change your mind." See PLAYBOOK-PATTERNS.md.

## Communication rules specific to this playbook

- **Never apologize for the charge** the customer signed up for — duplicate-sub charges aren't billing errors. See feedback_no_apology_for_customer_action.
- **Never frame multiple subs as "double billing"** — customer made the subs, we processed them as configured. See feedback_no_double_billing_framing.
- **Cancel detection is global** — if the customer mentions cancel mid-flow, pause + launch [[../journeys/cancel]] + don't mention the refund again until they bring it back up.

## Customer-facing formatting

From PLAYBOOK-PATTERNS.md universal patterns:

- Refer to orders by date + amount ("your April 4th order for $5.87"). Never the order number.
- Timeline format for first policy explanation:
  ```
  <p><b>March 25</b><br>You subscribed and your first order shipped.</p>
  <p><b>April 4</b><br>Your renewal order processed.</p>
  ```
- Exception offer is one paragraph with exact math: "I can offer you $5.87 in store credit if you ship the product back to us at no cost — does that work for you?"

## Files

| File | Purpose |
|---|---|
| `src/lib/playbook-executor.ts` | Step engine running this playbook |
| `src/lib/shopify-returns.ts` | createFullReturn for step 5 (initiate_return) |
| `src/lib/store-credit.ts` | Store credit issuance for Tier 1 |
| `src/lib/appstle.ts` | subscription cancel for step 6 |
| `src/lib/customer-events.ts` | Event logging |
| `src/lib/improve-actions.ts` | Agent override actions (apply exception manually, force-stand-firm) |
| `src/lib/inngest/returns.ts` | Refund / store-credit pipeline kicked off after step 5 |
| `src/app/dashboard/settings/playbooks/page.tsx` | Settings UI for editing this playbook |

## Related

[[../README]] · [[replacement-order]] · [[../tables/playbooks]] · [[../tables/playbook_policies]] · [[../tables/playbook_exceptions]] · [[../tables/policies]] · [[../tables/returns]] · [[../tables/store_credit_log]] · [[../tables/subscriptions]] · [[../tables/chargeback_events]] · [[../journeys/cancel]] · [[../journeys/select-subscription]] · [[../lifecycles/return-pipeline]] · [[../lifecycles/cancel-flow]] · [[../integrations/shopify]] · [[../integrations/appstle]] · [[../integrations/braintree]]
