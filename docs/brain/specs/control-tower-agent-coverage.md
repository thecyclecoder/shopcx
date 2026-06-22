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
- Make `analyzeTicket` throw (or return error) on a run → a `loop_heartbeats` row with `ok:false`; a burst → an error-rate alert + a red `ai:ticket-analyzer` tile. A healthy run → `ok:true` with the analysis id/score + green tile.
- Stop the analyzer entirely while QC-eligible tickets exist for the window → the liveness-when-work-exists assertion alerts "analyzer silent while N awaited QC" (the exact silent-death the dashboard couldn't show before).
- journey-delivery + fraud-detector each beat + assert the same way; their tiles show on the dashboard.
- The audit sweep enumerates every server-side AI entry point and each is either registered or logged as intentionally-skipped with a reason.
- Negative: a genuinely-idle agent (no work to do) is **green**, not red (work-exists guards against false positives).

## Phase 1 — ticket-analyzer + journey-delivery + fraud-detector + the sweep ⏳
Heartbeat emits in `analyzeTicket`, `journey-delivery`, `fraud-detector`; their registry entries + inline-agent assertions (liveness-when-work-exists + error-rate); dashboard tiles; the AI-entry-point audit sweep. Brain: [[control-tower]] · [[../libraries/ticket-analyzer]] · [[../tables/loop_heartbeats]] · [[../dashboard/control-tower]].

## Phase 2 — orchestrator coverage ⏳
**Blocked-by:** [[subscription-overcharge-remediation]] (shares `sonnet-orchestrator-v2.ts`). Heartbeat + assertion for `ai:orchestrator` (per-ticket decision agent) — error-rate + decisions-produced-when-tickets-need-handling.
