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

- **Ticket trigger** — a conversation just happened, so the warmth of the message comes from that thread; the opening line references it (`Thanks again for reaching out — glad we got you sorted…`).
- **Post-order trigger** — there is no thread. A message that gestures at a support interaction that never occurred reads worse than a plain one, so the copy leans entirely on the product itself and the hand-picked window fact:
  - `window='repeat'` ⇒ *"You ordered X again — it must be doing its job."*
  - `window='first-time'` ⇒ *"You tried X for the first time — a real read from someone new to it is the most valuable kind."*
  - null / unknown ⇒ *"Hoping to hear how X has been for you."*

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
