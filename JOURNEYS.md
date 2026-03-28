# Journeys System

Journeys are deterministic, multi-step customer flows that guide customers through structured decisions without AI. They work across two channels with identical logic:

- **Live chat**: Inline multi-step form embedded in chat bubble (`<!--JOURNEY:{token,steps}-->`)
- **Email**: CTA email → branded mini-site at `/journey/{token}` with progress bar

## Architecture

```
Customer message → Pattern match → Journey launcher
                                    │
                    ┌───────────────┴───────────────┐
                    │ Chat                          │ Email
                    │ Build steps + embed inline    │ Build steps + create session
                    │ via <!--JOURNEY:{}-->         │ + send CTA email
                    │ Widget renders InlineForm     │ Mini-site renders steps
                    └───────────────┬───────────────┘
                                    │
                                    ▼
                    POST /api/journey/{token}/complete
                    (processes all responses at once)
```

## Key Principles (learned through testing)

1. **Mini-site and live chat must mirror each other** — same steps, same human-readable ticket messages, same completion endpoint. Only the rendering differs.

2. **Journey > Workflow > AI/Macros** — journeys take priority. Pattern matching runs but workflows only fire if no journey claimed the message. New ticket path and reply path both respect this order.

3. **Account linking is a prepend, not an independent journey** — it's silently inserted as the first step(s) of another journey. The CTA email doesn't mention it; it focuses on the main journey (e.g., "Claim my coupon"). Match patterns on account_linking are empty `[]` so it never fires solo.

4. **One CTA email = one mini-site = complete flow** — never send consecutive CTAs. Chained journeys (account linking + discount) are combined into a single multi-step session.

5. **No coupon without signup** — declining marketing consent means no coupon. First decline triggers a server-side re-nudge email. Second decline closes the ticket and AI takes over on next reply.

6. **Main account only for marketing decisions** — linked accounts' marketing status doesn't factor into consent/email/phone steps. Email subscribes the main customer's email. Phone subscribes the main customer's phone.

7. **Ticket closes after each journey step** — configurable per journey via `step_ticket_status` in Settings → Journeys. Reopens when customer responds.

8. **Escalated tickets stay open, not pending** — pending is for agent-sent messages awaiting customer response.

## Existing Journeys

### Account Linking (prepend only)
- **Trigger**: Automatically prepended when unlinked name-matched profiles exist
- **Channel**: All except social_comments
- **Steps**: Checklist of unlinked emails → link confirmed ones, reject others
- **Rejections**: Stored in `customer_link_rejections`, never re-offered

### Discount & Marketing Signup
- **Trigger**: Match patterns: discount, coupon, deal, promo, promotion, save, code, sale, specials
- **Channel**: All except social_comments
- **Steps**:
  1. Consent: "Want to sign up for coupons?" (Yes/No)
  2. Phone input: only if no phone on file (auto-format + Twilio validation, mobile only)
  3. Apply to subscription: only if active sub exists with coupon available
- **On consent "Yes"**: Auto-subscribes main customer email + phone (if on file) to Shopify marketing
- **On consent "No"**: Journey ends → server sends re-nudge CTA email → second "No" closes ticket
- **Coupon**: Styled code block with click-to-copy, VIP tier matching

### Cancellation Flow (step-based, for future use)
- **Trigger**: Not currently auto-triggered (empty match patterns)
- **Steps**: Seeded config with 7 steps, reason selection, rebuttals, discount/pause/skip offers
- **Outcomes**: 10 paths (cancelled, saved_discount, saved_pause, saved_skip, etc.)
- **Execution**: Fully rendered by the mini-site's step-based navigation (not code-driven)

## Adding a New Journey

1. Create a `journey_definitions` row with slug, name, journey_type, trigger_intent, match_patterns, channels
2. For code-driven journeys: add a step builder function (like `buildDiscountJourneySteps`)
3. Wire it into `journey-launcher.ts` for chat and `email-journey-builder.ts` for email
4. Add response processing to `/api/journey/[token]/complete/route.ts`
5. Add ticket tag: `j:{intent}` via `addTicketTag()`
6. Update CLAUDE.md tag conventions

## Files

| File | Purpose |
|------|---------|
| `src/lib/journey-launcher.ts` | Unified launcher — routes to chat inline or email CTA |
| `src/lib/email-journey-builder.ts` | Builds combined multi-step session for email (account linking + matched journey) |
| `src/lib/discount-journey-builder.ts` | Builds discount journey steps from customer data |
| `src/lib/chat-journey.ts` | Code-driven executors (account linking inline forms, discount for chat fallback) |
| `src/lib/journey-suggest.ts` | Detects journey patterns on agent-assigned tickets, creates suggestion card |
| `src/lib/journey-seed.ts` | Default cancellation flow config |
| `src/app/journey/[token]/page.tsx` | Mini-site: multi-step forms, branded background, code-driven + step-based |
| `src/app/api/journey/[token]/route.ts` | GET: load journey session config |
| `src/app/api/journey/[token]/step/route.ts` | POST: submit step (code-driven executor for single-form, mini-site step advance) |
| `src/app/api/journey/[token]/complete/route.ts` | POST: process all multi-step responses (marketing, coupon, linking, re-nudge) |
| `src/app/api/tickets/[id]/send-journey/route.ts` | POST: agent manually sends a journey to customer |
| `src/app/api/validate-phone/route.ts` | GET: Twilio Lookup v2 phone validation + line type check |
| `src/app/dashboard/settings/journeys/page.tsx` | Journey settings: list + detail view with flow editor |

## Email Threading

Journey CTA emails thread into the existing Gmail conversation using:
- `subject: Re: {original ticket subject}`
- `In-Reply-To: {email_message_id}` from the ticket's original inbound email
- `References: {email_message_id}`

The `email_message_id` is the Gmail Message-ID header stored on the ticket when the email arrives. Do NOT use `resend_id` (that's only on outbound emails we send).

## Re-nudge System

When a customer declines marketing signup:
1. Mini-site/chat shows: "Check your email shortly for a response from our team!"
2. Server checks `journey_nudge_count` on ticket
3. First decline (count=0): sends new CTA email with nudge wording, increments count to 1
4. Customer clicks → new mini-site session with discount steps (no account linking since already done)
5. Second decline (count=1): closes ticket, clears journey, AI takes over on next reply

Nudge count resets when customer completes a step via the mini-site.

## Journey Suggestions (agent-assigned tickets)

When a customer sends a message on an agent-assigned ticket that matches a journey pattern:
- System creates a `<!--JOURNEY-SUGGEST:{journeyId, journeyName}-->` internal message
- Ticket detail page renders a cyan suggestion card with "Send Journey" button
- Agent clicks → journey executes via `/api/tickets/{id}/send-journey`
- De-duplicated: same journey only suggested once per ticket

## Phone Input

Both mini-site and chat widget:
- Auto-format as user types: `8583349198` → `(858) 334-9198`
- Saves as E.164: `+18583349198`
- `autocomplete="tel-national"` + `inputMode="numeric"` for browser autofill
- Twilio Lookup v2 validates number + checks line type
- Rejects landlines with clear error message
- Auto-prepends +1 for US numbers on server side

## Appstle Subscription Actions

- **Cancel**: `DELETE /api/external/v2/subscription-contracts/{id}?cancellationFeedback={reason}&cancellationNote={note}`
  - Reasons: "fraud", "chargeback", "customer_request"
  - Note includes agent display name: "Cancelled by Dylan on ShopCX.ai — fraud"
- **Pause/Resume**: `PUT /api/external/v2/subscription-contracts-update-status?contractId={id}&status=PAUSED|ACTIVE`
- **Apply discount**: `PUT /api/external/v2/subscription-contracts-apply-discount?contractId={id}&discountCode={code}`
- **Remove discount**: `PUT /api/external/v2/subscription-contracts-remove-discount?contractId={id}&discountId={id}`

## Common Debugging

- **Mini-site shows spinner forever**: Check if `config.codeDriven` is true — the codeDriven check must run BEFORE the loading state check (which looks for `step` which is null for code-driven journeys)
- **Journey not triggering on new email**: The email webhook has TWO code paths — new tickets and replies. Journey check must exist in BOTH. New tickets use `buildCombinedEmailJourney`, replies use `ai/reply-received` event.
- **CTA email not threading in Gmail**: Must use `email_message_id` (Gmail's Message-ID), not `resend_id`. Check the ticket's `email_message_id` field.
- **Form crashes with `.map()` on undefined**: The `confirm` form type has no `options` array. Always guard with `form.options || []` and handle `confirm` as a separate type with Yes/No buttons.
- **Customer response not processed**: For email channel, check that `handled_by` starts with "Journey:" — the webhook only fires `ai/reply-received` for AI/Workflow/Journey-handled or unassigned tickets.
- **Multi-step steps use `key` not `id`**: The discount builder creates steps with `key: "consent"` but the mini-site's JourneyForm interface uses `id`. Check both: `form.id || form.key`.
- **Workflow fires before journey**: Pattern matching must NOT fire the workflow immediately. It records the match, then the journey check runs. Only after journey check returns `handled: false` does the workflow fire (Step 1d in ai-multi-turn.ts).
