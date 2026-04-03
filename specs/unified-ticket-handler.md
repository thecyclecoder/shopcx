# Unified Ticket Handler

## Overview

A single entry point for all inbound messages across all channels. Replaces the current fragmented pipeline (ai-multi-turn.ts, turn-router.ts, ai-draft.ts, workflow-executor.ts) with a clean, extensible routing system.

---

## Pipeline

Every inbound message — regardless of channel — enters the same function.

### Step 1: Resolve Customer

- Match inbound sender to a customer record (email, phone, Shopify customer ID)
- If no match: create a stub or leave unresolved
- If match found: check for potential unlinked accounts (customer_links)
- **Internal note**: "Customer resolved: {name} ({email})" or "No customer match found"

### Step 2: Check Ticket State

- If ticket is in **AI clarification mode** (clarification_turn > 0, clarification_turn < 3):
  - Stay in clarification — do NOT re-run the full pipeline
  - AI continues narrowing intent with conversation context
  - **Internal note**: "AI clarification turn {N}: {confidence}% confidence"
  - If clarification_turn reaches 3 → auto-escalate to agent
  - **Internal note**: "AI clarification limit reached, escalating to agent"
- If ticket is **new** or **customer replied after a completed action**: proceed to Step 3

### Step 3: Identify Intent

- AI classifies the inbound message into an intent
- Uses: message text, customer context (orders, subscriptions, fulfillments, linked accounts), conversation history
- Returns: intent label + confidence score (0-100)
- **Context is rebuilt fresh** at this point — never cached from ticket open
- **Internal note**: "Intent classified: {intent} ({confidence}% confidence)"

### Step 4: Confidence Gate

- Compare confidence against the per-channel threshold from `ai_channel_config`
- **If below threshold**: enter clarification mode
  - AI asks a targeted clarifying question (not a generic "can you tell me more")
  - Set `clarification_turn = 1` on ticket
  - **Internal note**: "Confidence {confidence}% below threshold {threshold}%, asking clarification"
  - Set ticket status per channel config
  - **STOP** — wait for next message
- **If at or above threshold**: proceed to Step 5

### Step 5: Route by Priority

Available handlers depend on whether customer was found and the channel:

| Channel | Journey | Workflow | Macro |
|---|---|---|---|
| Email | ✅ (CTA) | ✅ | ✅ |
| Chat | ✅ (embedded form) | ✅ | ✅ |
| SMS | ✅ (plain link) | ✅ | ✅ |
| Meta DM | ✅ (CTA) | ✅ | ✅ |
| Social Comments | ❌ | ❌ | ✅ only |
| Help Center | ✅ (CTA) | ✅ | ✅ |

**No customer found**: macro only. If account-related intent detected, AI asks for alternative email or order number to locate the customer. This counts as a clarification turn.

**Routing priority** (first match wins):

1. **Journey** — does the intent match a journey definition's `trigger_intent` or `match_patterns`?
   - If yes: deliver journey via channel-appropriate method
   - AI generates personalized lead-in text built into the journey delivery (CTA text, embedded form intro)
   - AI does NOT send a separate message announcing the journey
   - **Internal note**: "Routed to journey: {journey_name} (intent: {intent}, confidence: {confidence}%)"
   - Log actions performed by the journey as internal notes
   - Set ticket status per channel config

2. **Workflow** — does the intent match a workflow's trigger?
   - If yes: execute workflow, retrieve data, format response
   - AI generates response incorporating the retrieved data
   - **Internal note**: "Routed to workflow: {workflow_name} (intent: {intent}, confidence: {confidence}%)"
   - Set ticket status per channel config

3. **Macro** — does the intent match a macro (via embeddings/keywords)?
   - If yes: use macro content as response template
   - AI lightly personalizes (customer name, order details) but does NOT make it more verbose
   - Keep it concise — no walls of text
   - **Internal note**: "Routed to macro: {macro_name} (intent: {intent}, confidence: {confidence}%)"
   - Set ticket status per channel config

4. **Knowledge Base** — does a KB article match the intent (via RAG/embeddings)?
   - If yes: AI crafts a concise response from the article content
   - Create a `knowledge_gap` notification for admins: "KB article used but no macro exists for intent: {intent}. Consider creating a macro."
   - **Internal note**: "Routed to KB article: {article_title} (intent: {intent}, confidence: {confidence}%). No macro found — notification created."
   - Set ticket status per channel config

5. **Escalate** — nothing matched (no journey, workflow, macro, or KB article)
   - Assign to agent via round-robin or configured assignment
   - Log to `escalation_gaps` table: intent, original message, customer context, channel, confidence score
   - Create `escalation_gap` notification for admins
   - **Internal note**: "No journey/workflow/macro/KB match for intent: {intent}. Escalating to agent. Gap logged for review."
   - Set ticket status to open (agent needs to handle)

### Step 6: Set Ticket Status

After any outbound message (journey CTA, workflow response, macro response, clarification question):
- Read the configured ticket status from `ai_channel_config` for this channel
- Set the ticket to that status
- Never hardcode open/closed/pending

---

## Dynamic Context

Context is rebuilt at every decision point, not snapshot from ticket creation:

- After account linking: reload orders, subscriptions, linked profiles
- After workflow retrieves info: that info feeds into subsequent AI turns
- After journey completes: refresh customer state (subscription may have changed)
- Context includes: customer profile, orders, subscriptions, fulfillments, retention score, marketing status, conversation history (summarized if long), KB chunks, available journeys/workflows

---

## Clarification Mode

- **Max 3 turns** of AI asking clarifying questions
- Tracked via `clarification_turn` counter on the ticket (or ai turn metadata)
- No global turn counter — only clarification turns are counted
- **Resets to 0** when a journey, workflow, or macro is successfully delivered
- If customer replies with a completely new topic after delivery, clarification starts fresh
- After 3 turns without reaching confidence → silent escalation to agent
- AI persona is always human — no "I'm an AI" or "let me transfer you"

---

## Internal Notes (Audit Trail)

Every decision point logs a system internal note to the ticket:

- Customer resolution result
- Intent classification with confidence %
- Confidence gate decision (proceed vs clarify)
- Each clarification turn with updated confidence
- Route selection (journey/workflow/macro/escalate) with reasoning
- Actions performed by journeys (pause, cancel, coupon applied, etc.)
- Ticket status changes

These are `author_type: "system"`, `visibility: "internal"` messages.

---

## Journey Delivery

**No standalone AI message before journey.** The AI-generated text is the lead-in ON the journey itself:

- **Email**: HTML CTA button with AI lead-in paragraph above it
- **Chat**: Embedded form with AI lead-in text as the intro
- **SMS**: AI lead-in text + plain URL link
- **Meta DM / Help Center**: AI lead-in + CTA link

The AI lead-in is personalized to the specific ticket conversation, not generic.

---

## No Customer Found Flow

1. AI detects account-related intent (order tracking, subscription, billing, etc.)
2. AI responds: asks for an alternative email address or order number
3. This counts as clarification turn 1
4. Customer replies with email/order number
5. System searches for customer match
6. If found: upgrade to full pipeline, rebuild context, re-classify intent
7. If not found: try once more (turn 2), then escalate if still no match

---

## Channel-Specific Behavior

- **Social comments**: Macro responses only. No journeys, workflows, or clarification.
- **SMS**: No HTML entities. Journey CTAs are plain text URLs.
- **All channels**: AI response style configured per channel in `ai_channel_config` (personality, tone, sign-off, emoji settings)

---

## What This Replaces

| Current File | Status |
|---|---|
| `src/lib/inngest/ai-multi-turn.ts` | Replace |
| `src/lib/inngest/ai-draft.ts` | Replace |
| `src/lib/turn-router.ts` | Replace |
| `src/lib/ai-draft.ts` | Replace |
| `src/lib/workflow-executor.ts` | Keep (called by new handler) |
| `src/lib/ai-context.ts` | Keep + extend (dynamic rebuild) |
| `src/lib/pattern-matcher.ts` | Keep (used for journey/workflow matching) |
| `src/lib/rag.ts` | Keep (KB retrieval for macros) |
| `src/lib/journey-launcher.ts` | Keep (journey delivery) |
| `src/lib/escalation.ts` | Simplify (just assignment, no complex routing) |
| `src/lib/rules-engine.ts` | Keep (still runs synchronously on events) |

---

## Escalation Gap Log

When AI escalates because nothing matched, the following is logged to `escalation_gaps` table:

```sql
CREATE TABLE public.escalation_gaps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id),
  ticket_id UUID REFERENCES public.tickets(id),
  customer_id UUID REFERENCES public.customers(id),
  channel TEXT NOT NULL,
  detected_intent TEXT,
  confidence INTEGER,
  original_message TEXT NOT NULL,
  customer_context_summary TEXT,
  resolved_as TEXT,          -- NULL until admin reviews: 'macro_created', 'journey_created', 'workflow_created', 'kb_article_created', 'dismissed'
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Admins see these in a review queue (via dashboard notifications with type `escalation_gap`), grouped by similar intents. From the queue they can:
- See the original message + AI's best guess at intent + customer context
- One-click create a macro, KB article, journey, or workflow from that data
- Dismiss if it's a one-off

Over time this becomes a feedback loop: gaps → new content → fewer escalations.

---

## Macro Personalization

When a macro is matched, AI may lightly personalize it:
- Insert customer name, order number, specific product names
- Do NOT add extra sentences, pleasantries, or verbose wrappers
- Keep the macro's original length and tone
- If the macro is 2 sentences, the output should be ~2 sentences

---

## Knowledge Base Fallback

If no macro matches but a KB article does (via RAG embeddings):
- AI crafts a concise response from the article content
- Keeps it brief — extracts the relevant answer, doesn't dump the whole article
- Creates a `knowledge_gap` notification: "Intent '{intent}' served by KB article '{title}' — consider creating a macro for faster matching"
- This is a signal to admins that a macro should exist but doesn't

---

## Key Principles

1. **One pipeline, all channels** — no channel-specific if/else branches in routing logic
2. **AI enriches, doesn't answer** — AI's job is classification and lead-in text, not freeform responses (except macros)
3. **Context is always fresh** — rebuilt at every decision point
4. **Audit everything** — internal notes at every decision for agent review
5. **No chained journeys** — one journey per routing decision. If customer needs another action, they send a new message and the pipeline runs again.
6. **Ticket status from config** — never hardcoded
7. **Persona is human** — AI never reveals it's AI, never offers "transfer to human"
