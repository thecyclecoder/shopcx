# Control Tower — Inline AI Agent Coverage ⏳

**Owner:** [[../functions/platform]] · **Parent:** extends [[control-tower]]. The Control Tower landed monitoring **crons + box-worker agent-kinds**, but the **inline, event-driven AI agents** that run server-side per-ticket emit no heartbeat — so a QC/decision agent can silently stop and never page anyone. Flagged via the **AI ticket analyzer** (a QC agent): if it stopped scoring/escalating tickets, the dashboard would show nothing.

The Control Tower's coverage must be **every autonomous loop**, not just the ones on a queue or a cron. This registers the inline AI agents with a heartbeat + a work-exists/error assertion, and sweeps for any other uncovered entry point.

## The uncovered inline agents (audit + register each)
- **`ai:ticket-analyzer`** (`src/lib/ticket-analyzer.ts` `analyzeTicket`) — the QC grader: scores a handled ticket, escalates on ≤5 / severe types, writes `ticket_analyses`. **Flagship.**
- **`ai:journey-delivery`** (`src/lib/journey-delivery.ts`) — delivers journeys to tickets/portal.
- **`ai:fraud-detector`** (`src/lib/fraud-detector.ts`) — fraud QC on orders/customers.
- **`ai:orchestrator`** (`src/lib/sonnet-orchestrator-v2.ts`) — the main per-ticket decision agent (reply/action). *(Deferred to P2 — it shares files with [[subscription-overcharge-remediation]]; gated behind it.)*
- **Sweep:** grep every server-side AI entry point (anything calling the model + acting) and confirm it's registered or add it — enforce the [[../operational-rules]] "register-or-it's-incomplete" rule retroactively. Log any intentionally-unmonitored ones with a reason.

## Mechanism (reuse Control Tower P1 infra)
- Each inline agent **emits a `loop_heartbeats` row** at the end of each run: `ok` (succeeded) / not (threw or returned an error), `produced` (e.g. the analysis id + score), `detail`. A try/finally so a thrown run still beats with `ok:false`.
- **Registry entries** (`src/lib/control-tower/registry.ts`) for each, `kind: "inline-agent"`, with an **assertion** suited to event-driven work (no fixed cadence):
  - **Liveness-when-work-exists:** if inbound/handled tickets that *should* be analyzed exist in the window but **0 successful** analyzer heartbeats → alert ("ticket analyzer silent while N tickets awaited QC"). Same shape for journey-delivery (journeys queued but none delivered) + fraud-detector.
  - **Error-rate:** successful vs errored heartbeats over the window; an error spike (e.g. >X% or N consecutive failures) → alert ("ticket analyzer failing: N/M runs errored"). This catches the analyzer erroring on every ticket (running, but producing nothing useful).
- **Dashboard:** the inline agents appear as their own tiles in the Control Tower (green/amber/red, last run, last produced, error rate) alongside the crons + box kinds.

## Verification
- On `/dashboard/developer/control-tower` (owner), expect a new **Inline AI agents** group with three tiles — `ai:ticket-analyzer`, `ai:journey-delivery`, `ai:fraud-detector` — each green (or idle-green) with a cadence chip + history strip.
- In a prod console, run `analyzeTicket(<a recently-closed AI ticket id>, "manual")` → expect a new `loop_heartbeats` row `loop_id='ai:ticket-analyzer'`, `kind='inline-agent'`, `ok=true`, `produced` carrying `{ analysis_id, score, ai_message_count }`; the tile shows that as "last produced".
- Temporarily unset `ANTHROPIC_API_KEY` (or point the grader at a 500) and run a handful of `analyzeTicket` calls → expect `ok=false` beats; once `errored/total > 50%` over the 2h window (≥4 runs), expect a red `ai:ticket-analyzer` tile + an open `loop_alerts` row `reason='inline_agent_error_rate'` + a Slack page.
- With the `ticket-analysis-cron` paused so QC-eligible tickets pile up (closed + `ai`-tagged + not analyzed since their last update, updated in the last 2h) and zero successful analyzer beats in the window → expect a red tile + `loop_alerts` `reason='inline_agent_silent'`, detail "silent while N awaited" (the silent-death the dashboard couldn't show before). Resume the cron → next monitor tick auto-resolves it (green).
- Send a journey on a ticket (`POST /api/tickets/[id]/send-journey`) → expect an `ai:journey-delivery` `ok=true` beat with `produced.channel`. Drive `launchJourneyForTicket` against a channel with no delivery path (fail-loud) → `ok=false` beat; a burst trips the error-rate / silent assertion (journey_sessions exist in window but 0 successful beats).
- Trigger a web-checkout order fraud check (`fraud/order.check`, or place a test web order) → expect an `ai:fraud-detector` `ok=true` beat with `produced.flagged`. With web orders arriving but zero successful fraud beats in the window → silent alert.
- Negative: a genuinely-idle agent (no closed AI tickets / no journeys / no web orders in the window) shows **green** "idle", never red. An intentional analyzer skip (spam tag / no AI turn) records `ok=true` (a successful no-op), so it never inflates the error rate.
- The AI-entry-point audit sweep lives in [[../libraries/control-tower]] § "AI entry-point coverage audit" — every one of the 48 model-calling files is registered, deferred to P2, or skipped-with-a-reason.

## Phase 1 — ticket-analyzer + journey-delivery + fraud-detector + the sweep ✅
Heartbeat emits in `analyzeTicket`, `launchJourneyForTicket`, `checkOrderForFraud` (try/finally, `emitInlineAgentHeartbeat`); their registry entries (`kind:'inline-agent'`, `ai:<name>`) + the `evalInlineAgent` assertions (silent-when-work-exists via `countInlineWork` + error-rate / consecutive-failure); the **Inline AI agents** dashboard group; and the AI-entry-point audit sweep ([[../libraries/control-tower]]). [[../operational-rules]] "register-or-it's-incomplete" extended to inline AI agents. Brain: [[control-tower]] · [[../libraries/ticket-analyzer]] · [[../libraries/journey-delivery]] · [[../libraries/fraud-detector]] · [[../tables/loop_heartbeats]] · [[../dashboard/control-tower]] · [[../inngest/control-tower-monitor]].

## Phase 2 — orchestrator coverage ⏳
**Blocked-by:** [[subscription-overcharge-remediation]] (shares `sonnet-orchestrator-v2.ts`). Heartbeat + assertion for `ai:orchestrator` (per-ticket decision agent) — error-rate + decisions-produced-when-tickets-need-handling.
