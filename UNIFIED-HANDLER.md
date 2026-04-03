# Unified Ticket Handler

## Overview

A single Inngest function (`unified-ticket-handler`) processes ALL inbound customer messages across ALL channels. There are no separate handlers per channel or per feature — one pipeline, one entry point.

**Event:** `ticket/inbound-message`  
**File:** `src/lib/inngest/unified-ticket-handler.ts`  
**Concurrency:** 1 per ticket (no overlapping processing)

---

## Pipeline

Every inbound message follows this exact sequence:

### 1. Resolve Customer
- Match sender to a customer record
- Log internal note: "Customer: Name (email)" or "No customer match"

### 2. Account Linking (supercedes everything)
- If customer found + potential unlinked accounts detected → launch account linking journey immediately
- No confidence check needed — always fires
- Uses `launchJourneyForTicket()` from `src/lib/journey-delivery.ts`
- After linking completes, the original message is re-processed through the full pipeline with enriched context

### 3. Journey Re-nudge
- If customer replies to a ticket that has an active (uncompleted) journey → don't re-run pipeline
- First reply without completing → re-nudge with Haiku-rewritten lead-in
- Second reply without completing → escalate to agent
- Tracked via `journey_history` JSONB on the ticket

### 4. Positive Close Detection
- If message is a short positive reply ("thanks", "got it", etc.) AND ticket was previously auto-handled → close ticket
- Haiku generates closing message using channel personality
- Falls back to `auto_close_reply` workspace setting, then generic

### 5. Clarification Mode (if mid-clarification)
- If `ai_clarification_turn > 0` → don't re-run full pipeline
- Re-classify with Sonnet (upgraded model on turn 2+)
- If confidence reaches threshold → route
- If turn 3 reached → escalate with suggestion if confidence >= 50%
- Counter resets to 0 on any successful delivery

### 6. Pattern Match (deterministic, fast)
- Run `matchPatterns()` from `src/lib/pattern-matcher.ts`
- Keywords → embeddings → AI fallback (3-layer)
- If pattern matches a journey or workflow → route immediately

### 7. AI Intent Classification (Haiku backup)
- Only runs if pattern match didn't find anything
- Constrained to known handler intents — cannot invent categories
- Must return an intent from the handler list or "unknown"
- Vague/emotional messages without actionable request → "unknown"

### 8. Confidence Gate (per-channel)
- Threshold from `ai_channel_config.confidence_threshold` (stored as decimal 0-1, converted to 0-100)
- Below threshold → enter clarification mode, ask targeted question
- No customer + account-related intent → ask for email/order number

### 9. Route by Priority
1. **Journey** — `trigger_intent` or `match_patterns` on `journey_definitions`
2. **Workflow** — `trigger_tag` on `workflows` table
3. **Macro** — via pattern matcher embeddings
4. **KB Article** — RAG retrieval, creates `knowledge_gap` notification
5. **Escalate** — logs to `escalation_gaps` table, creates notification

### 10. Response Delay
- `step.sleep` for per-channel delay from `workspaces.response_delays`
- Email: 60s, Chat: 5s, SMS: 10s, etc.
- Durable — survives function restarts

### 11. Pre-send Stale Check
- Before sending, checks if a newer customer message or agent reply arrived since processing started
- If stale → bail out (the newer message's handler will process)
- Prevents double-sends and AI talking over agents

### 12. Send
- **Sandbox ON** → internal draft with `[AI Draft]` prefix, agent can "Approve & Send"
- **Sandbox OFF** → sends directly to customer
- Email uses `sendTicketReply` with proper `In-Reply-To` threading (ticket's `email_message_id`)

### 13. Set Status
- `auto_resolve: true` → ticket status = "closed"
- `auto_resolve: false` → ticket status = "pending"
- Never hardcoded — reads from `ai_channel_config`

### 14. Internal Notes
Every decision point logs a system internal note to the ticket:
- Customer resolution
- Intent classification with confidence %
- Confidence gate decision
- Route selection with reasoning
- Actions performed
- Escalation details

---

## Channel Capabilities

| Channel | Journey | Workflow | Macro | Clarify |
|---|---|---|---|---|
| Email | CTA email | Yes | Yes | Yes |
| Chat | Embedded form | Yes | Yes | Yes |
| SMS | Plain text link | Yes | Yes | Yes |
| Meta DM | Plain text link | Yes | Yes | Yes |
| Help Center | CTA email | Yes | Yes | Yes |
| Social Comments | No | No | Yes only | No |

---

## Key Files

| File | Purpose |
|---|---|
| `src/lib/inngest/unified-ticket-handler.ts` | The handler — all pipeline logic |
| `src/lib/journey-delivery.ts` | Generic journey launcher + re-nudge for all channels |
| `src/lib/journey-step-builder.ts` | Builds interactive steps dynamically per journey type |
| `src/lib/ai-context.ts` | Context assembler (customer, orders, subs, KB, personality) |
| `src/lib/pattern-matcher.ts` | 3-layer pattern matching (keywords → embeddings → AI) |
| `src/lib/rag.ts` | KB article retrieval via embeddings |
| `src/lib/workflow-executor.ts` | Workflow execution (called by handler) |
| `src/lib/email.ts` | `sendTicketReply` + `sendJourneyCTA` |
| `src/lib/ticket-tags.ts` | Tag helper |
| `src/lib/first-touch.ts` | First contact source tracking |

---

## Journey System

All journeys are **code-driven**. No static step configs in the DB.

### How It Works
1. `journey_definitions` table has `config: []` (empty) + `trigger_intent` + `match_patterns`
2. When a journey is launched, `launchJourneyForTicket()` creates a `journey_sessions` record with `config_snapshot: { codeDriven: true, journeyType: "..." }`
3. When the customer opens the mini-site, the `GET /api/journey/[token]` endpoint calls `buildJourneySteps()` to dynamically generate the interactive forms based on live customer data
4. The built steps are cached back to the session
5. `CodeDrivenJourney` component in the mini-site renders the steps
6. On completion, `POST /api/journey/[token]/complete` processes the responses and takes actions

### Journey Types
- **account_linking** — finds unlinked accounts, checklist + confirm
- **marketing_signup** — consent + phone collection
- **cancel** — delegates to portal cancel flow (`cancelJourney: true` flag)

### Journey Delivery Per Channel
- **Email / Help Center** → HTML CTA button email with AI lead-in
- **Chat** → Embedded inline form (hides send input, forces form interaction)
- **SMS / Meta DM** → Plain text message with URL link

### AI-Generated Lead-in + CTA
Every journey delivery includes:
- **Lead-in text** — Haiku writes it based on the customer's message tone
- **CTA button text** — action-specific, not generic ("Cancel my subscription →" not "Click here")

### Re-nudge Flow
1. Customer replies without completing journey → Haiku rewrites lead-in, re-sends
2. Customer replies again without completing → escalate to agent
3. Tracked via `journey_history` JSONB on tickets

---

## Webhook Entry Points

All channels fire the same event:

| Webhook | File | Event |
|---|---|---|
| Email (new) | `src/app/api/webhooks/email/route.ts` | `ticket/inbound-message` (is_new_ticket: true) |
| Email (reply) | `src/app/api/webhooks/email/route.ts` | `ticket/inbound-message` (is_new_ticket: false) |
| SMS (new) | `src/app/api/webhooks/sms/route.ts` | `ticket/inbound-message` (is_new_ticket: true) |
| SMS (reply) | `src/app/api/webhooks/sms/route.ts` | `ticket/inbound-message` (is_new_ticket: false) |
| Meta DM (new) | `src/app/api/webhooks/meta/route.ts` | `ticket/inbound-message` (channel: meta_dm) |
| Meta DM (reply) | `src/app/api/webhooks/meta/route.ts` | `ticket/inbound-message` (channel: meta_dm) |
| Social comment | `src/app/api/webhooks/meta/route.ts` | `ticket/inbound-message` (channel: social_comments) |
| Help center | `src/app/api/help/[slug]/tickets/route.ts` | `ticket/inbound-message` |
| Chat widget | `src/app/api/widget/[workspaceId]/messages/route.ts` | `ticket/inbound-message` |

---

## Database

### Ticket Fields Used by Handler
- `ai_clarification_turn` — 0-3 counter, resets on delivery
- `ai_detected_intent` — last classified intent
- `ai_intent_confidence` — last confidence score (0-100)
- `journey_history` — JSONB array of sent/nudged/completed journeys
- `handled_by` — "AI Agent", "Journey: Name", "Workflow: Name"
- `agent_intervened` — if true, handler skips entirely
- `email_message_id` — original inbound email Message-ID for threading

### Tables
- `ai_channel_config` — per-channel: enabled, confidence_threshold (0-1 decimal), auto_resolve, sandbox, personality_id
- `ai_personalities` — name, tone, style, sign-off, greeting, emoji_usage
- `journey_definitions` — trigger_intent, match_patterns, is_active
- `journey_sessions` — token, config_snapshot, status, responses
- `workflows` — trigger_tag, enabled
- `macros` — name, content, embeddings
- `escalation_gaps` — logged when nothing matches, for admin review
- `dashboard_notifications` — knowledge_gap + escalation_gap types

---

## What Was Removed

These files were deleted — the unified handler replaces all of them:

- `src/lib/chat-journey.ts` — old code-driven executors
- `src/lib/email-journey-builder.ts` — old combined journey builder
- `src/lib/discount-journey-builder.ts` — old discount-specific builder
- `src/lib/journey-launcher.ts` — old journey-specific launchers
- `src/lib/journey-suggest.ts` — old agent journey suggestions
- `src/lib/inngest/ai-multi-turn.ts` — old multi-turn AI handler
- `src/lib/inngest/ai-draft.ts` — old AI draft function
- `src/lib/inngest/workflow-delayed.ts` — old delayed workflow execution
- `src/lib/ai-draft.ts` — old draft generation logic
- `src/lib/turn-router.ts` — old turn routing

---

## AI Model Usage

| Context | Model | Why |
|---|---|---|
| Intent classification (first pass) | Haiku | Fast, cheap, sufficient for clear intents |
| Clarification turn 2+ | Sonnet | Smarter for nuanced follow-ups |
| Clarification question generation | Haiku | Short output, speed matters |
| Journey lead-in + CTA text | Haiku | Brief, tone-matching |
| Macro personalization | Haiku | Light touch, keep same length |
| KB article response | Haiku | Extract and summarize |
| Positive close message | Haiku | Brief, warm |
| Journey re-nudge | Haiku | Empathetic rewrite |

---

## Configuration

All behavior is configurable per channel in Settings → AI Agent:

- **Enabled** — on/off per channel
- **Sandbox** — drafts only, agent must approve
- **Auto Resolve** — close ticket after AI responds
- **Confidence Threshold** — 0-1 decimal (converted to 0-100 internally)
- **Personality** — assigned per channel, used in all AI calls
- **Response Delays** — per channel in workspace settings (seconds)
