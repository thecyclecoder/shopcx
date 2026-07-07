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
- `workflow` — run via `executeWorkflow()` (template-based, deterministic). The workflow executor sets the **authoritative final status itself** inside `sendReply` (e.g. `account_login` → `closed`, `return_to_sender` → `open`), so the action returns `statusManaged: true` and Phase 5 leaves the status untouched (see below).
- `macro` / `kb_response` / `ai_response` — send Sonnet's response.
- `escalate` — assign to agent, send holding message, set `tickets.escalated_to` + `escalation_reason`.

The executor writes an internal note + a fresh `ticket_messages` row for every customer-visible action.

**Write-ahead ledger — [[../tables/ticket_resolution_events]].** At the TOP of `executeSonnetDecision`, before any dispatch, `stageResolutionEvent` inserts one [[../tables/ticket_resolution_events]] row with `staged_at = now()` + `turn_index` + `reasoning` (+ Phase 2's `problem` / `confidence` / `options` / `chosen`). Every branch above shares that row: the outer `send` is wrapped in `stampedSend`, so any customer-facing message — direct-action confirmation, journey/playbook mid-flight sends, workflow's own `sendReply`, `ai_response`, or a clarification — stamps `shipped_at` on the same row (compare-and-set on NULL). At the end of the dispatch, `verified_at` + `verified_outcome` are stamped: `direct_action` writes its own verdict from `verifyActionInDB` (`confirmed` on pass, `drifted` on a claim the DB can't back — this fires FIRST so the more-specific verdict wins the idempotent stamp); message-only branches get a return-time `confirmed` from the executor when `messageSent`/`statusManaged`/`_closedThisRun`; `escalate` paths leave `verified_outcome` NULL for M4's compiler loop to close out. See [[../specs/ticket-resolution-events-writeahead-ledger-and-decision-schema-extension]] and [[../goals/guaranteed-ticket-handling]] § M2 "The resolution record (the spine)".

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

After the executor returns, the post-execute status block (`unified-ticket-handler.ts`, decision in the pure `postExecuteStatusAction()` helper) resolves the final status. Order matters — first match wins:

1. **escalated** → leave open; an agent owns it.
2. **statusManaged** → a workflow already set the authoritative status (`account_login` → closed, `return_to_sender` → open); **leave it untouched.** This branch must come before the message/close checks — routing through `setStatus` would force `closed` and reopen-then-close an intentionally-open workflow. (Ticket `a89dcf76` Mindy Freeman: the `account_login` magic-link close was being reopened as "no customer message sent" because the `workflow` action never reported it had set a status.)
3. **closed** → a `close_ticket` direct action ran (e.g. OOO auto-reply); leave closed.
4. **messageSent** → `ai_response`/macro/etc. sent a complete reply (not a clarification); auto-close via `tickets.status = 'closed'` + `closed_at = now()`. The customer's next reply reopens it.
5. **no action** → nothing happened; escalate to the To-Do routine if agent-involved, else keep open for organic review.

Exception: if the action failed silently (e.g. Appstle call returned `{ success: false }`), the ticket stays open — Sonnet never tells the customer something was done unless [[../tables/customer_events]] confirms it. See [[../lifecycles/ai-multi-turn]] rule "Never fake confirmations."

### Escalation lifecycle — set → visible → cleared

Escalation (`tickets.escalated_at` / `escalated_to` / `escalation_reason`) is an **open-state** concept with three moments:

- **Set.** The `escalate` action (Phase 2f) or the agent-involved no-action path (Phase 5 #5) flags the ticket. The default route is the **routine** (`escalated_to IS NULL`, `escalated_at` set) — see [[../specs/escalate-to-routine-by-default]] — which the box triage cron ([[../inngest/triage-escalations]] / [[../specs/box-escalation-triage]]) picks up.
- **Visible — "AI Investigation."** A routine-escalated ticket renders a **"🔍 Escalated → AI Investigation"** badge (amber) on the ticket header/list/[[../dashboard/tickets__escalated|Escalated view]], appending "· triage in progress" when a live `triage-escalations` job exists for the workspace (`GET /api/tickets/triage-status` + `useTriageInProgress()`). Triage leaves a paper trail of internal `[AI Investigation]` notes (start + outcome) so a human knows the AI is working it and can still step in — escalating to a person sets `escalated_to` and flips the badge off. Full detail in [[../dashboard/tickets]].
- **Cleared.** Resolving ends escalation: every terminal-status write path (`maybeAutoCloseGroup`/`executeTicketClose`, manual + bulk close, workflow/journey/portal closes, the unified handler's spam/fraud closes) sets all three flags to `null` in the same update, and the Escalated view additionally filters out `closed`/`resolved`/`archived`. So no terminal-status ticket ever carries escalation flags. **Reopening does NOT auto-re-escalate** — escalation is a fresh decision.

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

## Status / open work

**Shipped:** All seven phases — inbound capture (Resend, Twilio, Meta, chat widget), unified pipeline (resolve → fraud short-circuit → playbook/Sonnet → execute), outbound delivery (deliver-pending-send cron), engagement tracking (email_events, SMS callbacks), auto-resolve, CSAT, archive. Sandbox mode + agent-involved escalation gaps both closed. Escalation lifecycle complete: routine-escalated tickets show the "🔍 AI Investigation" badge + triage paper-trail notes, and all three escalation flags clear on every terminal-status write path (Escalated view also filters terminal statuses).

**Known gaps / not yet shipped:** Ticket-detail Commerce SDK migration (spec [[../specs/commerce-sdk-migrate-ticket-detail]] — parent goal milestone M4 — Migrate internal surfaces). Phase 1 enumeration is landed below; Phase 2 repoints reads onto `commerce/*` Display ops; Phase 3 repoints mutations onto `commerce/*` Mutation ops and ADDS the currently-missing `change_frequency` + `switch_payment_method` actions; Phase 4 gates ticket-detail on `scripts/_check-ticket-detail-sdk-only.ts` and retires the raw fetches. The § Files touched list above will get updated in Phase 4 to point at `commerce/*` instead of `appstle.ts` + `enrich-pricing.ts` for ticket-detail rows.

### Ticket-detail SDK migration — Phase 1 enumeration

The spec's Phase 1 verification bullet requires a mapping table pinned into this § Status / open work block. Below: every ticket-detail read (server component loader + client-side card fetches + Improve tab context) and every mutation the surface offers, mapped to the SDK Display / Mutation op that replaces it and the ticket-lifecycle § phase it participates in. The full companion table lives on [[../reference/commerce-sdk-inventory]] § 1 Surface map → Ticket detail (Support).

**Reads → Display ops**

| # | Site | Current call (file:line) | SDK op | § Phase reference |
|---|---|---|---|---|
| R1 | Customer identity + linked group + LTV rollup | `src/app/api/tickets/[id]/route.ts:65,73–79,102` (`.from("customers")` + `.from("customer_links")` + `@/lib/customer-stats#getCustomerStats`) | `commerce/customer.getCustomer` | § Phase 2e — Sonnet orchestrator context |
| R2 | Subscription hydration (engine-priced) | `src/app/api/tickets/[id]/route.ts:88,95` (`.from("subscriptions")` + `@/lib/portal/helpers/enrich-pricing#priceSubItemsForDisplay`) | `commerce/subscription.listSubscriptionsByCustomer` | § Phase 2e — Sonnet orchestrator context |
| R3 | Orders list (recent 10) | `src/app/api/tickets/[id]/route.ts:82` (`.from("orders")`) | `commerce/order.listOrdersByCustomer` | § Phase 2e — Sonnet orchestrator context |
| R4 | Returns list | `src/app/dashboard/tickets/[id]/page.tsx:541–542` → `/api/workspaces/[id]/returns?ticket_id=…&customer_id=…` | `commerce/return.listReturnsByCustomer` | § Phase 2f executor (`create_return`) / § Phase 5 auto-resolve |
| R5 | Replacements list | `src/app/dashboard/tickets/[id]/page.tsx:553–554` → `/api/workspaces/[id]/replacements?ticket_id=…&customer_id=…` | `commerce/replacement.listReplacementsByCustomer` | § Phase 2f executor (`create_replacement`) |
| R6 | Loyalty balance + redemption tiers + workspace loyalty settings | `src/app/dashboard/tickets/[id]/page.tsx:519–532` → `/api/loyalty/members`, `/api/loyalty/redemptions`, `/api/workspaces/[id]/loyalty` | `commerce/loyalty.getLoyaltyBalance` | § Phase 2f executor (`redeem_points`, `apply_loyalty_coupon`) |
| R7 | Chargebacks list | `src/app/dashboard/tickets/[id]/page.tsx:565` → `/api/chargebacks?customer_id=…` | `commerce/chargeback.listChargebacksByCustomer` | § Cast of characters — chargeback context (agent-facing sidebar card) |
| R8 | Fraud posture | `src/app/dashboard/tickets/[id]/page.tsx:571` → `/api/workspaces/[id]/fraud-cases?customer_id=…` | `commerce/fraud.getFraudPosture` | § Phase 2c — fraud short-circuit |
| R9 | Crisis context | `src/app/dashboard/tickets/[id]/page.tsx:2941` (`<CrisisEnrollmentCard>`) → `/api/customers/[id]/events` + workspace crisis query | `commerce/crisis.getCrisisContext` | § Phase 2f executor (crisis journeys) |

**Mutations → Mutation ops**

The Improve tab's plan executor (`src/lib/improve-plan-executor.ts:93`) dispatches an approved `orchestrator_action` through `executeSonnetDecision` in `src/lib/action-executor.ts`, so every direct-action handler listed below is reachable from ticket-detail. The two rows tagged **Phase 3 ADD** are the currently-MISSING subscription actions the spec's Phase 3 verification bullet requires the migration to ADD — the handlers already exist in `action-executor.ts`, but no ticket-detail UI trigger surfaces them today.

| # | Action | Current dispatcher (file:line) | SDK op | § Phase reference |
|---|---|---|---|---|
| M1 | `refund` (Improve tab + AI `partial_refund`) | `src/app/api/tickets/[id]/order-actions/route.ts:97` → `@/lib/refund#refundOrder`; `src/lib/action-executor.ts:1050` (`partial_refund`) → same | `commerce/refund.issueRefund` (M2c — preserves internal→Braintree / Shopify→REST routing) | § Phase 2f — action executor |
| M2 | `apply_coupon` | `src/lib/action-executor.ts:597` → `@/lib/coupons#applyCoupon` | `commerce/subscription.applyCoupon` (M2c — LOYALTY-* redirect from `apply_loyalty_coupon` preserved) | § Phase 2f — action executor |
| M3 | `remove_coupon` | `src/lib/action-executor.ts:616` → `@/lib/coupons#removeCoupon` | `commerce/subscription.removeCoupon` (M2c) | § Phase 2f — action executor |
| M4 | `pause` | `src/lib/action-executor.ts:1182` → `@/lib/appstle#appstleSubscriptionAction("pause")` | `commerce/subscription.subscriptionAction(id, "pause")` | § Phase 2f — action executor |
| M5 | `resume` | `src/lib/action-executor.ts:345` → `@/lib/appstle#appstleSubscriptionAction("resume")` | `commerce/subscription.subscriptionAction(id, "resume")` | § Phase 2f — action executor |
| M6 | `cancel` (via cancel-flow / cancel_now) | `src/lib/action-executor.ts` (cancel branch) → `@/lib/appstle#appstleSubscriptionAction("cancel")` | `commerce/subscription.subscriptionAction(id, "cancel")` | § Phase 2f — action executor |
| M7 | `skip_next_order` | `src/lib/action-executor.ts:442` → `@/lib/appstle#appstleSkipNextOrder` | `commerce/subscription.subscriptionSkipNextOrder` | § Phase 2f — action executor |
| M8 | `change_next_date` | `src/lib/action-executor.ts:456` → `@/lib/appstle#appstleUpdateNextBillingDate` | `commerce/subscription.subscriptionUpdateNextBillingDate` | § Phase 2f — action executor |
| M9 | `swap_variant` | `src/lib/action-executor.ts:570` → `@/lib/subscription-items#subSwapVariant` | `commerce/subscription.subscriptionSwapVariant` | § Phase 2f — action executor |
| M10 | `add_item` | `src/lib/action-executor.ts:500` → `@/lib/subscription-items#subAddItem` | `commerce/subscription.subscriptionAddItem` | § Phase 2f — action executor |
| M11 | `remove_item` | `src/lib/action-executor.ts:519` → `@/lib/subscription-items#subRemoveItem` | `commerce/subscription.subscriptionRemoveItem` | § Phase 2f — action executor |
| M12 | `bill_now` | `src/lib/action-executor.ts:494` → `@/lib/appstle#orderNowByContract` | `commerce/subscription.subscriptionOrderNow` | § Phase 2f — action executor |
| M13 | `apply_loyalty_coupon` (composite redeem_points ↦ applyCoupon) | `src/lib/action-executor.ts:732` → `@/lib/loyalty` + `@/lib/coupons` | `commerce/loyalty.spendPoints` + `commerce/subscription.applyCoupon` (M2c — the LOYALTY-* redirect the executor documents is preserved by the dispatcher) | § Phase 2f — action executor |
| M14 **Phase 3 ADD** | `change_frequency` — *currently not exposed on ticket-detail*; handler exists at `src/lib/action-executor.ts:448` but no UI trigger | (not exposed) | `commerce/subscription.subscriptionUpdateBillingInterval` — Phase 3 wires the UI (per `commerce-sdk-inventory` watch-item) | § Phase 2f — action executor |
| M15 **Phase 3 ADD** | `switch_payment_method` — *currently not exposed on ticket-detail*; handler exists at `src/lib/action-executor.ts:1800` but no UI trigger | (not exposed) | `commerce/subscription.subscriptionSwitchPaymentMethod` — Phase 3 wires the UI (per `commerce-sdk-inventory` watch-item) | § Phase 2f — action executor |

**Also in flight:** Ticket resolution write-ahead ledger + SonnetDecision schema extension (spec [[../specs/ticket-resolution-events-writeahead-ledger-and-decision-schema-extension]] — parent goal [[../goals/guaranteed-ticket-handling]] § M2 "The resolution record (the spine)"). Phase 1 has landed [[../tables/ticket_resolution_events]] + wired the write-ahead insert + shipped/verified stamps into [[../libraries/action-executor]] `executeSonnetDecision` (§ Phase 2f above). Phase 2 has landed the `SonnetDecision` schema extension: [[../libraries/sonnet-orchestrator-v2]] now carries `problem` / `confidence` / `options` / `chosen` on the interface; `buildSystemPrompt` asks the model for them; `parseSonnetDecision` warns + increments the `[resolution-schema-adoption]` counter (in `resolutionSchemaAdoption`) whenever a real (non-fallback) decision omits any of the four; `stageResolutionEvent` in [[../libraries/action-executor]] range-guards the values (confidence ∈ [0,1], options must be an array) and lands them on [[../tables/ticket_resolution_events]] per turn — the substrate M1's inline verify block reads against, M2's confidence-gated clarify keys off, and M4's compiler loop mines.

**Recent activity:**
- `a6844aaa` CSAT: resolution-gate survey + cron-driven send + dashboard
- `096c8b3b` Orchestrator: escalate when no-action path lands on an agent-involved ticket
- `af32d630` Delete stale CSAT [id] routes — superseded by [ticketId]

**Open questions:** None.

## Related

[[ai-multi-turn]] · [[fraud-detection]] · [[customer-link-confirmation]] · [[social-comment-moderation]] · [[../inngest/unified-ticket-handler]] · [[../inngest/deliver-pending-send]] · [[../inngest/triage-escalations]] · [[../dashboard/tickets__escalated]] · [[../tables/tickets]] · [[../tables/ticket_messages]]
