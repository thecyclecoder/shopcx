# libraries/checkout-stuck-intent

Pure predicate that recognizes a CHECKOUT-STUCK customer message as a first-class intent — distinct from the coarse `account` / `general` / `outreach` buckets the [[unified-ticket-handler]] classify-bucket step returns. Part of the [[../recipes/checkout-stuck-concierge-flow]]. A customer who "can't check out", whose OTP / verification code isn't arriving, who is "stuck at the payment or authentication screen", or who asks "how do I finish my order" is a candidate for the assisted-purchase concierge flow — not a stateless "try another card" dead-end reply from the cheap orchestrator.

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

Normalization mirrors [[../inngest/unified-ticket-handler]] `classifyIntent` + [[inflection-detector]]: strip HTML tags, decode entities enough for regex, collapse whitespace, trim. Every cue is `/i` (case-insensitive).

## Why a separate bucket

The coarse [[../inngest/unified-ticket-handler]] classify-bucket step returns `"account" | "general" | "outreach"`. A checkout-stuck message today falls into `account` — but the account lane's default handling is stateless (refund / cancel / order status / address change) and dead-ends a checkout-stuck customer with "try another card / PayPal / Shop Pay". Ticket aa0b6697 (Latrina C.) is the recorded failure: mis-classed `account`, replied to on Opus (recent-merges tripped [[model-picker]]), and Sol was never re-sessioned to author an assisted-purchase Direction.

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

1. Every keyword category matches (positive cases per cue).
2. An aa0b6697-shaped fixture ("Shop Pay verification code never arrived on my phone, so I can't check out") classifies as `matched: true` with a checkout-stuck cue — NOT the coarse `account` default.
3. Plain order-status / cancel-subscription / refund / address-change / ingredient questions do NOT match — the predicate is silent for the ordinary account lane.

Run:

```bash
npx tsx --test src/lib/checkout-stuck-intent.test.ts
```
