# libraries/review-request-compose

Pure, trigger-aware first-touch review-request body composer — the shared half of the send path both the ticket trigger and the post-order trigger route through, per Phase 2 of [[../specs/review-request-post-order-ask]].

**File:** `src/lib/review-request-compose.ts`

## Exports

### `composeReviewRequestFirstTouchBody(input): { subject, body }`
Compose a first-touch review-request. The `trigger` field is the branch key — the two shapes differ ONLY on the opening's warrant. Everything else (angle branch, channel branch, greeting, CTA) is shared.

**Input shape:**
```
{
  trigger: 'ticket' | 'post-order',
  channel: 'email' | 'sms',
  angle: 'defend' | 'fence-sitter',
  productName: string,
  customerFirstName?: string | null,
  reviewUrl: string,
  window?: 'first-time' | 'repeat' | null,   // post-order only; ticket passes null
  tenureDays?: number | null,
}
```

## Two-trigger contract

- **Ticket trigger** — a conversation just happened, so the warmth of the message comes from that thread; the opening line references it (`Thanks again for reaching out, and glad we got you sorted…`).
- **Post-order trigger** — there is no thread. A message that gestures at a support interaction that never occurred reads worse than a plain one, so the copy leans entirely on the product itself and the hand-picked window fact:
  - `window='repeat'` ⇒ *"Thanks for ordering X again, and for being with us over a year."* (tenure clause only when `tenureDays ≥ 30`)
  - `window='first-time'` ⇒ *"You recently tried X for the first time. We hope you're enjoying it."* (never a tenure clause)
  - null / unknown ⇒ *"We'd love to hear how X has been for you."*
- **Ask line** — fence-sitter: *"Would you leave a quick review? A note from a real customer helps people decide more than anything we could say."* · defend: *"Some people wonder whether it really works. Would you share what it's been like for you?"*
- **Copy rules (CEO 2026-10-13):** plain text, no em-dashes (they also force UCS-2 SMS encoding, roughly tripling segments), max 2 sentences per paragraph, and no tenure on a first-time ask. The old first-time line paired "first time" with "you've been with us about 6 months" and read as a contradiction on ~1,000 sent asks. A test pins the no-em-dash rule across every window × channel × angle.

The post-order `window` + `tenureDays` are NOT the raw detector's flags — they are derived from the customer's merged order + subscription surface across linked identities by [[review-request-cx-surface]] `deriveCxSurfacePersonalization`. The composer's null-fallthrough branch is the shape that renders when the derivation withholds a claim (blind history, no observable activity, or a surface contradiction), so a caller that cannot verify the fact automatically gets a truthful message.

The angle branch (defend vs fence-sitter) is TRIGGER-INDEPENDENT — both triggers use the same angle-shaped ask line so the validator's `unapproved_pretext` rail sees the same value regardless of trigger.

## Channel branch

- **Email** — subject names the product (`Quick question about <product>`); body carries greeting / opening / ask / CTA line + URL, separated by blank lines.
- **SMS** — same block layout with the CTA link isolated on its OWN line (`sms_link_not_on_its_own_line` + `sms_missing_block_layout` rails in [[review-request-validator]]). STOP suffix (`Reply STOP to opt out.`) required and included verbatim so the `sms_missing_stop_word` rail passes.

## Why this module exists

Every existing send-path SDK was already shared; what did NOT exist was a single composer with the trigger branch. Two trigger paths each inlining their own template would silently diverge the first time one branch's grader tweaked a phrase. Centralizing here means a divergence is impossible without touching this module.

## Callers

- [[review-request-sender]] `applyReviewRequest` — the shared apply-pipeline both triggers route through.

## Related

- [[review-request-validator]] — every rail the composer's SMS branch must satisfy is pinned here.
- [[review-message-rubric]] — Sol self-scores against this rubric; the composer's output is the draft she scores.

---

[[../README]] · [[../../CLAUDE]] · [[../specs/review-request-post-order-ask]] · [[review-request-validator]]
