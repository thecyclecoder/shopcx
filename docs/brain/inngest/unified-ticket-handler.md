# inngest/unified-ticket-handler

**THE main pipeline.** Every inbound message: resolve → playbook check → Sonnet orchestrator → execute decision. Touches almost every table. See [[../lifecycles/ticket-lifecycle]].

**File:** `src/lib/inngest/unified-ticket-handler.ts`

## Functions

### `unified-ticket-handler`
- **Trigger:** event `ticket/inbound-message`
- **Retries:** `OUTAGE_SPANNING_RETRIES` (20) — outage-spanning. A Claude/dependency failure throws (see below), so the run retries with exponential backoff out to hours; a 1-hour Anthropic outage parks here and completes on recovery instead of failing-and-dropping. Terminal logic errors throw `NonRetriableError` → still fail fast. ([[../specs/agent-outage-resilience]] Phase 1.)
- **Concurrency:** `concurrency: [{ limit: 1, key: "event.data.ticket_id" }]`

## Hard gates before the orchestrator

Inside the `resolve` step (right after the ticket row load) the handler short-circuits on two per-ticket flags — both bail before language detection / classification / Sonnet:

- **`ai_disabled`** — an explicit **human directive** ("Turn off AI on this ticket" button on the ticket detail view). Logs `[System] Skipped — AI is disabled on this ticket by human directive`, returns the `_aiDisabled` sentinel, and the outer function returns `{ skipped: "ai_disabled" }`. Non-propagating on merge — see [[../libraries/ticket-merge]]. Phase 1 of `docs/brain/specs/human-directives-hard-gates-over-ticket-ai.md`.
- **`do_not_reply`** — filter-set (mailer-daemon, wrong company, spam). Logs the do-not-reply skip note and returns `{ skipped: "do_not_reply" }`.

The two gates are shape-identical (same sentinel-on-resolve → hard-exit-below pattern) but they mean different things: `ai_disabled` is a person's explicit call, `do_not_reply` is an automated filter.

## Step 2e — Sonnet orchestrator (Direction-scoped user block)

The `sonnet-orchestrate` step (Step 2e in the pipeline) loads the live [[../tables/ticket_directions]] row for the ticket via [[../libraries/ticket-directions]] `loadLiveDirection` BEFORE the picker + orchestrator call — Phases 2/3/5-Fix-1 of [[../specs/sol-cheap-execution-over-ticket-direction]]. Two things branch off it:

- **Direction present + non-superseded (Direction-scoped path).** The Direction is passed to [[../libraries/sonnet-orchestrator-v2]] `callSonnetOrchestratorV2` as `directionOverride`. `buildPreContext` swaps the `CUSTOMER: name (email)` + `RECENT ORDERS` + full-history user block for the Direction's rendered suffix (intent + context_summary + JSON-stringified guardrails + chosen_path) — see [[../libraries/ai-context]] `assembleDirectionContext` + `renderDirectionSystemPrompt`. Sol has already summarized customer + orders + prior history into `context_summary` at first-touch, so re-fetching wastes tokens on data the model would re-summarize identically. The shared system prefix stays byte-identical (cache-friendly); only the volatile user block changes. `callSonnetOrchestratorV2` prefixes the returned decision's `reasoning` with `sol:direction-context ` so [[../libraries/action-executor]] `stageResolutionEvent` stamps [[../tables/ticket_resolution_events]] `.reasoning` with the tag — cost analytics can split cost-per-turn by path without a heuristic classifier.
- **No live Direction (legacy tickets / workspaces without `sol_first_touch_enabled`).** `directionOverride` is null; the full-context `buildPreContext` path runs exactly as before, and the ledger `reasoning` does NOT carry the `sol:direction-context` prefix.

Also feeds [[../libraries/model-picker]] `pickOrchestratorModel` — a fresh + high-confidence + stateless Direction relaxes the picker toward Haiku (see [[../libraries/model-picker]] § Direction-driven Haiku route). The `active_playbook_id` case is short-circuited earlier at Step 3.98 (§ [[../specs/sol-cheap-execution-over-ticket-direction]] Phase 4) so this Step 2e branch only sees stateless / needs_info / playbook-with-no-active-id Directions.

## Outage resilience — no silent Claude swallows

The local `claude()` helper (Haiku/Sonnet quick turns) **throws** on a failed call instead of the old `if (!r.ok) return ""` (which let callers proceed on empty data): retryable status / network → `AnthropicDependencyError` (run retries), terminal status / missing key → `NonRetriableError` (fail fast). See [[../libraries/anthropic-retry]]. The main Sonnet decision ([[../libraries/sonnet-orchestrator-v2]]) likewise throws on a retryable failure rather than degrading every ticket to "escalate". The one explicit exception is `personalizeMacroText` (`{ optional: true }`) — the macro body is already a valid reply, so it degrades gracefully.

## Sentinel messages (`message_body`)

Some `ticket/inbound-message` events carry a synthetic `message_body` instead of real customer text. These are internal wake-ups for an **active playbook**, not customer messages:

| Sentinel | Fired by | Purpose |
|---|---|---|
| `playbook-apply` | `app/api/tickets/[id]/apply-playbook/route.ts` | An agent applied a playbook from the dashboard — run it now |
| `items_selected` | journey completion (item picker) | Resume the playbook waiting on the journey output |
| `address_confirmed` | journey completion (address form) | Same, for the shipping-address journey |

Two guards govern them:
- **§0a short-circuit:** if a sentinel arrives and there's **no** `active_playbook_id`, skip the orchestrator entirely (running Sonnet on the literal sentinel string just re-routes to the same journey — Lee Summers double-send bug).
- **Active-playbook block:** when a playbook IS active, the handler normally asks Haiku "is this message about the playbook or a new topic?". **Sentinels bypass that classifier and execute the playbook directly** — Haiku would see the literal string `"playbook-apply"`, call it NEW_TOPIC, and bounce to the orchestrator, so a freshly-applied playbook would never run (Ida McDonald 2026-06-10). See `isSentinel` at the `classify-playbook-msg` step.

Applying a playbook sets `active_playbook_id`, `playbook_step:0`, `status:closed`, inserts the agent-context as an internal message, then fires `playbook-apply`. The playbook then auto-identifies the order/subscription and runs through its steps (e.g. Refund → apply_policy → reply explaining ineligibility).


## Downstream events sent

_None._

## Tables written

- [[../tables/customer_links]]
- [[../tables/customers]]
- [[../tables/dashboard_notifications]]
- [[../tables/escalation_gaps]]
- [[../tables/ticket_messages]]
- [[../tables/tickets]]

## Channel behavior

Per-channel settings come from [[../tables/ai_channel_config]] (`channelCfg`) and `workspaces.response_delays` (`responseDelay`), both keyed by the ticket's `channel`.

- **`portal`** (customer-portal "Support" sidebar, [[../libraries/portal__handlers__support]]) is treated **exactly like `chat`** for AI: it's in every `short` message array (clarify / macro / KB / journey lead-in / positive close → terse replies), gets HTML formatting in [[../libraries/playbook-executor]] / [[../libraries/workflow-executor]] (`useHtml`), and runs journeys/playbooks (it's not `social_comments`).
- **Delivery differs from chat.** `chat` shows in the live widget and only emails on idle; `portal` **always emails** a threaded digest (latest message on top + external-only history) via [[../libraries/portal__thread-email]] — handled in `send()` (immediate) and [[deliver-pending-send]] (delayed). No live widget to fall back from.

## Tables read (not written)

- [[../tables/ai_channel_config]]
- [[../tables/ai_personalities]]
- [[../tables/journey_definitions]]
- [[../tables/macros]]
- [[../tables/orders]]
- [[../tables/playbooks]]
- [[../tables/workflows]]
- [[../tables/workspace_members]]
- [[../tables/workspaces]]

---

[[../README]] · [[../integrations/inngest]] · [[../../CLAUDE]]
