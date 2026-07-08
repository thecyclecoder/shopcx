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

## Outreach handling — deterministic close, no Sol dispatch, zero AI on automated senders

[[../specs/outreach-tickets-deterministically-close-no-sol-dispatch-no-ai-cost]]. Two deterministic short-circuit lanes fire BEFORE Sol's first-touch dispatch below, so an outreach ticket (automated notification OR human brand-collab / UGC pitch) NEVER enqueues a Max-tier `ticket-handle` `agent_jobs` row and NEVER pays for a Sonnet/Opus orchestrator turn. Both lanes route through the same pure [[../libraries/outreach-route]] `decideOutreachRoute` predicate — the FOUR Phase-3 verification tests in `src/lib/outreach-route.test.ts` pin its behavior, so the shipped handler runs the exact same routing invariant the tests exercise.

- **§ 1a2 — Phase 2: automated-sender pre-filter (zero AI).** Ahead of the `classify-bucket` Haiku step, the handler calls `decideOutreachRoute({isNew, senderEmail: st.custEmail, body: msg, ...})` (no `classifierBucket`). On `kind === "pre_filter_close"` the step `outreach-automated-sender-pre-filter` stamps `cls:outreach` + `outreach` tags, closes the ticket via `setStatus`, and returns `{ status: "outreach_automated_sender_pre_filter" }` — the classifier is NEVER invoked and zero AI dollars are spent. The predicate matches (a) local-part patterns `no[-_]?reply|donotreply|do[-_]not[-_]reply` OR standalone `mailer[-_]daemon|postmaster|bounces?`, (b) a conservative automated-domain allowlist (`email.apple.com`, `bounces.google.com`, `noreply.github.com`, `notify.trustpilot.com` + subdomains), OR (c) unambiguous body markers ("please do not reply to this email", "this mailbox is not monitored", "this is an automated email", "you are receiving this email because you subscribed"). Conservative on purpose — false-positive-averse per the spec so a genuine customer email is never caught. See [[../libraries/automated-sender]].
- **§ 1c — Phase 1: classifier-bucket outreach short-circuit.** After the `classify-bucket` Haiku returns `outreach` (cheap — 10 tokens), the handler calls `decideOutreachRoute(..., classifierBucket: msgType)`. On `kind === "classifier_close"` the step `outreach-deterministic-close` closes the ticket + writes a system note (the `outreach` tag was already stamped at § 1b) and returns `{ status: "outreach_deterministic_close" }`. Every downstream paid lane — Sol first-touch dispatch (§ 2b below), inflection gate (§ 3.97), Sonnet orchestrator (§ 2e) — is bypassed by the early return.
- **Belt-and-suspenders on the parallel dispatch lanes.** Both the Sol first-touch dispatch predicate (§ 2b) and the Sonnet orchestrator entry (§ 2e) additionally check `msgType !== "outreach"` (the outreach guard). The primary short-circuit at § 1c already returned above, so these checks only fire if a future refactor moves the block — pinning the classifier bucket into the parallel dispatch predicates prevents an accidental leak of an outreach ticket into a paid handling session.

Verification bullets covered by [[../libraries/outreach-route]] `outreach-route.test.ts` (4 tests) + [[../libraries/automated-sender]] `automated-sender.test.ts` (12 tests): (1) classifier→outreach ticket ends `status='closed'` + tagged + zero `ticket-handle` `agent_jobs`; (2) no-reply sender ends closed + tagged with classifier NOT invoked; (3) genuine customer email (normal address) routes through the classifier + Sol dispatch; (4) brand-collab human outreach on a normal domain falls through Phase 2 → is caught by Phase 1 close → no Sol session.

## Step 2b — Sol first-touch dispatch

Phase 3 of [[../specs/sol-ticket-direction-artifact-and-first-touch-box-session]] + Phase 1 of [[../specs/sol-first-touch-ack-only-on-chat-not-async-channels]] (chat-only ack). When the event is `is_new_ticket=true` AND [[../tables/ai_channel_config]] has `sol_first_touch_enabled=true` for the ticket's channel AND no agent is involved (`agent_intervened` / `assigned_to` / `escalated_to` all null) AND fraud didn't block (fraud gate runs first), the handler enqueues an `agent_jobs` row (`kind='ticket-handle'`, `instructions = {ticket_id, workspace_id, turn_index, reason:'first_touch'}`) that runs [[../functions/cs|Sol]]'s box session on Max via the box worker's `runTicketHandleJob` (see [[../libraries/ticket-directions]] for the `writeDirection` SDK Sol calls). The inline Sonnet Step 2e path below is **skipped for this turn**.

**The first-touch ack is chat-only:** On `channel === 'chat'` (customer waiting live) the handler ALSO ships a short holding message via the standard `send()` wrapper right now — customer sees a response within seconds, `ticket_resolution_events.shipped_at` is stamped on turn 1, Sol's real reply arrives on turn 2. On async channels (email/sms/portal/meta_dm) the ack send AND its `ticket_resolution_events` ack row are **skipped** — a redundant "we'll get back to you" is noise when Sol's substantive real reply is what the customer will next see; Sol authors turn 1 directly and her real reply is the sole first-touch customer message. Every subsequent cheap-execution turn reads the durable [[../tables/ticket_directions]] row Sol authored instead of re-running full-context reasoning — the M1 spine of [[../goals/sol-ticket-direction-then-cheap-execution]]. Default is **off** (`sol_first_touch_enabled=false`); rollout is opt-in per workspace+channel.

## Step 3.97 — Pre-ship inflection gate ([[../libraries/inflection-detector]])

Between the inbound-message handling (§ 3.9x) and either the playbook short-circuit (§ 3.98) OR the Sonnet orchestrator (§ 4), the `sol-inflection-gate` step calls [[../libraries/inflection-detector]] `applyInflectionGate` to decide whether the drafted reply should ship. Phase 2 + Phase 4 (Fix 1) of [[../specs/sol-drift-frustration-detector-and-re-session-router]].

- **kind='none'** — the newest customer message still fits the live [[../tables/ticket_directions]] intent (or no Direction has been authored). The step returns and the pipeline falls through to the playbook short-circuit / Sonnet orchestrator dispatch exactly as today.
- **kind='drift' | 'frustration'** — the drafted reply is HELD (no `ticket_messages` outbound row for this turn — the gate returns BEFORE Sonnet/playbook runs, so no reply is even drafted). One [[../tables/ticket_resolution_events]] row is staged with `reasoning='sol:inflection-<kind>'` and the classifier `evidence` blob stashed in the jsonb `chosen` column. On `frustration` AND `ai_channel_config.sol_frustration_holding_message_enabled !== false` (migration-default `true`), the standard `sendWithDelay` wrapper sends a short "we're looking into that for you" inline holding message so the customer knows they were heard. Then [[../libraries/inflection-detector]] `reSessionSol` supersedes the live Direction (compare-and-set) and enqueues a new `agent_jobs` row `kind='ticket-handle'` `instructions.reason='inflection'` for the box worker's `runTicketHandleJob` to author a fresh Direction. Drift bounces are silent by design.

Gate placement is BEFORE Sonnet so we don't pay for a Sonnet draft that we would immediately drop — the observable behavior (no reply, `sol:inflection` ledger row) is identical.

Playbook-active tickets still enter this gate. `applyInflectionGate` reads `tickets.active_playbook_id` and passes `isPlaybookActive` to `detectInflection`; the detector's Stage-1 drift path is SKIPPED mid-playbook (the playbook drives the reply, not Direction alignment), but the frustration regex catalog still fires — so a mid-playbook "refund now" bounces to re-session per the spec.

Guards (coaching #1/#2 pattern): `reSessionSol` wraps `superseDirection`'s workspace-scoped compare-and-set (so a racing caller can't fan out a duplicate ticket-handle session), the DB partial UNIQUE on ticket_directions is a second belt, the ledger stage is best-effort (a diagnostic-substrate failure MUST NOT block the bounce), and the holding-message send is doubly-gated (kind==='frustration' AND the config column true).

## Step 2d — Sol-chosen vs signal-matched playbook dispatch

Phase 2 of [[../specs/sol-session-chosen-playbook-selection-retire-brittle-triggers]] moves playbook selection inside Sol's first-touch box session for the Sol cohort. `routeExec` § 2 now branches on the live [[../tables/ticket_directions]] row BEFORE the deterministic matcher fires:

- **§ 2a — Sol-chosen path** ([[../libraries/ticket-directions]] `resolveSolChosenPlaybook`). Non-null return only when: live Direction exists (`superseded_at IS NULL`), `chosen_path='playbook'`, `plan.playbook_slug` is a non-empty string, `tickets.active_playbook_id IS NULL` (this is a START not a follow-up turn — [[../specs/sol-cheap-execution-over-ticket-direction]] Phase 4's `Step 3.98` short-circuit already owns "still running"), and the slug resolves to a live `public.playbooks` row for the ticket's workspace. On a hit, [[../libraries/playbook-executor]] `startPlaybook` is called with `seed_context = plan.playbook_seed_context` so the executor's step 0 doesn't re-derive the ids Sol already picked. Ledger stamp: `ticket_resolution_events.reasoning = 'sol:session-chose-playbook:{slug}'` (best-effort — the send never fails on a ledger error).
- **§ 2b — Signal-matched path** (existing `matchPlaybookScored` → `applyDeferThreshold` → `matchPlaybook` chain). Ledger stamp on a hit: `ticket_resolution_events.reasoning = 'sol:matcher-chose-playbook:{slug}'` where `slug` is the resolved `playbooks.slug` for the matched row (falls back to the sanitized name if the row hasn't been backfilled yet). The two prefixes reference the same identifier space so Phase 4's analytics tile can split by source without a heuristic classifier.

Guards (learning #2 pattern — confirming predicate at the action point):
- Direction read is workspace-scoped (`workspace_id = ?`) — a cross-workspace ticket-id collision cannot dispatch.
- Playbook slug lookup is workspace-scoped — the same slug in another workspace does NOT authorize the dispatch.
- `active_playbook_id IS NULL` gate on the ticket — a ticket mid-playbook stays on its existing branch (the Step 3.98 short-circuit handles follow-up turns).

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
