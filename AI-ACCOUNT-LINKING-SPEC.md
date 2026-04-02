# AI Proactive Account Linking — Spec

## Problem
When a customer contacts support, they may have multiple profiles (different emails, name variations like Elvi/Elvira). The AI and agent only see data from the profile that emailed in, missing orders/subscriptions from other profiles. This leads to:
- AI can't resolve issues (incomplete context)
- Agent has to manually search customers page to discover duplicates
- Customer gets frustrated repeating themselves

## Solution
AI proactively detects potential duplicate profiles before generating a draft response. Instead of asking via plain text (which is hard to parse), it triggers the existing account linking journey — a structured checklist where the customer confirms which emails are theirs.

## What's Done

### 1. Fuzzy name matching in suggestions API ✅
**File:** `src/app/api/customers/[id]/suggestions/route.ts`
- Same last name + prefix first name matching (Elvi matches Elvira)
- Works for ticket sidebar suggestions and proactive linking

### 2. Account linking section in ticket sidebar ✅
**File:** `src/app/dashboard/tickets/[id]/page.tsx`
- Always visible (not hidden when no suggestions)
- Amber badge shows suggestion count
- Manual search input (type email, press Enter)
- Link button on each suggestion
- Auto-refreshes sidebar data after linking (combined orders/subs/LTV)

### 3. Proactive linking detection in AI draft pipeline ✅
**File:** `src/lib/ai-draft.ts`
- `checkProactiveAccountLinking()` runs as step 0 before RAG/macro matching
- Finds duplicates using fuzzy name match (same last name + prefix first name)
- Excludes already-linked and rejected profiles
- Currently generates a plain-text draft asking about emails (needs to be replaced with journey trigger)
- Tags ticket with `ai:linking_offered`
- Sets tier to "review" (agent approval)

### 4. Sandbox email safety ✅
**File:** `src/lib/email.ts`
- In sandbox mode, ALL emails blocked unless recipient is a workspace member
- Prevents accidentally emailing real customers during testing

## What Needs to Be Built

### 5. Replace plain-text draft with account linking journey trigger
**Current:** AI generates a text draft listing emails and asking customer to confirm
**Needed:** AI should trigger the account linking journey instead, which sends a structured email with checkboxes

**Changes needed:**
- In `checkProactiveAccountLinking()` (`src/lib/ai-draft.ts`):
  - Instead of returning a draft with email list, trigger the account linking journey
  - Use `sendJourneyCTA()` from `src/lib/email.ts` to send the journey link
  - Or use the journey launcher (`src/lib/journey-launcher.ts`) which already has account linking steps
  - The journey intro message should be empathetic: "I'm sorry to hear you're having trouble. Before I can help, I want to make sure I can see all your accounts..."
  - Post an internal note on the ticket: "AI detected potential duplicate profiles and sent account linking journey"
  - Set ticket status to "pending" (waiting for customer to complete journey)

### 6. After account linking completes → clarify then resolve
**Current:** Agent manually re-triggers after linking from sidebar
**Needed:** When the journey completes (customer confirms emails), automatically:
- Link the confirmed profiles
- AI knows the original message was vague (store `needs_clarification: true` on ticket or in tags)
- Re-fire AI — but instead of trying to solve immediately, AI sends a clarifying follow-up:
  "Thanks for confirming! I can now see all of your accounts. Could you describe what happened in a bit more detail so I can help resolve it?"
  (optionally quote their original message so they see it's hard to understand)
- Once customer replies with clarification, AI now has full context + clear issue → normal draft flow

**Key insight:** Account linking and clarification are a 2-step sequence. The AI should treat post-linking as "I still need more info" if the original message was vague, NOT immediately try to answer.

### 7. Re-nudge if customer replies without completing journey
**Scenario:** Customer replies to the email but ignores the journey link
**Needed:** In the multi-turn handler (`src/lib/inngest/ai-multi-turn.ts`):
- Check if ticket has `ai:linking_offered` tag and `profile_link_completed` is false
- If customer replied but didn't complete the journey, re-nudge:
  "I really want to help, but I need to make sure I can see all your accounts first. Could you click the link above to confirm which emails are yours?"
- Max 1 re-nudge (tag with `ai:linking_renudged`)

### 8. Clarifying question for vague messages (after linking resolved)
**Scenario:** Accounts are linked (or no duplicates found), but customer message is too vague to match any macro/KB
**Current:** AI returns empty draft, goes silent
**Needed:** If customer is recognized (has customer_id) and confidence is below threshold:
- Generate a clarifying question instead of going silent
- Example: "I can see your account and I want to help. Could you describe what happened in a bit more detail so I can look into it for you?"
- Include a quote of their original message for reference
- Set tier to "review" so agent can approve

## Key Files
- `src/lib/ai-draft.ts` — Main AI draft pipeline, proactive linking check
- `src/lib/journey-launcher.ts` — Journey launcher with account linking steps
- `src/lib/inngest/ai-draft.ts` — Inngest wrapper that calls generateAIDraft
- `src/lib/inngest/ai-multi-turn.ts` — Multi-turn handler (re-nudge logic goes here)
- `src/app/api/customers/[id]/suggestions/route.ts` — Fuzzy name matching
- `src/app/api/customers/[id]/links/route.ts` — Link/unlink API
- `src/app/dashboard/tickets/[id]/page.tsx` — Ticket sidebar linking UI

## Test Ticket
- Customer: Elvi Lamping (elviexpress@gmail.com)
- Duplicate profiles: elvilamping@aol.com (2 orders, $135 LTV), elviexpress@aol.com (4 orders, $212 LTV)
- Combined: 7 orders, ~$405 LTV, 1 cancelled subscription
- Test ticket ID: 26596c4b-7317-4310-84a1-52786e282e44
- Gorgias source: #263836274

## Flow Diagram
```
Ticket arrives from recognized customer
  ↓
AI checks for duplicate profiles (fuzzy name match)
  ↓
[Duplicates found?]
  YES → Trigger account linking journey
        → Post internal note
        → Set ticket pending
        → Customer completes journey (links accounts)
        → Re-trigger AI draft with full context
        → AI generates response (or clarifying question if vague)
  NO → [Message clear enough for macro/KB match?]
        YES → Normal AI draft flow
        NO → Generate clarifying question (don't go silent)

[After account linking completes]
  ↓
[Was original message vague?]
  YES → Send clarifying question (quote original message)
        → Customer replies with details
        → AI now has full context + clear issue → normal draft
  NO → AI generates response with full combined context
```
```
