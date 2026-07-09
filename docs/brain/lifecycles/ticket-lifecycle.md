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

### Phase 2b-pre — Outreach handling (deterministic close, no Sol dispatch, zero AI on automated senders)

[[../specs/outreach-tickets-deterministically-close-no-sol-dispatch-no-ai-cost]]. BEFORE the Sol first-touch dispatch below fires, two deterministic short-circuit lanes decide whether the ticket even qualifies for a Max-tier handling session. Outreach = brand-collab / UGC / partnership / cold sales pitch AND automated no-reply notifications (App Store receipts, TestFlight builds, mailer daemons, GitHub notifications, marketing "please do not reply" retailer blasts). Every outreach ticket ends `status='closed'`, tagged `outreach` + `cls:outreach`, with NO customer-facing reply and NO `ticket-handle` `agent_jobs` row — a Max ticket-handle session costs real money per ticket, and outreach is never a customer-service request.

Both lanes dispatch through the pure [[../libraries/outreach-route]] `decideOutreachRoute` predicate; the FOUR Phase-3 verification tests in `src/lib/outreach-route.test.ts` pin its behavior so the shipped handler runs the SAME routing invariant the tests exercise (not a docstring description of it).

- **§ 1a2 — Phase 2: automated-sender pre-filter (ZERO AI cost).** Ahead of the classify-bucket Haiku step, `decideOutreachRoute` runs [[../libraries/automated-sender]] `isAutomatedInbound` over the inbound's From address (`st.custEmail` — the email webhook creates the customers row from the sender, so the customer email column IS the From address) + body. On a hit, the step `outreach-automated-sender-pre-filter` stamps `cls:outreach` + `outreach`, closes via `setStatus`, writes a system note citing the sender, and returns — the classifier is never invoked and NO AI dollars are spent on the ticket. Conservative on purpose per the spec's false-positive-averse mandate: matches known no-reply local parts (`no[-_]?reply|donotreply|do[-_]not[-_]reply` OR standalone `mailer[-_]daemon|postmaster|bounces?`), a narrow automated-domain allowlist (`email.apple.com`, `bounces.google.com`, `noreply.github.com`, `notify.trustpilot.com` + subdomains), and four unambiguous body markers ("please do not reply to this email", "this mailbox is not monitored", "this is an automated email", "you are receiving this email because you subscribed"). Genuine customer emails (Gmail, Yahoo, work addresses) are NEVER caught — the 12 tests in `automated-sender.test.ts` pin that.
- **§ 1c — Phase 1: classifier-bucket outreach short-circuit.** For human brand-collab / UGC pitches that don't match the deterministic pre-filter, the cheap Haiku classifier (10 output tokens) runs and returns `outreach`. `decideOutreachRoute(..., classifierBucket: msgType)` then returns `kind: "classifier_close"` and the step `outreach-deterministic-close` closes + writes a system note; the `outreach` tag was already stamped at § 1b. Every downstream paid lane — Sol first-touch dispatch (Phase 2b below), inflection gate (Phase 2e's pre-`stampedSend` `applyInflectionGate`), Sonnet orchestrator (Phase 2e itself) — is bypassed by the early return.
- **Belt-and-suspenders on the parallel dispatch lanes.** Both the Sol first-touch dispatch predicate (Phase 2b below) and the Sonnet-orchestrator entry (Phase 2e) additionally check `msgType !== "outreach"`. The primary short-circuit at § 1c already returned above, so these checks only fire if a future refactor moves the outreach block — pinning the classifier bucket into the parallel dispatch predicates prevents an accidental leak of an outreach ticket into a paid handling session.

### Phase 2b — Sol first-touch dispatch

Phase 3 of [[../specs/sol-ticket-direction-artifact-and-first-touch-box-session]] + Phase 1 of [[../specs/sol-first-touch-ack-only-on-chat-not-async-channels]] (chat-only ack). When the event is `is_new_ticket=true` AND [[../tables/ai_channel_config]] has `sol_first_touch_enabled=true` for the ticket's channel AND no agent is involved (`agent_intervened` / `assigned_to` / `escalated_to` all null) AND fraud didn't block (Step 2c below still runs first), the handler enqueues an `agent_jobs` row (`kind='ticket-handle'`, `instructions` = `{ticket_id, workspace_id, turn_index, reason:'first_touch'}`) that runs [[../functions/cs|Sol]]'s box session on Max via the box worker's `runTicketHandleJob` (see [[../libraries/ticket-directions]] for the `writeDirection` SDK Sol calls). The inline Sonnet Step 2e path below is **skipped for this turn**. The **first-touch ack is chat-only**: on `channel === 'chat'` (customer waiting live) the handler ALSO ships a short holding message via the standard `send()` wrapper right now — customer sees a response within seconds, `ticket_resolution_events.shipped_at` is stamped on turn 1, Sol's real reply arrives on turn 2. On async channels (email/sms/portal/meta_dm) the ack send AND its `ticket_resolution_events` ack row are **skipped** — a redundant "we'll get back to you" is noise when Sol's substantive real reply is what the customer will next see; Sol authors turn 1 directly and her real reply is the sole first-touch customer message. Every subsequent cheap-execution turn reads the durable [[../tables/ticket_directions]] row Sol authored instead of re-running full-context reasoning — the M1 spine of [[../goals/sol-ticket-direction-then-cheap-execution]]. Default is **off** (`sol_first_touch_enabled=false`); rollout is opt-in per workspace+channel.

**Policy review guard — [[../libraries/sol-policy-bait-guard]] `assessSolReplyBaitRisk`.** On Sol's DRAFT `first_reply` (and every subsequent Sol reply), before `deliverTicketMessage` fires, the guard runs a deterministic check: (1) if `context_summary` declares an ask out-of-policy but the reply still promises a remedy, the send is BLOCKED; (2) any reply stacking multiple returns/refunds/labels in one turn is BLOCKED unconditionally (the returns policy caps at one MBG return per customer for life). A block writes the reason to the job's `log_tail` for a human re-draft; the Direction is never rolled back. The guard pairs with the three durable Sol operating rules on [[../libraries/ticket-directions]] and [[../tables/policies]].

**Re-session bounce — [[../libraries/inflection-detector]] `reSessionSol`.** Every subsequent cheap-execution turn is checked by [[../libraries/inflection-detector]] `detectInflection` BEFORE the drafted reply hits `stampedSend` (§ Phase 2f write-ahead ledger). On a `'drift'` or `'frustration'` verdict the reply is HELD and the Phase-2 gate calls `reSessionSol(admin, ticket_id, {kind, evidence, turn_index})` which (1) supersedes the currently-live [[../tables/ticket_directions]] row via `superseDirection`'s compare-and-set — so a racing caller can't fan out a duplicate session — and (2) inserts a NEW `agent_jobs` row `kind='ticket-handle'` `instructions = {ticket_id, workspace_id, turn_index, reason:'inflection', kind, evidence, superseded_direction_id}` for the box worker's `runTicketHandleJob` to author a fresh Direction. The router itself **NEVER** sends a customer-facing message — the corrected reply is the new box session's job once it commits the new Direction, keeping the [[../tables/ticket_directions]] ledger a clean "one Direction per intent" history. On `'frustration'` (drift is silent by default) the gate site additionally sends a short "we're looking into that for you" inline holding message via `stampedSend` before calling the router — governed by [[../tables/ai_channel_config]] `sol_frustration_holding_message_enabled` (default `true`, workspace-tunable). The DB-level partial UNIQUE `(ticket_id) WHERE superseded_at IS NULL` keeps exactly one live Direction per ticket at any moment.

### Step 2c — fraud short-circuit

Before Sonnet runs, `getCustomerFraudStatus()` checks [[../tables/fraud_cases]] across the customer's link group. If any case is `confirmed_fraud` or any rule is `amazon_reseller`, the orchestrator is bypassed entirely:

- Send `CONFIRMED_FRAUD_REPLY` ("We're sorry but your account has been flagged for potential fraud.").
- Tag ticket `confirmed_fraud`, close, escalate to the fraud queue.
- Do not run any actions, do not consume an AI turn.

See feedback_orchestrator_fraud_gate.

### Step 2d — active playbook step

If `tickets.active_playbook_id` is set, the unified handler delegates to [[../playbooks]] step execution before Sonnet sees the message. Playbooks are deterministic state machines — they own the conversation until they hit a terminal step. Sonnet only runs if no playbook is active.

### Step 2d.1 — Sol dispatch: catalog lookup → mechanism-typed Direction → apply

[[../specs/sol-dispatch-matches-journey-playbook-workflow-via-sdk-not-freeform-cta]] — the deterministic path that pins Sol's first-touch Direction to a REAL catalog row (not a prose "click below") AND applies the matched mechanism on the cheap-execution turn without paying for Sonnet:

- **Catalog lookup (Phase 1) — [[../libraries/cx-agent-sdk]] `listActionableOutcomes`.** Sol's first-touch box session consults a read-only, workspace-scoped SDK reader that returns the ACTIVE [[../tables/journey_definitions]] (matched by `trigger_intent` + optional channels intersect), [[../tables/playbooks]] (case-insensitive membership in `trigger_intents[]`), and [[../tables/workflows]] (case-insensitive `trigger_tag`) for the resolved intent. An empty catalog is the deterministic "no active mechanism → `chosen_path='stateless'`" signal; a non-empty catalog is Sol's signal to name a specific `journey_slug` / `playbook_slug` on the Direction.

- **Mechanism-typed Direction (Phase 1) — [[../libraries/ticket-directions]] `writeDirection`.** The `ticket_direction_path` enum gains the fourth value `'journey'` alongside `playbook | stateless | needs_info`. The plan is `{ journey_slug: <slug> }` / `{ playbook_slug: <slug> }`; the writer confirms the slug points at a live is_active row in this workspace BEFORE the Direction lands (`TicketDirectionPlanError` with codes `journey_slug_missing | journey_slug_unknown | journey_slug_not_string`). An unknown slug bails HERE, not at the executor — same "confirming predicate at the action point" pattern the existing playbook_slug guard uses.

- **Apply the matched mechanism (Phase 2) — [[../libraries/sol-direction-apply]] `applySolDirection`.** Positioned in `unified-ticket-handler.ts` between § 3.98's follow-up-turn playbook shortcircuit and § Step 2e's Sonnet orchestrator. When the live Direction resolves `chosen_path='journey'`, launches the journey via [[../libraries/journey-delivery]] `launchJourneyForTicket` with a message-aware `leadIn` (generated by `generateJourneyLeadIn`, mirrors the customer's incoming message per [[../customer-voice]]); when `chosen_path='playbook'` and `active_playbook_id IS NULL`, kicks off `startPlaybook` + one `executePlaybookStep` — never a freeform "click below" reply that describes the mechanism. Stamps `ticket_resolution_events.reasoning='sol:direction-apply:{path}:{slug}'` + CAS `shipped_at` so cost analytics can count Direction-applied turns.

- **Self-service backstop (Phase 2).** A [[../tables/sonnet_prompts]] rule that flags an intent as `self_service_only` (category match OR "never `<verb>` for the customer" phrasing that mentions the intent) OVERRIDES a `chosen_path='playbook'` Direction to the matching active journey — the deterministic version of "never cancel FOR the customer" so a direct-mutation playbook cannot run on the customer's behalf when a matching self-service journey exists. Stamped as `[System] Sol Direction override: self-service-only rule matched ...` for grade-visibility. If no matching journey exists, the playbook still runs — the rule is a preference, not a hard block.

- **CTA-reference send guard (Phase 3) — [[../libraries/sol-cta-reference-guard]] `assertCtaBackedByLaunch`.** Wired into `executeSonnetDecision`'s `ai_response` / `kb_response` case in [[../libraries/action-executor]] right after the [[../libraries/claim-guard]] `unbackedEffectClaim` block. An outbound reply that REFERENCES a CTA ("click the button below" / "use the link" / "click here" / "here is your link" / "tap the button" — 12 patterns total) is treated as an unbacked claim UNLESS a [[../tables/journey_sessions]] row was written for this ticket at-or-after the turn's `turnStartedAt`. On block: `sysNote` records the exact matched phrase, `escalateTicket(ctx, 'blocked_unbacked_claim:cta_tail')` routes to `needs_attention` through the existing [[../inngest/triage-escalations]] `blocked_unbacked_claim:*` selection rule, and the send is skipped. Fail-open on the DB probe error so a transient read failure cannot strand a legit reply. Operator remediation is either (a) launch a real journey via Phase 2's apply path, or (b) reword the reply so it stops referencing a CTA.

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

**Pre-`stampedSend` inflection gate — [[../libraries/inflection-detector]].** On every cheap-execution turn the drafted reply is checked BEFORE `stampedSend` fires. `detectInflection` runs a rule pass over the newest customer message + the recent `ticket_resolution_events.reasoning` history + the live [[../tables/ticket_directions]] intent, escalates ambiguous cases to a single Haiku call, and returns `'none' | 'drift' | 'frustration'`. On `'none'` the reply ships. On `'drift'` or `'frustration'` the reply is HELD and the re-session router supersedes the Direction + re-enqueues Sol's box session (see [[../specs/sol-drift-frustration-detector-and-re-session-router]] Phases 2–3). Frustration always wins over drift; drift is skipped mid-playbook, but frustration is not (a "refund now" mid-playbook still bounces).

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

### Sol close-on-resolution

Sol's first-touch box session (`runTicketHandleJob` in [[../../scripts/builder-worker]]) runs OUTSIDE the Phase-5 `postExecuteStatusAction` block above — it lands the Direction, sends the first_reply through [[../libraries/ticket-delivery]] `deliverTicketMessage`, and returns. Historically it never closed the ticket even when the reply was a resolving one, so the ticket stayed `open` and [[../libraries/ticket-analyzer]]'s closed-tickets-only sweep never enqueued Cora to grade it. Spec [[../specs/sol-closes-ticket-on-resolving-reply-so-cora-grades-it]] fixes this by mirroring Phase 5's `message_sent → close; next inbound reopens` taxonomy into the box lane — same rule, same effect, just applied at the box worker's send point instead of the Inngest handler's `case "message_sent"` block.

The decision is driven from a single shared predicate — [[../libraries/ticket-directions]] `classifySolBoxTurnAction({ chosen_path, send_ok })` — mirroring [[../inngest/unified-ticket-handler]]'s `PostExecuteAction` shape. Only `message_sent` closes; every other outcome leaves the ticket `open`:

| Sol outcome | Classifier verdict | Ticket state |
|---|---|---|
| `chosen_path='stateless'` + reply shipped | `message_sent` | **CLOSE** — `closeTicketOnResolvingReply` writes `status='closed' + closed_at=now()` (six-field update mirroring `setStatus`; clears the escalation triple) |
| `chosen_path='stateless'` + send failed | `keep_open` | stays open — a human retries via Improve; a customer never saw the reply |
| `chosen_path='needs_info'` | `keep_open` | stays open — a clarifying question; the customer's next inbound is the resolution signal |
| `chosen_path='playbook'` | `status_managed` | stays open — the playbook owns state; [[../inngest/unified-ticket-handler]]'s own paths close it when the mechanism resolves |
| `chosen_path='journey'` | `status_managed` | stays open — the journey owns state |
| Sol returns `needs_human` | `escalated` (branch-stamped) | stays open — the box worker flips to `needs_attention` and (for portal errors) enqueues a June triage escalate |
| unknown `chosen_path` | `keep_open` | stays open — **fail-safe**: unrecognized outcome NEVER authorizes a close |

### Cora grading eligibility — Sol responded · closed · ≥30 min · deterministic signal

[[../libraries/ticket-analyzer]] `enqueueTicketAnalyzeJob` is a closed-tickets-only sweep — the `ticket-analysis-cron` cron in [[../inngest/ticket-analysis-cron]] selects rows the founder's stated logic covers: **Sol responded · ticket closed · closed ≥30 min · not already graded this handling cycle · June has not already decided this cycle**. The exact predicate lives in the pure-function `passesCoraSelectionGate(ticket, now, latestJuneDecidedAt)` (pinned in `src/lib/inngest/ticket-analysis-cron.gate.test.ts`); the `find-tickets` step also mirrors it at the source: `status='closed' AND closed_at IS NOT NULL AND closed_at <= (now - 30 min) AND analyzer_locked = false AND tags @> {ai} AND sol_handled_at IS NOT NULL`.

**"Sol responded" is `tickets.sol_handled_at`, not a live [[../tables/ticket_directions]] row.** The worker (`runTicketHandleJob` in `scripts/builder-worker.ts`) stamps `sol_handled_at = now()` via `createAdminClient()` at the box session's terminal COMPLETED state — a deterministic, harness-controlled write, decoupled from Sol's in-session [[../libraries/ticket-directions]] `writeDirection` call. Under a DB outage the mid-session Direction insert could silently drop (observed on the first ~6-7 Sol-handled tickets), which hid "Sol responded" from the prior direction-existence gate and starved Cora of tickets to grade. `sol_handled_at` fixes that at its root — the signal survives an in-session insert failure. The `'ai'` tag stays as a coarse cheap pre-filter; `sol_handled_at` is the authoritative Sol-handled signal. Per-cycle dedup compares `last_analyzed_at` vs `sol_handled_at` (a stale `last_analyzed_at` from a prior Sol handling is fine — Cora re-grades the new cycle); the June-decided guard compares `director_activity.created_at` (max per ticket, `cs_director_call` action_kind) vs `sol_handled_at`. Sol re-handling a ticket advances `sol_handled_at` past every prior June decision timestamp and the ticket becomes re-eligible for the new cycle. See [[../specs/cora-grades-on-deterministic-sol-handled-signal-not-brittle-direction-existence]].

**Why close-on-resolution is what makes Cora fire.** Without the box-lane close, the row never meets the `status='closed'` predicate, and Cora silently never grades any Sol ticket. The 30-min `CORA_CLOSE_SETTLE_MS` settle lets the customer respond (`"thanks!"` / `"wait, one more thing"`) — a follow-up inbound reopens the ticket via the per-channel webhook reopen path (email `src/app/api/webhooks/email/route.ts`, SMS `src/app/api/webhooks/sms/route.ts`, widget `src/app/api/widget/[workspaceId]/messages/route.ts` — each recognizes `status === "closed"` and writes `status='open' + closed_at=null`).

**Cross-links:** [[../libraries/ticket-directions]] · [[../libraries/ticket-analyzer]] · [[../inngest/ticket-analysis-cron]] · [[../inngest/unified-ticket-handler]] · [[../tables/tickets]] (§ `sol_handled_at`) · [[../specs/sol-closes-ticket-on-resolving-reply-so-cora-grades-it]] · [[../specs/cora-grades-on-deterministic-sol-handled-signal-not-brittle-direction-existence]].

### Escalation lifecycle — set → visible → cleared

Escalation (`tickets.escalated_at` / `escalated_to` / `escalation_reason`) is an **open-state** concept with three moments:

- **Set.** The `escalate` action (Phase 2f) or the agent-involved no-action path (Phase 5 #5) flags the ticket. The default route is the **routine** (`escalated_to IS NULL`, `escalated_at` set) — see [[../specs/escalate-to-routine-by-default]] — which the box triage cron ([[../inngest/triage-escalations]] / [[../specs/box-escalation-triage]]) picks up.
- **Visible — "AI Investigation."** A routine-escalated ticket renders a **"🔍 Escalated → AI Investigation"** badge (amber) on the ticket header/list/[[../dashboard/tickets__escalated|Escalated view]], appending "· triage in progress" when a live `triage-escalations` job exists for the workspace (`GET /api/tickets/triage-status` + `useTriageInProgress()`). Triage leaves a paper trail of internal `[AI Investigation]` notes (start + outcome) so a human knows the AI is working it and can still step in — escalating to a person sets `escalated_to` and flips the badge off. Full detail in [[../dashboard/tickets]].
- **Cleared.** Resolving ends escalation: every terminal-status write path (`maybeAutoCloseGroup`/`executeTicketClose`, manual + bulk close, workflow/journey/portal closes, the unified handler's spam/fraud closes) sets all three flags to `null` in the same update, and the Escalated view additionally filters out `closed`/`resolved`/`archived`. So no terminal-status ticket ever carries escalation flags. **Reopening does NOT auto-re-escalate** — escalation is a fresh decision.
- **CS-Director loop closure.** When the [[../libraries/cs-director|cs-director-call]] box lane rules on an escalated ticket, the loop is closed per-verdict (spec [[../specs/cs-director-call-closes-the-ticket-loop-note-and-resolution-per-verdict]] — see [[../libraries/cs-director]] § "Loop closure — internal note + ticket state per verdict"). Every verdict writes an INTERNAL system note ([[../libraries/cs-director-verdict-note]]) naming June, the decision, the reasoning, and the concrete output. Then the ticket state moves to what the decision implies via [[../libraries/cs-director-ticket-transition]]: `author_spec` and `approve_remedy` (with a no-customer-reply signal) → close + de-escalate; `approve_remedy` default → de-escalate only (status stays `open` for the executor's next customer-reply turn); `escalate_founder` → escalation KEPT + `escalation_reason` stamped with `'CEO — awaits founder ruling: <why>'` + `escalated_to` stamped with the workspace-owner `user_id`. No ruled-on ticket is left in the `open+escalated+no-owner` limbo — every verdict either closes it, de-escalates it, or marks it CEO-owned.

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

### Guaranteed ticket handling (goal — SHIPPED · folded 2026-07-07)

The company goal *Ticket handling — guaranteed, observable, self-running* ([[../functions/cs]]-owned, [[../goals/guaranteed-ticket-handling]]) landed all five milestones atomically and folded into the permanent brain. The through-line: every customer-facing claim is now rendered from a VERIFIED action (never free-written), every resolution is a structured write-ahead record, control routes on typed state instead of tag strings, compiled trees own routine volume with real SDK actions, and an autonomous CS Director (💬 June) makes the hard calls and reports to the founder in storylines. The order was itself a guardrail — actions were guaranteed before anything cheaper or more autonomous was allowed to decide them.

- **M1 — Truthful actions.** `verifyActionInDB` coverage extended past its original seven types (returns, date/frequency, swap/remove/quantity, price), and the verify+escalate block now runs on the inline (journey/playbook-alongside) send path. Refund integrity closed the double-refund failure mode: verify-by-refund-id (never re-fire), the [[../tables/order_refunds]] mirror, and a T+3d settlement reconcile. → [[../libraries/action-executor]] · [[../tables/order_refunds]]
- **M2 — The resolution record (the spine).** [[../tables/ticket_resolution_events]] is the write-ahead action ledger (§ Phase 2f above); the `SonnetDecision` schema carries `problem`/`confidence`/`options`/`chosen`; confidence-gated problem lock-in fires a real clarification turn only on high-ambiguity × irreversible (~6% of tickets), never always-on. → [[../tables/ticket_resolution_events]] · [[../libraries/selective-clarify]] · [[../libraries/sonnet-orchestrator-v2]]
- **M3 — Right-cost routing.** model-picker routes on typed state, not tags (LTV alone stops buying Opus); no-handler action-type misses resolve through the [[../tables/action_handler_aliases]] catalog (with a [[../tables/proposed_action_aliases]] review queue for novel misses); `skip_next_order` (88% failure — dead Appstle endpoint) retired behind a shadow-measured alias to `change_next_date` / `bill_now`. → [[../libraries/model-picker]] · [[../tables/action_handler_aliases]]
- **M4 — Capability + compiler loop.** The missing commerce actions (`create_order`, `create_subscription`, `commerce/refund.ts`, $-bearing replacement) landed on the [[commerce-sdk]] SDK; the [[../inngest/playbook-compiler]] weekly loop mines the resolution ledger for recurring problem×resolution patterns → proposes playbooks via the existing [[../tables/sonnet_prompts]] approval queue, audits existing playbooks, and defers to the model on uncertainty (the matcher stays sovereign over seams, the stakes tail, and novelty). → [[../inngest/playbook-compiler]] · [[commerce-sdk]]
- **M5 — The autonomous CS Director.** The escalation ladder is now orchestrator → triage quorum (solver/skeptic) → CS Director (💬 June, hard calls) → founder (storylines only + true black-swan). June auto-approves within the CS leash, senses function health, and posts weekly [[../tables/cs_director_digests|storyline digests]] to the founder with bidirectional reply steering the leash + policy. Graded by the CEO on an anti-Goodhart rubric that NEVER rewards "fewest escalations to Dylan." → [[../libraries/cs-director]] · [[../inngest/cs-director-digest-composer]] · [[../dashboard/agents-cs-director-digests]]

### Message-is-last — no claim ships until executed and verified (spec — SHIPPED)

The spec *Eliminate false promises: no claim ships until executed and verified* ([[../specs/eliminate-false-promises-no-claim-ships-until-executed-and-verified]] — parent goal [[../goals/guaranteed-ticket-handling]], owner [[../functions/cs]]) closes the "message-is-last" invariant the Guaranteed Ticket Handling goal declared but did not enforce. Derived-from-ticket Judy 0a9e4d7f + the Catherine replacement: the reply promised bag+credit / replacement while neither action ran, because auto-close keyed off "reply sent" instead of "DB items done." The ordered pipeline that ships is `WHAT → HONOR → MESSAGE → GATE`:

1. **Phase 1 — Required-outcomes checklist ([[../tables/ticket_required_outcomes]] + [[../libraries/ticket-required-outcomes]]).** Sol distills the customer's asks into N STRUCTURED rows at Direction-authoring time, each with a stored `expected_db_state` predicate. Every downstream step reads THESE rows, not the reply prose.
2. **Phase 2 — Honor step ([[../libraries/honor-required-outcomes]]).** Before any customer-facing reply is composed, `honorRequiredOutcomes` walks each pending row, dispatches via `directActionHandlers`, verifies via `verifyActionInDB`, and CAS-marks each row `verified` / `failed`. Pure primitives `decideOutcome` + `replyGateBlocked` are test-driven so the ordering invariant ("actions run BEFORE the reply gate ever passes") is provably true without spinning up Supabase.
3. **Phase 3 — Send guard ([[../libraries/sol-outcome-claim-guard]]).** The terminal send checks the reply against every non-verified row: kind-specific claim regexes (past/future tense + third-person state) match phrases like "added a second bag", "applied a $15 credit", "here is your prepaid return label". A matched claim on an unverified row BLOCKS the send + stamps [[../tables/ticket_resolution_events]] `verified_outcome='unbacked'` via `stampUnbackedOnLedger` (retiring the "M1 inline-verify bounce — none yet" note). Wire-in landed at `scripts/builder-worker.ts` `runTicketHandleJob` right after [[../libraries/sol-policy-bait-guard]] passes; the Direction stays durable, the customer never sees the baited turn.
4. **Phase 4 — Completion gate ([[../libraries/outcome-completion-gate]]).** Auto-close is now gated on the completion invariant: `assessOutcomeCompletion` returns `ok=true` only when every row is `status='verified'`. On block, `escalateTicketOnIncompleteOutcomes` CAS-sets `tickets.status='open'` + `escalated_at` + `escalation_reason` naming every unfinished kind + description (500-char capped). Wire-in landed at [[../inngest/unified-ticket-handler]]'s sonnet-orchestrator `case "message_sent"`; on CAS-lost, falls through to the normal close (racing writer authoritative).

The single-line invariant every gate shares — `status === 'verified'` is the ONLY closed status — is what makes Judy's failure mode impossible to repeat: the send guard blocks the claim, the completion gate blocks the auto-close, the escalation names the specific unfinished items so an agent (or June's routine lane) picks them up instead of the ticket sitting silently closed on unfinished work.

### Sol — direction once, then cheap execution (goal — SHIPPED · folded 2026-07-08)

The company goal *Sol: set the ticket's direction once (box session), then run it cheap (API) — re-session on drift* ([[../functions/cs]]-owned, [[../goals/sol-ticket-direction-then-cheap-execution]]) landed all five milestones and folded into the permanent brain. The through-line **inverts the cost curve** that made Catherine's ticket $8.92: pay for full-context understanding ONCE at the moments that matter (first-touch + rare inflections), then execute the calm turns cheap against a durable Direction — replacing brittle trigger matching with a full-context session decision. Sol is the internal 🧭 Ticket Handler on June's team; customers still see the Suzie/Julie signatures. The whole flow lives in § Phase 2b (Sol first-touch dispatch + re-session bounce) and § Phase 2f (the pre-`stampedSend` inflection gate) above.

- **M1 — The Ticket Direction + first-touch session.** [[../tables/ticket_directions]] is the durable one-live-row artifact (partial UNIQUE `(ticket_id) WHERE superseded_at IS NULL`) carrying `intent` / `context_summary` / `chosen_path` ∈ {playbook | stateless | needs_info} / `plan` / `guardrails`. Sol's box session (`runTicketHandleJob`) authors it via the [[../libraries/ticket-directions]] SDK (`writeDirection` / `superseDirection` / `getLiveDirection`); the first-touch dispatch enqueues the `kind='ticket-handle'` job, gated on [[../tables/ai_channel_config]] `sol_first_touch_enabled` (default off, opt-in per workspace+channel). The holding-message ack is **chat-only** ([[../specs/sol-first-touch-ack-only-on-chat-not-async-channels]]) — chat customers get the ack right now (they're waiting live), async channels (email/sms/portal/meta_dm) skip both the ack send and its ledger row and see only Sol's substantive first reply. → [[../tables/ticket_directions]] · [[../libraries/ticket-directions]]
- **M2 — Cheap execution over the Direction.** Every subsequent turn reads the live Direction (`getLiveDirection`) and drives off `chosen_path` + `plan` + `guardrails` instead of re-running the full-context orchestrator — playbook path stays near-free, stateless/needs-info turns run Sonnet/Haiku over the tiny Direction context, not the full merged history. → [[../libraries/ticket-directions]]
- **M3 — Drift + frustration → re-session.** [[../libraries/inflection-detector]] `detectInflection` is the two-stage per-turn "does the Direction still fit?" gate (regex/counter rules → one Haiku call only on the ambiguous `'maybe'`) that runs BEFORE `stampedSend`. On `'drift'` / `'frustration'` the reply is HELD and `reSessionSol` supersedes the Direction + re-enqueues Sol; frustration always wins over drift and bounces even mid-playbook (an inline "we're looking into that" holding message fires first, gated by `sol_frustration_holding_message_enabled`). → [[../libraries/inflection-detector]] · [[../tables/ticket_resolution_events]]
- **M4 — Session-chosen playbook selection.** Which playbook to run moves INSIDE Sol's first-touch session: `writeDirection`'s `chosen_path='playbook'` plan validates `playbook_slug` against `public.playbooks` before the row lands, retiring the brittle signal-based matcher (the exact over-triggering worry from the assisted-purchase playbooks) for the Sol cohort. → [[../libraries/ticket-directions]] · [[../playbooks]]
- **M5 — Cost + quality measurement + the guardrails.** [[../dashboard/tickets__analytics]] § Sol economics splits per-ticket AI cost (median + p95) + CSAT + a re-session histogram by pre-Sol vs Sol cohort against the Catherine $8.92 baseline. The anti-runaway rail: [[../tables/ai_channel_config]] `sol_max_resessions` caps re-sessions per ticket (cap-hit → escalate to the routine lane, `reasoning='sol:cap-hit'`), and [[../libraries/cs-director-digest]] raises a systemic `early_warning` storyline when cap-hits in the window exceed `sol_cap_hit_alarm`. → [[../dashboard/tickets__analytics]] · [[../libraries/cs-director-digest]]

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

**Resolution ledger (M2 — shipped, folded with the goal above):** Ticket resolution write-ahead ledger + SonnetDecision schema extension (spec [[../specs/ticket-resolution-events-writeahead-ledger-and-decision-schema-extension]] — parent goal [[../goals/guaranteed-ticket-handling]] § M2 "The resolution record (the spine)"). Phase 1 landed [[../tables/ticket_resolution_events]] + wired the write-ahead insert + shipped/verified stamps into [[../libraries/action-executor]] `executeSonnetDecision` (§ Phase 2f above). Phase 2 has landed the `SonnetDecision` schema extension: [[../libraries/sonnet-orchestrator-v2]] now carries `problem` / `confidence` / `options` / `chosen` on the interface; `buildSystemPrompt` asks the model for them; `parseSonnetDecision` warns + increments the `[resolution-schema-adoption]` counter (in `resolutionSchemaAdoption`) whenever a real (non-fallback) decision omits any of the four; `stageResolutionEvent` in [[../libraries/action-executor]] range-guards the values (confidence ∈ [0,1], options must be an array) and lands them on [[../tables/ticket_resolution_events]] per turn — the substrate the shipped inline-verify send guard ([[../libraries/sol-outcome-claim-guard]]) reads against, M2's confidence-gated clarify keys off, and M4's compiler loop mines.

**Recent activity:**
- `a6844aaa` CSAT: resolution-gate survey + cron-driven send + dashboard
- `096c8b3b` Orchestrator: escalate when no-action path lands on an agent-involved ticket
- `af32d630` Delete stale CSAT [id] routes — superseded by [ticketId]

### Crisis-swap rejected — full refund + founder cancel-SMS (spec — SHIPPED per phase)

Sibling to the Tier-1/2/3 crisis journeys ([[../libraries/crisis-journey-builder]]) for the case a Tier-1 flavor swap has ALREADY CHARGED — the customer's renewal ran, the order that will ship carries the `default_swap` variant because the ordered flavor is OOS, and the customer signals they reject the substitute (berry-only / "no substitutions" / "I'll wait"). No journey to run — the money already moved; Sol runs a supervised remedy sequence instead. Spec [[../specs/sol-crisis-swap-rejected-full-refund-and-sms-founder-to-cancel-amplifier-order]] (owner [[../functions/cs]], parent mandate "Fix weird tickets fast, calibrate so they don't recur").

The four-phase build ships as three composable library files + a brain-page fold, wired into Sol's first-touch remedy path:

- **Phase 1 — classifier ([[../libraries/crisis-journey-builder#crisis-swap-rejected--full-refund--founder-cancel-sms]] `src/lib/commerce/crisis-swap-rejected.ts`).** `classifyCrisisSwap` distinguishes `crisis_swap_rejected` (active crisis + order carries the swap variant + rejection signal — full remaining-balance refund) from `swap_accepted` / `overcharge_only` (defer to the sibling price-correction partial at [[../libraries/subscription-overcharge]]) / `no_match`. NEVER emits a full refund for an accepted swap.
- **Phase 2 — founder Amplifier-cancel SMS (`src/lib/commerce/founder-cancel-sms.ts`).** Best-effort, idempotent, never-throws founder alert. Amplifier exposes no cancel API — the founder must log in and cancel manually. Shipped-guarded (`amplifier_status === 'Shipped'` → return path, not founder cancel), idempotent via `customer_events` `event_type='order.founder_cancel_amplifier_sms_sent'` scoped by `(workspace_id, properties.order_id)` (durable ledger, same order never gets two cancel texts). Reuses [[../libraries/god-mode]] `resolveFounderPhone` + [[../integrations/twilio]] `sendSMS`.
- **Phase 3 — sequencer (`src/lib/commerce/crisis-swap-rejected-sequencer.ts`).** `executeCrisisSwapRejectedRemedy` composes the two: (1) sum `order_refunds` prior refunds (workspace-scoped, status ∈ succeeded/settled), (2) classify, (3) fire founder cancel-SMS FIRST (spec sequence — a Shipped order lands SMS `sent:false / reason:'…Shipped…'` and the refund STILL proceeds; return-on-receipt runs in parallel), (4) issue the full refund via [[../libraries/commerce__refund]] `issueRefund` threading a stable action-scoped `requestKey` so a same-shape retry short-circuits inside `refundOrder`'s pre-dispatch `order_refunds` guard (no double refund), (5) emit `buildInternalNote` capturing BOTH the refund amount AND the SMS disposition (`crisis-swap-rejected: full refund $X + founder texted to cancel {order_number}`, with honest variants for already-Shipped / already-texted / no-phone / failed), (6) emit `buildCustomerReplyDraft` per [[../customer-voice]] — acknowledges OOS + refund + paused-until-restock, NO over-apologizing (crisis swaps are normal process we communicated up front), NO order numbers in customer-visible text, DIFFERENT copy on a failed refund ("getting the refund set up now" — never claims an action the system didn't perform).
- **Phase 4 — brain + end-to-end verification.** Brain pages ([[../libraries/crisis-journey-builder]], [[../libraries/god-mode]], [[../integrations/twilio]], and THIS lifecycle section) describe the recognition → full-refund + founder-cancel-SMS flow and cite the spec. The four end-to-end tests live in `src/lib/commerce/crisis-swap-rejected.e2e.test.ts`: (1) crisis-swap-rejected + not shipped → full remaining-balance refund + one founder SMS; (2) already Shipped → no cancel SMS, refund still proceeds (return path); (3) swap accepted → no full refund, no SMS; (4) prior partial (the Cheri case: $116.41 total, $26.89 already refunded → $89.52 remainder, NOT the full $116.41).

**The Cheri canary:** the sequencer computes the remainder BEFORE the vendor call, and the classifier clamps to zero when prior refunds ≥ order_total, so the full-refund path can NEVER over-refund an order. `issueRefund`'s double-refund guard is a second layer (idempotent on stable `requestKey`), and the `order_refunds` UNIQUE index on `(order_id, request_key)` is the third.

**Open questions:** None.

### Moved-customer save — address update + optional $0 replacement, never a cancel dead-end (spec — SHIPPED per phase)

Spec [[../specs/sol-reads-moved-as-address-update-and-replacement-offer-not-cancel-deadend]] (owner [[../functions/cs]], parent mandate "Fix weird tickets fast, calibrate so they don't recur"). Sol used to translate a **moved customer** signal ("I moved", "new address", "changed address", "cancel, I moved") into a cancel — dead-ending an interaction that should have been a save. The flow that ships is `RECOGNIZE MOVE → STANDALONE ADDRESS JOURNEY → (eligible) $0 REPLACEMENT OFFER → HONEST CANCEL ONLY AFTER OFFER` — every step guarded so no dead-end reply, no re-asking a validated address, no auto-cancelling for the customer.

- **Phase 1 — recognize move + dispatch the standalone address-update journey ([[../libraries/ticket-directions]]).** [[../libraries/ticket-directions]] `TicketDirectionPlan` gains an optional `launch_journey_slug`; Sol authors `chosen_path='stateless'` + `plan.launch_journey_slug='shipping-address'` on the wedge. The writer's `validateLaunchJourneySlug` gate re-asserts the slug resolves to an active `journey_definitions` row for this workspace BEFORE the Direction lands (throws `journey_slug_not_string | journey_slug_unknown` with the slug echoed). The worker's `runTicketHandleJob` then calls `resolveSolChosenJourney` after `writeDirection` and — when it returns non-null — launches the STANDALONE Confirm Shipping Address journey via [[../libraries/journey-delivery]] `launchJourneyForTicket` (no active playbook), with Sol's `first_reply` as the CTA lead-in. On journey completion the internal-aware `update_shipping_address` handler ([[../libraries/action-executor]] → [[../libraries/commerce-subscription]] `subscriptionUpdateShippingAddress`) branches internal vs Appstle and actually persists the EasyPost-validated address to the active subscription (internal → local jsonb; Appstle → Appstle push). Launching the journey as a **playbook step** is explicitly rejected — there the address only routes a replacement, it does not persist to the subscription.
- **Phase 2 — $0 replacement offer to the newly-validated address ([[../libraries/move-replacement-offer]]).** The journey's completion route (`src/app/api/journey/[token]/complete/route.ts`) — right after the address update lands — reads the live Direction, confirms `plan.launch_journey_slug === 'shipping-address'` (guards against non-move address changes), then calls `offerMoveReplacementIfEligible`. Eligibility mirrors the [[../playbooks/refund]] Tier-1 bar (LTV ≥ $100 OR `total_orders ≥ 3`); recent-order gate = created ≤ 21 days ago with a `shopify_order_id` (has been through fulfillment). Eligible + recent-order customer gets an EXPLICIT outbound offer message; the pending state stashes on `tickets.playbook_context.pending_move_replacement_offer` — `acceptMoveReplacementOffer` re-asserts the pending state (learning #6 confirming-predicate pattern) and dispatches through the shared `commerce/replacement.issueReplacement` path against the validated new address (never re-asked). A non-eligible customer / no-recent-order case is a silent skip — the address update lands, the offer does not, no unbacked promise. Route failure is best-effort logged and does NOT roll back the address update.
- **Phase 3 — never dead-end a move as cancel; honor explicit cancel after offer ([[../libraries/sol-move-dead-end-guard]]).** `assessSolMoveDeadEndRisk` is the pure machine gate the worker runs on Sol's DRAFT `first_reply` right after [[../libraries/sol-policy-bait-guard]] passes and BEFORE the customer-facing send fires (same shape as the bait guard — pure, no I/O; the tests seed inputs directly). Three signals BLOCK the send: `move_dead_ended_as_cancel` (move + active sub, reply terminates as cancel-only), `move_terminal_no_redirect_without_alternative` (reply acknowledges "already shipped, can't redirect" with no alternative — address update on future shipments / $0 replacement / self-service cancel handoff), `cancel_after_offer_without_self_service_handoff` (customer insisted on cancel AFTER the offer, but the reply does not hand the self-service `cancel-subscription` journey via `plan.launch_journey_slug`). On block the Direction stays durable, the customer never sees the baited turn, the ticket routes to needs_human via the Improve tab. Sol NEVER cancels for the customer — an explicit-cancel path is `plan.launch_journey_slug='cancel-subscription'` + a reply that hands the link. An already-shipped in-flight order is acknowledged truthfully (that specific shipment cannot be redirected) but must pair with a forward alternative.
- **Phase 4 — brain fold + end-to-end verification.** THIS lifecycle subsection + [[../libraries/ticket-directions]] § "Sol move-signal recognition" cite the spec and describe the moved-customer save. End-to-end tests live in `src/lib/ticket-directions.test.ts` (Phase 1 wedge + writer's `launch_journey_slug` validator), `src/lib/move-replacement-offer.test.ts` (Phase 2 eligibility + accept path + confirming predicate), and `src/lib/sol-move-dead-end-guard.test.ts` (Phase 3 dead-end / no-redirect / cancel-after-offer bans + the self-service handoff green path). Gate: `npx tsc --noEmit`.

**Recurrence guard:** the [[../libraries/sol-move-dead-end-guard]] regexes cover the exact dead-end phrasings ("we've cancelled your subscription", "already shipped, we can't redirect", "the only option is to cancel") that turned a moved customer into a churn; a Sol reply that trips any of them cannot ship. The recognition side (move signals in Sol's `intent` / `context_summary`) is deliberately broad — a false negative just means the guard doesn't fire (behavior falls back to the pre-Phase-3 send path), so the bar for arming the check is intentionally low.

## Related

[[ai-multi-turn]] · [[fraud-detection]] · [[customer-link-confirmation]] · [[social-comment-moderation]] · [[../inngest/unified-ticket-handler]] · [[../inngest/deliver-pending-send]] · [[../inngest/triage-escalations]] · [[../dashboard/tickets__escalated]] · [[../tables/tickets]] · [[../tables/ticket_messages]]
