# libraries/assisted-purchase-direction

The BLUEPRINT for Sol's assisted-purchase Direction when a ticket is CHECKOUT-STUCK. Phase 3 of [[../specs/checkout-stuck-defaults-to-assisted-purchase-concierge-sonnet-and-sol]]. Pure library — no DB, no network — that names the four-stage recipe, pins the anchor slugs the skill + writer + validator all reference, exposes a builder that returns Turn 1's Direction shape verbatim, and ships a machine-enforced never-claim-placed invariant the box worker runs on Sol's DRAFT reply before every customer send.

**File:** `src/lib/assisted-purchase-direction.ts` · **Tests:** `src/lib/assisted-purchase-direction.test.ts`

## The four-stage recipe

A CHECKOUT-STUCK ticket walks through four stages, each driven by its own Direction turn (a re-session between stages — the customer has to act before Sol knows the next input):

1. **`payment_journey`** — Turn 1. `chosen_path='journey'` + `plan.journey_slug='add-payment-method'`. Launches the ACTIVE Braintree minisite — card never touches us, Shop Pay OTP is bypassed entirely. Warm honest lead-in reply: *"I can just place this for you — no need to fight that screen."*
2. **`confirm_items`** — Turn 2, after the `payment_method_added` signal fires from the journey completion. Sol asks WHICH items the customer wants placed.
3. **`one_time_vs_ss`** — Turn 3. Sol asks one-time (higher price) vs discounted Subscribe & Save.
4. **`playbook_handoff`** — Turn 4. `chosen_path='playbook'` + `plan.playbook_slug` from `handoff_playbook_slugs` (`assisted-order-purchase` for one-time, `assisted-subscription-purchase` for S&S). The playbook's executor runs the Braintree charge + order/subscription create and VERIFIES it. Only AFTER the executor returns `ok:true` may the customer be told the order is placed.

## Contract

```ts
const ASSISTED_PURCHASE_STAGES = [
  "payment_journey", "confirm_items", "one_time_vs_ss", "playbook_handoff"
] as const;
type AssistedPurchaseStage = (typeof ASSISTED_PURCHASE_STAGES)[number];

const ASSISTED_PURCHASE_JOURNEY_SLUG = "add-payment-method";
const ASSISTED_PURCHASE_PLAYBOOK_SLUGS = {
  oneTime: "assisted-order-purchase",
  subscribeAndSave: "assisted-subscription-purchase",
};
const ASSISTED_PURCHASE_LEAD_IN =
  "I can just place this for you — no need to fight that screen. " +
  "Tap below to enter your card securely and I'll take it from there.";

function buildAssistedPurchaseFirstTurnDirection(input?: {
  intent?: string;
  contextSummary?: string;
  leadIn?: string;
}): AssistedPurchaseFirstTurnDirection;

function assertSolAssistedPurchaseReplyNeverClaimsPlaced(ctx: {
  stage: AssistedPurchaseStage;
  firstReply: string;
  placementVerified?: boolean;
}): { ok: true } | { ok: false; kind: string; reason: string; matched_phrase: string };
```

## `buildAssistedPurchaseFirstTurnDirection` — the Turn 1 shape

Returns the fields Sol writes on Turn 1 for a CHECKOUT-STUCK ticket as a plain JSON blob mirroring [[ticket-directions]] `writeDirection` input:

```json
{
  "intent": "customer stuck at checkout — concierge the purchase on our Braintree minisite",
  "context_summary": "Checkout-stuck: …; multi-turn flow: payment_journey → confirm_items → one_time_vs_ss → playbook_handoff.",
  "chosen_path": "journey",
  "plan": {
    "journey_slug": "add-payment-method",
    "assisted_purchase_stages": ["payment_journey", "confirm_items", "one_time_vs_ss", "playbook_handoff"],
    "handoff_playbook_slugs": {
      "one_time": "assisted-order-purchase",
      "subscribe_and_save": "assisted-subscription-purchase"
    }
  },
  "guardrails": {
    "never_promise_placed_until_verified": true,
    "escalate_if": ["customer_asks_for_manager", "any_mention_of_lawyer", "third_pivot_of_ask", "playbook_charge_failed_twice"]
  },
  "first_reply": "I can just place this for you — …"
}
```

The 4-stage recipe + the handoff playbook slugs are pinned on the Direction so a downstream re-session (Turn 2/3/4) can't drift the target slugs. The [[ticket-directions]] writer confirms `add-payment-method` resolves to an `is_active=true`, workspace-scoped `journey_definitions` row before the row lands — a typed `journey_slug_unknown` rejection surfaces the slug verbatim in the box-session log if the workspace hasn't enabled the journey.

## `assertSolAssistedPurchaseReplyNeverClaimsPlaced` — the invariant guard

Machine-enforces the execute-then-confirm honor rule against Sol's DRAFT reply. Same shape as [[sol-move-dead-end-guard]] and [[sol-policy-bait-guard]] — a pure predicate the worker calls right before the customer-facing send. Returns `{ok:true}` when the reply is safe; `{ok:false, kind, reason, matched_phrase}` when the reply claims the order is placed before the flow has actually placed and verified it. The worker treats `{ok:false}` the same way it treats a bait-guard block — Direction stays durable, reply is NOT delivered, ticket escalates to June.

### Decision matrix

| stage | reply claims placed? | `placementVerified` | verdict |
|---|---|---|---|
| `payment_journey` / `confirm_items` / `one_time_vs_ss` | yes | any | **BLOCK** `claims_placed_before_final_stage` |
| `playbook_handoff` | yes | `true` | **PASS** — the execute-then-confirm evidence is in |
| `playbook_handoff` | yes | `false` / omitted | **BLOCK** `claims_placed_without_verification` |
| any | no (warm lead-in / future-tense promise / question) | any | **PASS** |

### Blocked phrasings (case-insensitive)

- "I've placed your order"
- "your order is placed" / "your order has been placed"
- "the order is placed / confirmed / processed / completed"
- "we've placed / charged / processed your order"
- "your order is on its way"
- "charged your card and placed / shipped / created the order"
- "payment went through / was processed / is complete"

A future-tense promise ("I'll place your order once you enter your card") is NOT a placement claim and PASSES.

## Callers

- **[[../../.claude/skills/ticket-handle/SKILL]]** — Sol's box-session skill. When the inbound message classifies as CHECKOUT-STUCK (per [[checkout-stuck-intent]]), the skill directs Sol to author a Direction matching `buildAssistedPurchaseFirstTurnDirection` — `chosen_path='journey'`, `plan.journey_slug='add-payment-method'`, the warm lead-in `first_reply`, the never-claim-placed guardrail.
- **Box worker (`scripts/builder-worker.ts` `runTicketHandleJob`)** — will run `assertSolAssistedPurchaseReplyNeverClaimsPlaced` on Sol's DRAFT reply right after the existing [[sol-move-dead-end-guard]] and [[sol-policy-bait-guard]] pre-ship gates, before the customer-facing send fires. A `{ok:false}` result BLOCKS the send and escalates the ticket to June — same handling as the bait-guard and move-dead-end guards. (Wire-in lands with Phase 4 alongside the playbook re-enable.)

## Related

- [[checkout-stuck-intent]] — the Phase-1 predicate that recognizes the intent.
- [[model-picker]] · [[inflection-detector]] — Phase 2 (Sonnet + Sol re-session).
- Phase 4 re-enables the `assisted-order-purchase` (one-time) + `assisted-subscription-purchase` (S&S) playbooks and wires them behind Sol's session-chosen selection.
- Phase 5 — analytics slice + [[../lifecycles/storefront-checkout]] update + concierge-flow recipe.
