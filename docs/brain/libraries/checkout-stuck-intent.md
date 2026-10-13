# libraries/checkout-stuck-intent

Pure predicate that recognizes a CHECKOUT-STUCK customer message as a first-class intent — distinct from the coarse `account` / `general` / `outreach` buckets the [[unified-ticket-handler]] classify-bucket step returns. Part of the [[../recipes/checkout-stuck-concierge-flow]]. A customer who "can't check out", whose OTP / verification code isn't arriving, who is "stuck at the payment or authentication screen", asks "how do I finish my order", who is BLOCKED PRE-PURCHASE on the storefront itself (can't select a variant / can't choose a subscription tier / no option to subscribe / can't add to cart), OR who is ALREADY mid add-payment-method journey but OBJECTS to the payment link itself ("I don't trust this to add payment" / "is this safe" / "looks like a scam") or asks for an ALTERNATIVE payment rail ("do you have PayPal?") is a candidate for the assisted-purchase concierge flow — not a stateless "try another card" dead-end reply from the cheap orchestrator, not a "clear your cache" loop that invents UI to click through, and not an escalation that abandons a live buying customer mid-checkout.

**File:** `src/lib/checkout-stuck-intent.ts` · **Tests:** `src/lib/checkout-stuck-intent.test.ts`

## Contract

```ts
interface CheckoutStuckClassification {
  matched: boolean;
  cue?: string;    // e.g. "otp_not_arriving" — winning rule id
  reason?: string; // "checkout-stuck: <cue>" — safe to stamp as evidence
}

function classifyCheckoutStuck(msg: string | null | undefined): CheckoutStuckClassification;

const CHECKOUT_STUCK_BUCKET = "checkout-stuck" as const;
```

Pure — no DB, no network, no Claude call. Safe to invoke inside an Inngest step, a classifier prompt, or the [[model-picker]] router.

## Rule catalog (specificity-ordered)

First match wins the evidence label. Every entry is a phrase a customer with a plain order-status / account question would NOT reasonably use — false positives here would reroute good tickets away from the ordinary account lane.

| Cue id | What it catches | Category |
|---|---|---|
| `otp_not_arriving` | "the Shop Pay verification code isn't arriving" — Latrina's aa0b6697 case | OTP / verification code not arriving |
| `no_code_received` | "I never got the verification text" | OTP / verification code not arriving |
| `stuck_at_payment_screen` | "stuck at the payment/checkout/authentication screen", "stuck on OTP" | Stuck at the payment or authentication screen |
| `cant_check_out` | "I can't check out", "I cannot complete my order", "I can't finish my purchase" | Can't check out |
| `checkout_not_working` | "checkout isn't working", "Shop Pay won't go through" | Can't check out |
| `how_do_i_finish` | "how do I finish my order?", "how can I complete my purchase?" | How do I finish my order |
| `no_subscribe_option` | "there is no option to subscribe", "no Subscribe & Save option", "no 60 day option" — ticket 3dd271be | Storefront pre-purchase block |
| `cant_select_variant` | "I can't select the 60-day", "won't let me choose the subscription plan / variant / flavor" — ticket 3dd271be | Storefront pre-purchase block |
| `cant_add_to_cart` | "I can't add it to my cart", "the add-to-cart button doesn't do anything" | Storefront pre-purchase block |
| `payment_link_trust_objection` | "I dont know if I can trust this to add payment", "I don't trust this link" — ticket cd385c7f | Payment-link trust objection |
| `payment_link_safety_doubt` | "is this safe", "this looks like a scam", "is this legit" — ticket cd385c7f | Payment-link trust objection |
| `alt_rail_payment_question` | "Do you have pay pal?", "can I use PayPal", "can I pay with PayPal" (also Venmo / Apple Pay / Google Pay / Affirm / Klarna / Afterpay / Cash App / Amazon Pay) — ticket cd385c7f | Alternative payment-rail question |

Normalization mirrors [[../inngest/unified-ticket-handler]] `classifyIntent` + [[inflection-detector]]: strip HTML tags, decode entities enough for regex, collapse whitespace, trim. Every cue is `/i` (case-insensitive).

## Why a separate bucket

The coarse [[../inngest/unified-ticket-handler]] classify-bucket step returns `"account" | "general" | "outreach"`. A checkout-stuck message today falls into `account` — but the account lane's default handling is stateless (refund / cancel / order status / address change) and dead-ends a checkout-stuck customer with "try another card / PayPal / Shop Pay". Ticket aa0b6697 (Latrina C.) is the recorded Shop-Pay-OTP failure: mis-classed `account`, replied to on Opus (recent-merges tripped [[model-picker]]), and Sol was never re-sessioned to author an assisted-purchase Direction. Ticket 3dd271be (mdengberg2, Mixed Berry 60-day sub) is the storefront-pre-purchase-block companion: item was in stock (7,761 on hand, live PDP available), but the orchestrator looped 3× on "clear your cache" and once invented a "30/60/90 Day Supply card" UI that doesn't exist on the PDP; ticket false-resolved 9/10 while the customer remained blocked. The new `no_subscribe_option` / `cant_select_variant` / `cant_add_to_cart` cues route those blocked buyers into the same Sol-re-session lane, and the [[assisted-purchase-direction]] `assertSolFastDefaultToConcierge` guard now blocks the "clear your cache / try incognito / try a different browser / hard refresh" loop on Sol's reply.

## Payment-journey-stage objection (ticket cd385c7f)

Ticket cd385c7f (Elvira Lamping): a pre-purchase customer trying to place a one-time Amazing Coffee Cocoa bag was blocked at `check_vaulted_pm` with no vaulted PM, then sent "I dont know if I can trust this to add payment" followed by "Do you have pay pal ?". Both were logged "classified as new topic (not related to active playbook) → Routing to Sonnet", hit the no-progress circuit (4 inbound in a row), and escalated — abandoning a live buying customer. The old cue catalog had nothing for a payment-link TRUST objection or an ALTERNATIVE-rail question, so the inflection re-session path (`stage1_checkout_stuck`) never fired to keep her in the concierge lane.

The `payment_link_trust_objection` / `payment_link_safety_doubt` / `alt_rail_payment_question` cues close that gap. A match keeps the ticket in the concierge lane (via [[inflection-detector]] `stage1_checkout_stuck`), and the answer is known + in-policy: **the same secure Braintree Drop-in link accepts PayPal (PayPal Vault), and no card ever touches us** — answer in-lane and re-present the link, never escalate. The canonical in-lane replies live in [[assisted-purchase-direction]]:

- `ASSISTED_PURCHASE_TRUST_REPLY` — the trust/safety-doubt answer ("That link is our secure Braintree payment page — your card details go straight to Braintree and never touch us…").
- `ASSISTED_PURCHASE_PAYPAL_REPLY` — the alt-rail answer ("Yes — that same secure link accepts PayPal. Tap it and choose PayPal to pay…").
- `conciergeReplyForObjectionCue(cue)` — pure selector mapping a cue id → the reply, `null` for non-objection cues.
- `PAYMENT_JOURNEY_OBJECTION_CUES` — the Set of the three objection cue ids.

Critically, [[assisted-purchase-direction]] `assertSolFastDefaultToConcierge` only BLOCKS Sol PROPOSING "try PayPal / try another card" as a dead-end escape from a failing checkout; it never ANSWERS that the existing link supports PayPal Vault. Both canonical replies are worded ("pay with PayPal", never "try PayPal") so they pass that guard — tests pin this.

The `classifyCheckoutStuck` predicate recognizes the intent as its own thing so downstream routing and Sol can special-case it:
- **Routing** — [[model-picker]] keeps checkout-stuck on Sonnet even when `recentMergesCount > 0`, and the drift/re-session router flags Sol back in.
- **Sol's Direction** — Sol's Direction launches the `add-payment-method` [[../journeys/add-payment-method]] then confirms items, then asks one-time vs S&S.
- **Placement** — re-enables the `assisted-order-purchase` / `assisted-subscription-purchase` playbooks behind Sol's session-chosen selection, via [[assisted-purchase-direction]] + [[../recipes/checkout-stuck-concierge-flow]].
- **Analytics** — provides signals for the [[../recipes/checkout-stuck-concierge-flow#analytics]] funnel slice (tickets → assisted-purchase started → order placed).

## Callers

- **[[model-picker]] `pickOrchestratorModel` / `pickModelFromSignals`** — Phase 2. The picker computes `isCheckoutStuck` from the newest inbound customer message (passed in as `newestMessage` by [[../inngest/unified-ticket-handler]] § 4). When true, `pickModelFromSignals` short-circuits at the earliest gate to `{ model: "sonnet", reason: "checkout-stuck" }` — no future rule can escalate away from Sonnet, and `ai_token_usage.purpose` surfaces the audit slice cleanly.
- **[[inflection-detector]] `stage1Classify`** — Phase 2. A checkout-stuck newest message maps to `kind: 'drift'` with `evidence.reason = 'stage1_checkout_stuck'`, which flows through `detectInflection → applyInflectionGate → reSessionSol` unchanged: the live Direction is superseded and a fresh `kind='ticket-handle'` `agent_jobs` row is enqueued so Sol authors a real assisted-purchase Direction. Fires even mid-playbook (a customer stuck at Shopify checkout still needs Sol) and even without a live Direction.

## Test coverage

`src/lib/checkout-stuck-intent.test.ts` pins the three Phase 1 verification bullets:

1. Every keyword category matches (positive cases per cue, including the new `payment_link_trust_objection` / `payment_link_safety_doubt` / `alt_rail_payment_question` cues).
2. An aa0b6697-shaped fixture ("Shop Pay verification code never arrived on my phone, so I can't check out") classifies as `matched: true` with a checkout-stuck cue — NOT the coarse `account` default. The cd385c7f fixtures ("I dont know if I can trust this to add payment" and "Do you have pay pal ?") classify as checkout-stuck — NOT "new topic".
3. Plain order-status / cancel-subscription / refund / address-change / ingredient questions do NOT match — the predicate is silent for the ordinary account lane (incl. "do you have an oat milk creamer flavor?" and "is this gluten free?" negatives for the new cues).

The in-lane concierge replies are pinned in `src/lib/assisted-purchase-direction.test.ts`: `conciergeReplyForObjectionCue` maps each cue to the right reply, and both `ASSISTED_PURCHASE_TRUST_REPLY` / `ASSISTED_PURCHASE_PAYPAL_REPLY` pass `assertSolFastDefaultToConcierge` (answer, never dead-end).

Run:

```bash
npx tsx --test src/lib/checkout-stuck-intent.test.ts
```
