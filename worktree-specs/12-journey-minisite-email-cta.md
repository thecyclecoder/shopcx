# Feature: Journey Mini-Site for Email Channel

## What Already Exists
- `/journey/[token]` page with step rendering (radio options, emoji, branching)
- `journey_sessions` table with token, status, current_step, responses
- `journey_step_events` audit log
- Journey definitions with steps config
- Interactive forms in chat widget (checklist, radio, confirm, text_input)

## What to Build

When a journey triggers on the email channel, instead of embedding forms
(which email doesn't support), send a beautiful CTA email that links to
the journey mini-site page.

### Email CTA Flow
1. Journey triggers on email (e.g., discount intent detected)
2. System creates a `journey_session` with a unique token
3. Sends email with branded CTA button: "Complete your request →"
4. Link: `https://shopcx.ai/journey/{token}`
5. Customer clicks → branded mini-site page with interactive forms
6. Same form types as chat widget (checklist, radio, confirm, text_input)
7. Responses saved to journey_session, actions executed

### Journey Page Upgrade
The existing `/journey/[token]` page needs:
- Support for all form types (currently only radio options)
- Workspace branding (logo, primary color from workspace settings)
- Mobile-first responsive design
- Progress indicator (step 1 of 3)
- Same instant-action checklist behavior as chat widget
- Completion screen with branded message

### CTA Email Template
Beautiful HTML email with:
- Workspace logo
- Brief context: "We'd love to help you with your request"
- Large branded CTA button
- "This link expires in 24 hours" footer
- Mobile responsive

### Integration Points
- `chat-journey.ts` executors need a channel check:
  - If chat → send form message in widget
  - If email → create journey_session + send CTA email
- Token expiry: 24 hours by default
- Journey session tracks which ticket triggered it

### Files to Modify
- `src/app/journey/[token]/page.tsx` — add all form types + branding
- `src/lib/chat-journey.ts` — channel-aware: widget forms vs email CTA
- `src/lib/email.ts` — add `sendJourneyCTA()` function
- `src/app/api/journey/[token]/route.ts` — may need updates for new form types

### Files to Create
- None — builds on existing infrastructure

## When Done
This makes journeys truly channel-agnostic:
- Chat: inline interactive forms
- Email: CTA button → branded mini-site with same forms
- Both: same journey logic, same actions, different delivery
