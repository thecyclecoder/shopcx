# Control Tower — Inline AI Agent Coverage ✅

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
- On `/dashboard/developer/control-tower`, look under **Inline AI agents** → expect three tiles: `ai:ticket-analyzer`, `ai:journey-delivery`, `ai:fraud-detector`, each green when healthy/idle, showing last-ran + last-produced + a history strip.
- Run a normal analysis cycle (close an AI-handled ticket, let `ticket-analysis-cron` tick or call `analyzeTicket` via the ticket-improve `rescore` action) → expect a fresh `loop_heartbeats` row `loop_id='ai:ticket-analyzer'`, `kind='inline-agent'`, `ok=true`, `produced` = `{analysis_id, score, ai_messages}`; the tile stays green.
- Force `analyzeTicket` to error on a burst of runs (e.g. point `ANTHROPIC_API_KEY` at a bad endpoint or temporarily make the grader call 5xx) → expect ≥`minRunsForErrorRate` (5) beats in the 2h window with >50% `ok=false`; the monitor (`/api/developer/control-tower` + the `control-tower-monitor` cron) flips the `ai:ticket-analyzer` tile **red** with `error_rate` and opens a `loop_alerts` row that pages owners.
- Stop the analyzer entirely while closed AI-handled tickets with `last_analyzed_at IS NULL` exist (updated within 2h) → expect the **liveness-when-work-exists** check: tile red, `idle_while_work`, detail "AI ticket analyzer silent while N item(s) awaited it — 0 successful runs in the last 120m".
- Deliver a journey (`launchJourneyForTicket` from a ticket reply) → expect a `loop_id='ai:journey-delivery'` beat `ok=true`, `produced.delivered=true`; a delivery that hits the fail-loud path (no channel) → `ok=false`. Fraud: a new order firing `fraud/order.check` → a `loop_id='ai:fraud-detector'` beat, `ok=true`, `produced.flagged` reflecting whether a case opened.
- Negative (no false positive): with the analyzer healthy but **no** QC-eligible tickets and **no** runs in the window, the tile is **green** ("idle · …"), not red — the work-exists guard suppresses the alert.
- The audit sweep below enumerates every server-side AI entry point; each is registered (inline-agent), deferred (orchestrator → Phase 2), or logged intentionally-skipped with a reason.

## Audit sweep — every server-side AI entry point (register-or-it's-incomplete)
Grep: `api.anthropic.com/v1/messages | new Anthropic(`. Classification of each model-calling entry point as an **autonomous loop** (register) vs not:

**Registered this phase (`kind:'inline-agent'`):**
- `src/lib/ticket-analyzer.ts` `analyzeTicket` → `ai:ticket-analyzer`.
- `src/lib/journey-delivery.ts` `launchJourneyForTicket` → `ai:journey-delivery`.
- `src/lib/fraud-detector.ts` `checkOrderForFraud` (the per-order screen incl. AI screen + Haiku reseller match) → `ai:fraud-detector`.

**Deferred to Phase 2 (the per-ticket decision agent + the executors it drives in the same turn — one `ai:orchestrator` beat will cover the decision loop):** `src/lib/sonnet-orchestrator-v2.ts`, `src/lib/playbook-executor.ts`, `src/lib/action-executor.ts`, `src/lib/inngest/unified-ticket-handler.ts`, `src/lib/remedy-selector.ts`, `src/lib/cancel-lead-in.ts`, `src/lib/social-comment-orchestrator.ts`, `src/lib/pattern-matcher.ts`, `src/lib/popup/decide.ts`, `src/lib/packing-slip-message.ts`. Blocked-by [[subscription-overcharge-remediation]] (shares `sonnet-orchestrator-v2.ts`).

**Intentionally skipped — human-in-the-loop (a person clicked; failure surfaces to them synchronously, not a silent autonomous loop):** every model call under `src/app/api/**` — `tickets/[id]/analysis/override`, `tickets/[id]/apply-macro`, `tickets/[id]/suggest-pattern`, `tickets/[id]/tag-feedback`, `workspaces/[id]/fraud-cases/[caseId]/analyze`, `workspaces/[id]/knowledge-base/generate`, `workspaces/[id]/playbooks/fix`, `workspaces/[id]/playbooks/simulate`, `workspaces/[id]/products/[productId]/{generate-complementarity,reconcile-benefits,regenerate-field}`. Plus the studio-driven creative generators (`ad-angles`, `ad-avatar-proposals`, `ad-meta-copy`, `ad-script`, `ad-statics-copy`, `advertorial-pages`, `creative-skeleton`, `blog/write-post`, `posts/import-article`, `social/generate-caption`, `meta-product-match`, `translate`) — invoked from the in-app studio on demand.

**Intentionally skipped here — cron-driven, covered by the *cron* coverage track, not the inline-agent track (their liveness is a `kind:'cron'` registry row, out of scope for this spec):** `src/lib/inngest/ai-nightly-analysis.ts` (legacy, superseded by `ticket-analysis-cron`), `customer-demographics.ts`, `product-intelligence.ts`, `review-tagging.ts`, `seo-keyword-research.ts`, `meta/decision-engine.ts`, plus the model calls in `daily-analysis-report.ts`, `sonnet-prompt-auto-review.ts`, `klaviyo.ts`, `product-intelligence/engine.ts`, and the research recipes (`research/recipes/*`) which run inside the `ai:orchestrator`/research flow (Phase 2). The `fraud-generate-summary` Haiku summary lives in the same `fraud/case.created` chain the `ai:fraud-detector` per-order screen feeds.

## Phase 1 — ticket-analyzer + journey-delivery + fraud-detector + the sweep ✅
Heartbeat emits in `analyzeTicket`, `journey-delivery`, `fraud-detector`; their registry entries + inline-agent assertions (liveness-when-work-exists + error-rate); dashboard tiles; the AI-entry-point audit sweep. Brain: [[control-tower]] · [[../libraries/ticket-analyzer]] · [[../tables/loop_heartbeats]] · [[../dashboard/control-tower]].

## Phase 2 — orchestrator coverage ✅
**Blocked-by:** [[subscription-overcharge-remediation]] (✅ shipped — unblocked). `callSonnetOrchestratorV2` now emits one `ai:orchestrator` inline-agent beat per run (try/finally wrapper around the inner `runOrchestratorDecision`): `ok:false` when the run threw OR returned a degraded/fallback decision (no API key / API error / max-rounds / parse-fail — all funnel through `fallbackWithCancelRoute`, tagged via a module `WeakSet<SonnetDecision>`), `ok:true` on a real model decision incl. a model-chosen `escalate`; `produced = {action_type, handler_name, model}`. Registry entry `ai:orchestrator` (`inlineWorkSignal: 'tickets-awaiting-decision'` — inbound customer `ticket_messages` in the 2h window — + error-rate `>50%` of `≥5` runs). The tile renders under **Inline AI agents** automatically. Brain: [[../libraries/sonnet-orchestrator-v2]] · [[../libraries/control-tower]] · [[../dashboard/control-tower]].

## Verification
- On `/dashboard/developer/control-tower` under **Inline AI agents**, expect a fourth tile **`ai:orchestrator`** (AI orchestrator — "per inbound customer message") alongside the three Phase 1 tiles — green when healthy or genuinely idle.
- Let a normal AI ticket reply run (an inbound customer message fires `unified-ticket-handler` → `callSonnetOrchestratorV2`) → expect a fresh `loop_heartbeats` row `loop_id='ai:orchestrator'`, `kind='inline-agent'`, `ok=true`, `produced` = `{action_type, handler_name, model}`; the tile stays green and `lastProduced` shows the action_type.
- Force the orchestrator to fail on a burst (point `ANTHROPIC_API_KEY` at a bad endpoint, or make the messages API 5xx) so ≥`minRunsForErrorRate` (5) runs land in the 2h window returning the fallback escalate → expect those beats `ok=false`, and the monitor (`/api/developer/control-tower` + the `control-tower-monitor` cron) flips the `ai:orchestrator` tile **red** with `reason='error_rate'` ("failing: N/M runs errored") + a paging `loop_alerts` row.
- Stop the orchestrator entirely while inbound customer messages keep arriving (inbound `ticket_messages` with `direction='inbound'`, `author_type='customer'` updated within 2h, 0 successful `ai:orchestrator` beats) → expect the **liveness-when-work-exists** check: tile red, `reason='idle_while_work'`, detail "AI orchestrator silent while N item(s) awaited it — 0 successful runs in the last 120m".
- Negative (no false positive): a **model-chosen** `escalate` decision (the orchestrator deliberately escalates a real ticket) beats `ok=true`, NOT a fallback — so a workspace that legitimately escalates does not trip error-rate; and with no inbound traffic + no runs the tile is green ("idle · …"), not red.
