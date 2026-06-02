# Ticket lifecycle

End-to-end trace of what happens to a customer message from the moment it lands in our system until the ticket auto-closes and the CSAT survey fires. This is the single hottest path in the platform — every email, chat message, social comment, DM, and SMS flows through it.

## Cast of characters

- Inbound transports: [[../integrations/resend]] (email parse webhook), [[../integrations/twilio]] (SMS), [[../integrations/meta-graph]] (DMs + comments), the chat widget HTTP endpoint.
- Brain: [[../inngest/unified-ticket-handler]] — the main pipeline. Routes every message through resolve → playbook check → Sonnet orchestrator → execute.
- Persistence: [[../tables/tickets]], [[../tables/ticket_messages]], [[../tables/customers]], [[../tables/customer_links]], [[../tables/customer_events]].
- Brain config: [[../tables/sonnet_prompts]], [[../tables/ai_channel_config]], [[../tables/ai_personalities]], [[../tables/policies]].

## Phase 1 — inbound capture

The transport-specific webhook lands somewhere under `src/app/api/webhooks/...`. Each handler does the same five things:

1. **Verify signature.** Resend uses HMAC against `workspaces.resend_webhook_signing_secret`. Meta uses an SHA-256 signature against the app secret. Twilio uses the standard request validator with `TWILIO_AUTH_TOKEN`. Mis-signed payloads get a 401 and never enter the system.
2. **Match the workspace.** Email → `to` address ↔ `workspaces.support_email`. Meta → `entry.id` ↔ `workspaces.meta_page_id` / `meta_instagram_id`. SMS → recipient phone ↔ `workspaces.twilio_phone_number`. Chat → workspace id is in the widget URL.
3. **Match the customer.** Email or phone against [[../tables/customers]] (workspace-scoped). For Meta DMs, the sender id goes through [[../tables/meta_sender_customer_links]] first, falling back to the [[customer-link-confirmation]] flow if unmatched.
4. **Match or create the ticket.** Email uses `In-Reply-To` / `References` headers against `tickets.email_message_id`. Chat reuses the widget session's open ticket. Social comments + DMs match by `meta_post_id` + `meta_sender_id`. If nothing matches, a new ticket gets inserted with `status='open'`, `handled_by=null`.
5. **Persist the message.** A row gets inserted into [[../tables/ticket_messages]] with `direction='inbound'`, `visibility='public'`, `author_type='customer'`, `body` (raw HTML or text), `body_clean` (HTML-stripped, quoted-history removed via `src/lib/email-cleaner.ts`).

Then the handler fires `inngest.send({ name: "ticket/inbound-message", data: { workspace_id, ticket_id, message_body, channel, is_new_ticket }})` and returns 200. From here, durability is Inngest's job.

## Phase 2 — the unified pipeline

[[../inngest/unified-ticket-handler]] picks up the event. Concurrency is keyed on `event.data.ticket_id` with limit 1 — at most one in-flight handler per ticket, which is how we serialize against double-firing customers and webhook retries.

### Step 2a — resolve

Load the ticket, the customer (and any [[../tables/customer_links]] group), the workspace's [[../integrations/anthropic]] config from [[../tables/ai_channel_config]], the active personality from [[../tables/ai_personalities]], the recent message history, and the workspace's `sandbox_mode` flag.

If the customer is unmatched (anonymous chat, mailer-daemon, etc.), the handler attempts auto-link via `src/lib/auto-link-customer-from-message.ts` — extracting order numbers, email addresses, phone numbers from the message body and looking them up.

### Step 2b — agent intervention check

Read `tickets.agent_intervened`. If true, the AI's behavior shifts permanently — no auto-resolve, deferential tone, never claim authority over decisions a human made. See feedback_ai_response_quality. We do NOT bail on the orchestrator just because an agent intervened — Sonnet still drafts in sandbox mode for the agent's "Approve & Send" button.

### Step 2c — fraud short-circuit

Before Sonnet runs, `getCustomerFraudStatus()` checks [[../tables/fraud_cases]] across the customer's link group. If any case is `confirmed_fraud` or any rule is `amazon_reseller`, the orchestrator is bypassed entirely:

- Send `CONFIRMED_FRAUD_REPLY` ("We're sorry but your account has been flagged for potential fraud.").
- Tag ticket `confirmed_fraud`, close, escalate to the fraud queue.
- Do not run any actions, do not consume an AI turn.

See feedback_orchestrator_fraud_gate.

### Step 2d — active playbook step

If `tickets.active_playbook_id` is set, the unified handler delegates to [[../playbooks]] step execution before Sonnet sees the message. Playbooks are deterministic state machines — they own the conversation until they hit a terminal step. Sonnet only runs if no playbook is active.

### Step 2e — Sonnet orchestrator

This is the brain. See [[ai-multi-turn]] for the full multi-turn detail. In one sentence: Sonnet gets minimal pre-loaded context (~300 tokens), a catalog of on-demand data tools ([[../tables/customers]] / [[../tables/orders]] / [[../tables/subscriptions]] / [[../tables/returns]] / [[../tables/chargeback_events]] / [[../tables/crisis_customer_actions]] / etc.), and the rule pack from [[../tables/sonnet_prompts]] + [[../tables/policies]]. It returns a `SonnetDecision` JSON with `action_type` + `actions[]` + `response_message`.

### Step 2f — action executor

`src/lib/action-executor.ts` dispatches the decision:

- `direct_action` — execute subscription/loyalty/coupon ops directly via [[../integrations/appstle]] / [[../integrations/shopify]].
- `journey` — look up by name OR trigger_intent, launch via `launchJourneyForTicket()` (see [[../journeys]]).
- `playbook` — start via `startPlaybook()` (see [[../playbooks]]).
- `workflow` — run via `executeWorkflow()` (template-based, deterministic).
- `macro` / `kb_response` / `ai_response` — send Sonnet's response.
- `escalate` — assign to agent, send holding message, set `tickets.escalated_to` + `escalation_reason`.

The executor writes an internal note + a fresh `ticket_messages` row for every customer-visible action.

## Phase 3 — outbound delivery

Outbound rows insert with `direction='outbound'`, `pending_send_at = now() + workspaces.response_delays[channel]`. The customer-visible UI shows the message immediately, with Edit + Cancel buttons during the pending window.

The actual send is handled by [[../inngest/deliver-pending-send]] — a per-minute cron that scans `pending_send_at <= now()`. For each, it:

- Picks the transport based on `tickets.channel`:
  - email → [[../integrations/resend]] `/emails` POST with `In-Reply-To` + `References` set from the ticket's threading headers
  - SMS → [[../integrations/twilio]] `Messages.json` POST
  - chat → updates the widget session; the open WebSocket polls it
  - social_comments + meta_dm → [[../integrations/meta-graph]] comment-reply / DM POST
- Writes `resend_email_id` / `message_sid` / etc. back onto the row.
- Drops an [[../tables/email_events]] `sent` event.

## Phase 4 — engagement tracking

For email, [[../tables/email_events]] gets populated via our self-hosted pixel + click redirect (see [[../integrations/resend]] gotchas). The pixel writes `opened` events on first image load; the redirect writes `clicked` events. Both keyed on `resend_email_id`.

For SMS, Twilio status callbacks fire `delivered` / `failed` events back to our webhook → join via `sms_campaign_recipients.message_sid` for marketing, or directly onto the ticket message for transactional.

## Phase 5 — auto-resolve

If the action was `ai_response` and the response was a complete reply (not a clarification question), the orchestrator auto-closes the ticket via `tickets.status = 'closed'` + `closed_at = now()`. The customer's next reply reopens it.

Exception: if the action failed silently (e.g. Appstle call returned `{ success: false }`), the ticket stays open — Sonnet never tells the customer something was done unless [[../tables/customer_events]] confirms it. See SONNET-ORCHESTRATOR.md rule "Never fake confirmations."

Tags applied along the way (idempotent via `src/lib/ticket-tags.ts`):

- `touched` + `ft:{source}` — first outbound touch
- `ai:t{N}` — AI turn count (replaces on each turn)
- `agent` — if a real human ever sent outbound
- `j:{intent}` / `w:{type}` / `pb:{slug}` — journey / workflow / playbook applied

## Phase 6 — CSAT

24 hours after `closed_at`, [[../inngest/ticket-csat]] fires a CSAT survey email/SMS. Response writes `tickets.csat_score`. No response is fine — the survey is non-blocking and never reopens the ticket.

## Phase 7 — archive

Closed tickets older than the retention threshold get `archived_at` stamped by [[../inngest/auto-archive]]. Archived tickets are hidden from the default ticket queue but remain queryable. They're soft-archive only — no row is ever deleted.

## Sandbox mode

When `workspaces.sandbox_mode = true`, every outbound message from the AI becomes an internal note instead of a customer-visible reply. The agent sees a draft they can "Approve & Send" — clicking that flips visibility to public and inserts a fresh outbound row. Useful for trialing prompt changes without risk.

## Channel-specific quirks

- **Email**: `email_message_id` (Gmail Message-ID) on the ticket is the threading anchor for ALL outbound — including journey CTAs. Don't use `resend_email_id` for threading; that's only on emails we sent.
- **Chat**: a customer message containing "send you an email" triggers `chatEnded` in the widget — disables input, hides typing bubbles, shows "conversation ended."
- **Social comments**: never get journeys delivered. Never. See [[../journeys]] § channel rules.
- **Meta DM**: outbound is rate-limited by Meta's 24h window — replies after 24h require the human_agent tag.

## Files touched

| File | Purpose |
|---|---|
| `src/app/api/webhooks/resend/route.ts` | Email inbound webhook handler |
| `src/app/api/webhooks/twilio-sms/route.ts` | SMS inbound webhook handler |
| `src/app/api/webhooks/meta/route.ts` | Meta DM + comment inbound webhook |
| `src/app/api/widget/[workspaceId]/message/route.ts` | Chat widget inbound |
| `src/lib/inngest/unified-ticket-handler.ts` | THE pipeline |
| `src/lib/sonnet-orchestrator-v2.ts` | Orchestrator brain with tool-use |
| `src/lib/action-executor.ts` | Dispatches SonnetDecision |
| `src/lib/auto-link-customer-from-message.ts` | Auto-link unmatched senders |
| `src/lib/customer-fraud-status.ts` | Confirmed-fraud short-circuit |
| `src/lib/email-cleaner.ts` | Strip quoted history for `body_clean` |
| `src/lib/email-utils.ts` | Threading headers builder |
| `src/lib/email.ts` | Resend send wrapper |
| `src/lib/ticket-tags.ts` | Idempotent tag helper |
| `src/lib/first-touch.ts` | First-touch source tagging |
| `src/lib/escalation.ts` | Round-robin agent assignment |
| `src/lib/rag.ts` | RAG retriever (KB + macros) |
| `src/lib/ai-context.ts` | Pre-loaded context for orchestrator |
| `src/lib/ai-usage.ts` | Token accounting |
| `src/lib/inngest/deliver-pending-send.ts` | Outbound delivery cron |
| `src/lib/inngest/ticket-csat.ts` | CSAT survey 24h post-close |
| `src/lib/inngest/auto-archive.ts` | Archive old closed tickets |

## Related

[[ai-multi-turn]] · [[fraud-detection]] · [[customer-link-confirmation]] · [[social-comment-moderation]] · [[../inngest/unified-ticket-handler]] · [[../inngest/deliver-pending-send]] · [[../tables/tickets]] · [[../tables/ticket_messages]]
