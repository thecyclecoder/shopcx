# AI multi-turn

The route → assemble context → generate → confidence-gate → send → auto-resolve loop. Sits inside [[ticket-lifecycle]] at the orchestrator step, but deserves its own page because the multi-turn behavior + cost / quality knobs all live here.

## Cast

- Pipeline: [[../inngest/unified-ticket-handler]] (entry) + `src/lib/sonnet-orchestrator-v2.ts` (brain) + `src/lib/action-executor.ts` (limbs).
- Models: [[../integrations/anthropic]] (Haiku + Sonnet + Opus per `src/lib/model-picker.ts`).
- Embeddings: [[../integrations/openai]] (RAG retrieval over [[../tables/kb_chunks]] + [[../tables/macros]]).
- Config: [[../tables/ai_channel_config]], [[../tables/ai_personalities]], [[../tables/sonnet_prompts]], [[../tables/policies]], [[../tables/ai_workflows]].
- Tracking: [[../tables/ai_token_usage]], [[../tables/escalation_gaps]], [[../tables/knowledge_gaps]].

## Tool-use architecture (v2)

The orchestrator gets minimal pre-loaded context — customer name, email, ticket tags, conversation history (last 8 messages + action-completion notes), available handler names (journeys, playbooks, workflows by name + trigger_intent), and the personality config. About 300 tokens.

The rest of the context Sonnet fetches on demand via tool calls:

| Tool | When Sonnet calls it | Source tables |
|---|---|---|
| `get_customer_account` | Account questions (subs, orders, billing, loyalty) | [[../tables/subscriptions]], [[../tables/orders]], [[../tables/loyalty_members]], [[../tables/customer_links]] |
| `get_product_knowledge` | Product / policy questions | [[../tables/products]], [[../tables/macros]], [[../tables/kb_chunks]] (via RAG) |
| `get_returns` | Return / exchange / refund status | [[../tables/returns]] |
| `get_crisis_status` | Crisis tags on ticket or OOS mentions | [[../tables/crisis_customer_actions]], [[../tables/crisis_events]] |
| `get_chargebacks` | Disputes, unauthorized charges | [[../tables/chargeback_events]] |
| `get_email_history` | "Didn't receive email" questions | [[../tables/email_events]] |
| `get_dunning_status` | Payment failures, billing issues | [[../tables/dunning_cycles]], [[../tables/payment_failures]] |

Two-bucket reasoning:

1. Account question → call `get_customer_account` first.
2. Product/policy question → call `get_product_knowledge` first.
3. If first bucket doesn't have the answer → try the other.
4. If neither → genuine knowledge gap → escalate to human, log to [[../tables/knowledge_gaps]].

Tool definitions: `buildToolDefinitions()` in `src/lib/sonnet-orchestrator-v2.ts`. Adding a new customer_id table → add a tool here per the [[../lifecycles/ai-multi-turn]] convention.

## Phase 1 — route (turn 0)

Before Sonnet sees the message, the unified handler applies route checks:

1. **Auto-escalation keywords** — cancellation_intent, billing_dispute, human_requested. Some get pre-emptively routed (cancel intent → cancel journey even before Sonnet decides).
2. **Sentiment** — extreme negativity drops the AI behind a human gate.
3. **Positive closure** — "thanks!" / "got it" closes the ticket without an AI turn.
4. **Turn limit** — `tickets.ai_turn_count >= ai_turn_limit` (default 6) → escalate. Prevents runaway loops on hard cases.

If any of these fire, Sonnet doesn't run. Otherwise the orchestrator gets the message.

## Phase 2 — assemble pre-context

`src/lib/ai-context.ts` builds the lean pre-loaded packet:

- Customer name + email.
- Workspace + channel personality (`src/lib/ai-personalities.ts`).
- Ticket tags (includes crisis tags, journey markers, fraud flags).
- Conversation history (last 8 messages from [[../tables/ticket_messages]], using `body_clean`).
- Active playbook / journey state (if any).
- Available handler catalog: every [[../tables/journey_definitions]] / [[../tables/playbooks]] / [[../tables/workflows]] / [[../tables/ai_workflows]] by name + trigger_intent.
- Rule pack from [[../tables/sonnet_prompts]] + [[../tables/policies]].

This packet gets prompt-cached at the boundary so multi-turn conversations reuse the same prefix.

### Confidence-gated problem lock-in

At the top of `assembleTicketContext` (`src/lib/ai-context.ts`), after the channel config loads, we query the latest [[../tables/ticket_resolution_events]] row for this ticket whose `confidence` is `>=` the channel's `problem_lockin_threshold` (default `0.7` on [[../tables/ai_channel_config]]; DB-driven per channel). When a locked-in row is present, we inject one line into the Sonnet system prompt BEFORE `CUSTOMER CONTEXT`:

```
ESTABLISHED PROBLEM (locked in at T{turn}): {problem}. Any pivot MUST be justified explicitly in reasoning.
```

Rationale — an early, high-confidence diagnosis (e.g. `refund_request` at T1 with `confidence=0.85`) is the ticket's real state. On T2+ Sonnet was silently pivoting off it whenever a later customer message added noise; the lock-in makes that pivot loud (it has to explain itself in `reasoning`) instead of silent. The line is prompt-cached along with the rest of the prefix because the row it reads from is only refreshed once per turn on insert.

Below the threshold → no line is injected and Sonnet stays free to redirect the ticket. Empty/absent `problem` → no line. Only the LATEST above-threshold row wins, so a sequence of confirmed turns keeps the lock-in anchored to the most recent diagnosis (which the orchestrator's own reasoning would have refined).

The pre-loaded packet also carries `establishedProblem` on `AssembledContext` so downstream callers (`unified-ticket-handler.ts` + the Improve tab's `/api/tickets/[id]/resolution-context` route) can render the same lock-in state a human sees on `/dashboard/tickets/[id]` → Improve tab, alongside the current turn's `reasoning`.

Threshold tuning lives in Settings → AI → Channels (per-channel row on [[../tables/ai_channel_config]]).

Related: [[../tables/ticket_resolution_events]] (the source ledger) · [[../specs/confidence-gated-problem-lockin-and-selective-clarify]] (Phase 1 spec).

## Phase 3 — generate

`src/lib/model-picker.ts` decides the model:

- Turn 1-2 → Haiku (fast, cheap).
- Turn 3+ → Sonnet (smarter).
- Crisis / playbook step decisions → Sonnet.
- Open-ended cancel chat → Sonnet (max 3 turns).
- Remedy selection → Haiku.

The call goes through `src/lib/ai-models.ts` + `src/lib/ai-usage.ts` so token cost lands in [[../tables/ai_token_usage]] with `workspace_id` + `ticket_id` attribution.

Sonnet may iterate: tool call → result → next tool call → ... → final decision. Each round-trip is its own API call but the cache stays warm.

Output is a `SonnetDecision` JSON:

```json
{
  "reasoning": "brief explanation",
  "action_type": "direct_action | journey | playbook | workflow | macro | kb_response | ai_response | escalate",
  "actions": [{ "type": "...", ... }],
  "handler_name": "name of journey/playbook/workflow",
  "response_message": "message to send customer",
  "needs_clarification": false,
  "clarification_question": null
}
```

Validation: `safeJSONParse()` parses + schema-checks. Bad JSON → fall back to escalate.

## Phase 4 — confidence gate

`SonnetDecision.action_type === 'escalate'` (Sonnet self-escalating) and channel-level confidence threshold (from [[../tables/ai_channel_config]]) both kill the AI path. If either fires:

- Assign round-robin via `src/lib/escalation.ts`.
- Send the holding message (`workspaces.auto_close_reply` template or channel-specific).
- Set `tickets.escalated_to`, `escalation_reason`, `escalated_at`.
- Log to [[../tables/escalation_gaps]] if the escalation looks suspect (e.g. low-information message that Sonnet probably could have handled).

Above the confidence gate sits the CS Director hard-call lane ([[../libraries/cs-director]] § Phase-2 executor). An escalated ticket reaches June via the `cs-director-call` box lane; her verdict flows through `applyBoxCsDirectorCall` (in `src/lib/cs-director.ts`) — `approve_remedy` fires the real commerce action via `executeSonnetDecision` and only THEN delivers the customer message via `deliverTicketMessage` (execute-then-message rule from the derived-from ticket `115350d5`), `author_spec` writes through the specs SDK chokepoint, and `escalate_founder` returns the linkage-back payload for the runner-minted CEO card (single-writer principle).

## Phase 5 — execute

`src/lib/action-executor.ts` dispatches on `action_type`:

- `direct_action` — the selective-clarify gate ([[../libraries/selective-clarify]] — Phase 2 of [[../specs/confidence-gated-problem-lockin-and-selective-clarify]]) fires FIRST: on a low-confidence × irreversible plan (`partial_refund` / `cancel` / `bill_now` / `subscriptionOrderNow`, DB-configurable via a `slug='irreversible_actions'` [[../tables/policies]] row) it sends a scoped confirmation-turn instead of running any action and stamps [[../tables/ticket_resolution_events]] `verified_outcome='clarified'`. Otherwise: execute the action(s):
  - Subscription mutations via [[../integrations/appstle]] (`appstleSubscriptionAction`, `appstleSkipNextOrder`, etc.).
  - Order refunds via [[../integrations/shopify]] `refundCreate` + [[../integrations/braintree]] `transaction.refund` when applicable.
  - Loyalty redemptions via `src/lib/loyalty.ts`.
  - Coupon application via `src/lib/marketing-coupons.ts`.
  Every action writes a `customer_events` row + an internal note on the ticket. After all actions succeed, the response message goes out as customer-visible.
- `journey` — `launchJourneyForTicket()`. See [[cancel-flow]] for a full example.
- `playbook` — `startPlaybook()`. The unified handler will route subsequent messages through the playbook step engine until terminal.
- `workflow` — `executeWorkflow()`. Template-based, deterministic. Used for order_tracking, account_login, end_chat.
- `macro` / `kb_response` / `ai_response` — send the response as-is.

## Phase 6 — send

The outbound message is inserted into [[../tables/ticket_messages]] with `pending_send_at`. [[../inngest/deliver-pending-send]] does the actual transport call. See [[ticket-lifecycle]] Phase 3.

## Phase 7 — auto-resolve

If the message was a complete response (not a clarification question), the orchestrator auto-closes:

- `tickets.status = 'closed'`, `closed_at = now()`.
- The customer's next reply reopens via the inbound handler.

If the action failed silently — for example, Appstle returned `{ success: false }` and Sonnet still drafted a "got it, you're paused" reply — the executor catches the mismatch and:

- Does NOT send the message.
- Inserts an internal note explaining the failure.
- Escalates to human.

This is the rule "Never tell a customer an action was done unless [[../tables/customer_events]] confirms it" — see feedback-driven design in [[../lifecycles/ai-multi-turn]].

## Cost model

Prompt caching is the lever. A multi-turn conversation reuses the same system prompt + personality + tool definitions + rule pack across turns. Cache TTL is 5 min — within a hot conversation, every turn after the first is cached at 90% off.

In steady state, `cache_read_input_tokens / input_tokens` should be > 0.5 on [[../tables/ai_token_usage]] queries. If it drops, the cache is being broken — usually by inserting per-turn dynamic content into the cacheable prefix. Audit the prompt assembly.

## Quality controls

- **Macro suggestion loop**: Sonnet's choice of macro is logged to [[../tables/macro_usage_log]] with `source='ai'`. Agent's accept/reject/edit on a Sonnet-suggested macro updates the acceptance counters on [[../tables/macros]], driving the green/amber/red badges in Settings.
- **Pattern feedback**: when an agent removes an auto-applied `smart:` tag, the [[../tables/pattern_feedback]] queue captures it for admin review.
- **Knowledge gaps**: when Sonnet escalates with `reasoning` matching "no matching content", a [[../tables/knowledge_gaps]] row is inserted. Surfaced for admin to write a macro / KB article.
- **Daily analysis** ([[../inngest/ai-nightly-analysis]]) reviews recent AI-handled tickets and writes [[../tables/daily_analysis_reports]]. Paused 2026-04-28 — see project_ai_analysis_apr28.

## DB-driven prompt rules

The orchestrator's behavior is *not* hardcoded. [[../tables/sonnet_prompts]] holds rule/approach/knowledge/tool_hint rows that get loaded at orchestrator init. Editable at Settings → AI → Prompts. Examples:

- "Cancel requests → always route to cancel journey (never cancel directly)."
- "Loyalty: check unused coupons first → redeem if needed → give code."
- "Crisis: auto-fetch crisis status, berry_only → pause, berry_plus → remove OOS item."
- "Phone support: redirect ('not available, but I can help right here')."

[[../tables/policies]] holds the 5 canonical published policies — refund window, restocking, exchange rules, etc. Replaces ~60 scattered prompts that used to encode policy.

## Files touched

| File | Purpose |
|---|---|
| `src/lib/inngest/unified-ticket-handler.ts` | Entry pipeline |
| `src/lib/sonnet-orchestrator-v2.ts` | The brain — tool use + decision JSON |
| `src/lib/action-executor.ts` | Dispatches decisions |
| `src/lib/ai-models.ts` | Model id constants + SDK client |
| `src/lib/ai-usage.ts` | Token accounting writes |
| `src/lib/model-picker.ts` | Per-call model selection |
| `src/lib/ai-context.ts` | Pre-loaded context builder |
| `src/lib/ai-date-context.ts` | Date / relative-time helpers |
| `src/lib/rag.ts` | RAG retrieval (KB + macros via pgvector) |
| `src/lib/embeddings.ts` | OpenAI embedding wrapper |
| `src/lib/pattern-matcher.ts` | 3-layer pattern classifier |
| `src/lib/escalation.ts` | Round-robin escalation |
| `src/lib/customer-fraud-status.ts` | Confirmed-fraud short-circuit |
| `src/lib/ticket-tags.ts` | Idempotent tag helper |
| `src/lib/ticket-analyzer.ts` | Per-ticket analysis runs |
| `src/lib/inngest/deliver-pending-send.ts` | Outbound delivery |
| `src/lib/inngest/ticket-analysis-cron.ts` | Nightly analysis cron |
| `src/lib/inngest/ai-nightly-analysis.ts` | Daily AI quality review |
| `src/lib/selective-clarify.ts` | Phase-2 low-confidence × irreversible gate for `direct_action` |

## Status / open work

**Shipped:** Sonnet orchestrator with tool-use, multi-turn handling, prompt caching, confidence-gated escalation, Haiku/Sonnet model selection, action execution — fully wired.

**Known gaps / not yet shipped:**
- AI nightly analysis (`daily_analysis_reports`) was paused 2026-04-28 — see memory `project_ai_analysis_apr28` for what's left.

**Recent activity:**
- `096c8b3b` Orchestrator: escalate when no-action path lands on an agent-involved ticket
- `49cfd939` Orchestrator: add bill_now action + auto-fallback in change_next_date

**Open questions:** None.

## Related

[[ticket-lifecycle]] · [[../integrations/anthropic]] · [[../integrations/openai]] · [[../tables/sonnet_prompts]] · [[../tables/policies]] · [[../tables/ai_token_usage]] · [[../inngest/unified-ticket-handler]]
