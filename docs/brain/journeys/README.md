# Journeys

Deterministic, multi-step customer flows that guide customers through structured decisions without AI. Every journey is **live-rendered**: the orchestrator's only job is to pick the journey id (and optionally a subscription id) and insert a session row. The mini-site at `/journey/{token}` rebuilds all steps + metadata from current data on every click. No AI-generated step trees, no `config_snapshot` to go stale, no embedded forms.

Every channel delivers the same way: send a CTA, customer clicks through to the mini-site.

## Channel delivery

| Channel | Delivery |
|---|---|
| **Email** | CTA button → mini-site at `/journey/{token}` |
| **Chat** | CTA button in chat bubble → mini-site (same render path as email) |
| **Help Center** | Same as email |
| **SMS** | Plain text + URL link |
| **Meta DM** | Plain text + URL link |
| **Social Comments** | **NEVER** — journeys cannot be sent on social comments |

When a chat customer is idle > 3 min, delivery automatically switches to email (secondary channel system) — same CTA shape, just sent over a different transport. See feedback_chat_idle_journey_delivery.

## Architecture

```
Customer message → Sonnet orchestrator → Journey launcher
                                          │
                                          ▼
                          Create journey_sessions row (token + ids only)
                                          │
                                          ▼
                          Send CTA via the appropriate channel
                                          │
                                          ▼
                       Customer clicks → /journey/{token}
                                          │
                                          ▼
                          Mini-site loader rebuilds steps
                          live from current data, every click
                                          │
                                          ▼
                          POST /api/journey/{token}/complete
                          (processes all responses at once)
```

## Outcomes

Every journey defines `jo:positive` / `jo:negative` / `jo:neutral` outcome tags. Applied in `/api/journey/[token]/complete/route.ts`. Used for analytics — "did the journey work?"

## Pages

| Journey | Trigger intent | Channels | Outcome positive |
|---|---|---|---|
| [[account-linking]] | `account_linking` (prepend only) | email, chat, help_center, sms, meta_dm | Customer linked accounts |
| [[add-payment-method]] | `add_payment_method` | email, chat, sms | Card vaulted + book migrated to internal |
| [[discount-signup]] | `discount_signup` | email, chat, help_center, meta_dm, sms | Marketing signup + coupon delivered |
| [[cancel]] | `cancel_subscription` | email, chat, sms, meta_dm | Customer saved (accepted remedy) |
| [[crisis-tier1-flavor-swap]] | `crisis_tier1` | email | Customer accepted swap |
| [[crisis-tier2-product-swap]] | `crisis_tier2` | email | Customer accepted swap |
| [[crisis-tier3-pause-remove]] | `crisis_tier3` | email | Customer paused / removed (vs cancelled) |
| [[shipping-address]] | `shipping_address` | email, chat, sms | Address confirmed |
| [[missing-items]] | (no auto-trigger) | email, chat, sms | Items list confirmed |
| [[select-subscription]] | `select_subscription` | email, chat, sms | Subscription identified |

## Key principles

1. **Mini-site and live chat must mirror each other** — same steps, same human-readable ticket messages, same completion endpoint. Only the rendering differs. See feedback_minisite_mirrors_chat.

2. **Journey > Workflow > AI/Macros** — journeys take priority. Pattern matching runs but workflows only fire if no journey claimed the message.

3. **Account linking is a prepend, not a standalone journey.** It's silently inserted as the first step(s) of another journey. The CTA email doesn't mention it; it focuses on the main journey (e.g., "Claim my coupon"). Match patterns on `account_linking` are empty `[]` so it never fires solo.

4. **One CTA email = one mini-site = complete flow.** Never send consecutive CTAs. Chained journeys (account linking + discount) are combined into a single multi-step session.

5. **No coupon without signup.** Declining marketing consent means no coupon. First decline triggers a server-side re-nudge email. Second decline closes the ticket and AI takes over on next reply.

6. **Main account only for marketing decisions.** Linked accounts' marketing status doesn't factor into consent / email / phone steps. Email subscribes the main customer's email. Phone subscribes the main customer's phone.

7. **Ticket closes after each journey step** — configurable per journey via `step_ticket_status` in Settings → Journeys. Reopens when customer responds.

8. **Escalated tickets stay open, not pending.** Pending is for agent-sent messages awaiting customer response.

## Adding a new journey

1. Create builder: `src/lib/{name}-journey-builder.ts` — single source of truth for steps and metadata.
2. Add case to `src/lib/journey-step-builder.ts` switch — delegate to your builder.
3. Add [[../tables/journey_definitions]] row (migration) with slug, name, journey_type, trigger_intent, channels.
4. Add completion handler to `src/app/api/journey/[token]/complete/route.ts` if actions needed.
5. Add ticket tag: `j:{intent}` via `addTicketTag()`.
6. Add `jo:positive` / `jo:negative` / `jo:neutral` tags — **ask the user what these are**.
7. Update this folder with the new journey doc.
8. All options / reasons / data must come from the database, never hardcoded.
9. Remember: every channel ships a CTA link; the mini-site is the single rendering path. social_comments = never.

## Files

| File | Purpose |
|---|---|
| `src/lib/journey-launcher.ts` | Unified launcher (chat inline + email CTA) |
| `src/lib/journey-step-builder.ts` | Switch that delegates to per-journey builders |
| `src/lib/journey-delivery.ts` | Channel-aware delivery |
| `src/lib/journey-tokens.ts` | Token generation + verification |
| `src/lib/journey-seed.ts` | Default cancel config + default remedies seed |
| `src/lib/email-journey-builder.ts` | Combined multi-step session (account linking + matched journey) for email |
| `src/lib/discount-journey-builder.ts` | Discount journey builder |
| `src/lib/cancel-journey-builder.ts` | Cancel journey builder |
| `src/lib/crisis-journey-builder.ts` | Crisis journey builders (per tier) |
| `src/lib/shipping-address-journey-builder.ts` | Address change builder |
| `src/lib/missing-items-journey-builder.ts` | Missing items checklist builder |
| `src/lib/select-subscription-journey-builder.ts` | Sub selector builder |
| `src/lib/account-linking-journey-builder.ts` | Account linking prepend builder |
| `src/lib/marketing-signup-journey-builder.ts` | Marketing signup builder |
| `src/lib/chat-journey.ts` | Code-driven journey executors for chat fallback |
| `src/lib/journey-suggest.ts` | Detects journey patterns on agent-assigned tickets |
| `src/app/journey/[token]/page.tsx` | Mini-site multi-step form renderer |
| `src/app/api/journey/[token]/route.ts` | GET session config |
| `src/app/api/journey/[token]/step/route.ts` | POST per-step submission |
| `src/app/api/journey/[token]/complete/route.ts` | POST process all responses |
| `src/app/api/journey/[token]/remedies/route.ts` | Cancel-journey AI remedies |
| `src/app/api/journey/[token]/chat/route.ts` | Cancel-journey open-ended AI chat |
| `src/app/api/tickets/[id]/send-journey/route.ts` | Agent manually sends a journey |
| `src/app/dashboard/settings/journeys/page.tsx` | Settings UI |

## Related

[[../README]] · [[../tables/journey_definitions]] · [[../tables/journey_sessions]] · [[../tables/journey_step_events]] · [[../lifecycles/ticket-lifecycle]] · [[../lifecycles/cancel-flow]] · [[../lifecycles/crisis-campaign]]
