# libraries/control-tower

The Control Tower module ([[../specs/control-tower]] Phase 1) — the registry, the heartbeat emit helper, and the monitor/snapshot logic that powers the [[../inngest/control-tower-monitor]] cron and the [[../dashboard/control-tower]] dashboard.

**Files:** `src/lib/control-tower/registry.ts` · `src/lib/control-tower/heartbeat.ts` · `src/lib/control-tower/monitor.ts`

## `registry.ts` — the loop registry (code config)

The single source of truth for every loop the monitor watches. **Add a row here when you ship a new cron / worker / agent-kind / inline AI agent** ([[../operational-rules]] "register-or-it's-incomplete").

- `type LoopKind = "worker" | "cron" | "agent-kind" | "inline-agent"`
- `type InlineWorkSignal = "closed-ai-tickets" | "journey-sessions" | "web-orders"` — which upstream-demand query proves "work existed" this window.
- `interface MonitoredLoop { id, kind, label, description, expectedCadence, livenessWindowMs?, shaGraceMs?, agentKind?, stuckThresholdMs?, windowMs?, workSignal?, errorRateThreshold?, errorRateMinSample?, consecutiveFailureLimit? }` (the last five are inline-agent only).
- `MONITORED_LOOPS: MonitoredLoop[]` — the box worker (`box`), 7 crons (each cron's inngest fn id + a cadence-derived `livenessWindowMs`), 10 agent kinds (`agent:<kind>` + a per-kind `stuckThresholdMs`), and 3 inline AI agents (`ai:<name>` + `windowMs`/`workSignal`/error-rate config).
- `WORKER_BOX_ID = "box"` (matches `scripts/builder-worker.ts`) · `agentLoopId(kind)` → `agent:<kind>` · `aiAgentLoopId(name)` → `ai:<name>`.

### Inline AI agents (`ai:<name>`)

Event-driven, server-side AI agents that run inline per ticket/order — no cron, no queue, so no fixed cadence. Each beats once per run (in a try/finally) via `emitInlineAgentHeartbeat(name, …)` and is asserted over a rolling `windowMs`:

| loop_id | function | workSignal (work-exists) |
|---|---|---|
| `ai:ticket-analyzer` | `analyzeTicket` ([[ticket-analyzer]]) | `closed-ai-tickets` (closed `ai` tickets updated in-window, not analyzed since their last update) |
| `ai:journey-delivery` | `launchJourneyForTicket` ([[journey-delivery]]) | `journey-sessions` (sessions created in-window — a journey "queued" before its channel send) |
| `ai:fraud-detector` | `checkOrderForFraud` ([[fraud-detector]]) | `web-orders` (web-checkout orders created in-window — exactly what gets screened) |

`ai:orchestrator` (`sonnet-orchestrator-v2.ts`) is **deferred to agent-coverage Phase 2** (shares files with [[../specs/subscription-overcharge-remediation]]).

## `heartbeat.ts` — end-of-run emit

Best-effort writes of one [[../tables/loop_heartbeats]] row (never throws).

- `emitLoopHeartbeat(loopId, kind, { ok?, produced?, detail?, durationMs? })`
- `emitCronHeartbeat(functionId, …)` — `kind:'cron'`, `loop_id` = the inngest fn id. Called by each monitored cron inside a `step.run("emit-heartbeat", …)` before its return.
- `emitAgentHeartbeat(agentKind, …)` — `kind:'agent-kind'`, `loop_id` = `agent:<kind>`. (The box worker writes its agent beats via its own inline `writeLoopHeartbeat` against its existing admin client, not this helper — same shape.)
- `emitInlineAgentHeartbeat(name, …)` — `kind:'inline-agent'`, `loop_id` = `ai:<name>`. Called by each inline AI agent in a try/finally at the END of every run: `ok:true` on success (`produced` = the analysis id+score / delivery id / flag) or an intentional skip; `ok:false` on a real error or a throw.

## `monitor.ts` — snapshot + monitor

- `buildControlTowerSnapshot(admin?)` → `ControlTowerSnapshot { generatedAt, counts:{green,amber,red}, loops: LoopStatus[] }`. **READ-ONLY**: one batched read of [[../tables/worker_heartbeats]], [[../tables/loop_heartbeats]] (last 600 beats, grouped per loop, ≤10 history each), open [[../tables/loop_alerts]], and active [[../tables/agent_jobs]]; **plus** per-inline-agent dedicated reads (history + window beats + upstream work count) so a high-volume inline agent can't starve the shared 600-beat pull. Evaluates each loop to a `LoopStatus { color, statusText, lastRanAt, lastProduced, detail, violation, history, openAlert }`. Used **verbatim** by the dashboard API.
- `runControlTowerMonitor()` → `MonitorResult`. Builds the snapshot, then **acts**: opens a de-duped [[../tables/loop_alerts]] incident on each newly-red loop (paging owners via [[../libraries/notify-ops-alert]]), bumps `last_seen_at` while still red (no re-page), and resolves on recovery. Called only by the cron.
- Evaluators: `evalWorker` (liveness + SHA-behind), `evalCron` (freshness), `evalAgentKind` (stuck jobs), `evalInlineAgent` (silent-while-work-exists + error-rate). Genuinely-idle/healthy → green; a freshly-shipped cron with no beat yet → amber (never a false red).
- `evalInlineAgent` over the loop's `windowMs`: **(a)** `workCount > 0 && successfulRuns === 0` → red `inline_agent_silent` ("silent while N awaited"); **(b)** `errored/total > errorRateThreshold` (with `total ≥ errorRateMinSample`) OR `consecutiveFailures ≥ consecutiveFailureLimit` → red `inline_agent_error_rate`. `countInlineWork()` resolves the `workSignal` to a count. Idle (no runs, no work) = green.

## Gotchas

- **SHA-behind needs `VERCEL_GIT_COMMIT_SHA`** (the deployed commit) as the origin/main proxy; unset locally ⇒ the check is skipped (no false positive). It only fires red after `shaGraceMs` (default 30m) so an in-progress deploy / self-update never pages.
- **Agent-kind alert is off [[../tables/agent_jobs]], not the heartbeat** — idle = green. The heartbeat only feeds last-ran/history.
- **Inline-agent beats are high-volume** (one per ticket/order), so they're read in dedicated per-loop queries — never trust the shared 600-beat pull to contain them. A `success === 0` liveness alert keys off the most recent ~300 in-window beats; any one `ok:true` beat clears it.
- **An inline agent's intentional skip is `ok:true`, not `ok:false`** — the analyzer choosing not to grade a spam/no-AI-turn ticket is a *successful* no-op. Only real errors (no API key, HTTP error, parse fail, throw) are `ok:false`, so the error-rate assertion doesn't false-positive on a healthy agent that skips most of its input.

## AI entry-point coverage audit (register-or-skip sweep)

The [[../operational-rules]] "register-or-it's-incomplete" rule enforced retroactively across every server-side AI entry point (model call + acts). 48 files call the model; each is **registered** as an autonomous loop or **skipped with a reason**:

| Class | Files | Disposition |
|---|---|---|
| **Registered (inline-agent, this spec)** | `ticket-analyzer.ts`, `journey-delivery.ts`, `fraud-detector.ts` | ✅ `ai:ticket-analyzer` · `ai:journey-delivery` · `ai:fraud-detector` |
| **Deferred — orchestrator decision loop** | `sonnet-orchestrator-v2.ts`, `playbook-executor.ts`, `inngest/unified-ticket-handler.ts`, `remedy-selector.ts`, `cancel-lead-in.ts` | ⏳ agent-coverage **Phase 2** (`ai:orchestrator`) — the per-ticket decide/act loop; gated behind [[../specs/subscription-overcharge-remediation]] (shared files). The lead-in/remedy/playbook helpers run *inside* this loop and are covered by its beat. |
| **Human-in-the-loop API routes** | `api/tickets/[id]/{analysis/override,apply-macro,suggest-pattern,tag-feedback}`, `api/workspaces/[id]/{knowledge-base/generate,playbooks/fix,playbooks/simulate,fraud-cases/[caseId]/analyze}`, `api/workspaces/[id]/products/[productId]/{generate-complementarity,reconcile-benefits,regenerate-field}` | Skipped — a human invokes each call and reviews the output; the operator *is* the supervisor. Not an autonomous loop. |
| **Content-draft generators (studio-driven)** | `ad-angles`, `ad-avatar-proposals`, `ad-meta-copy`, `ad-script`, `ad-statics-copy`, `advertorial-pages`, `creative-skeleton`, `blog/write-post`, `posts/import-article`, `social/generate-caption`, `meta-product-match`, `packing-slip-message`, `translate` | Skipped — produce drafts a human reviews/publishes (no autonomous act). |
| **Model-calling crons (cron-kind, tracked separately)** | `inngest/{customer-demographics,product-intelligence,review-tagging,seo-keyword-research}`, `daily-analysis-report`, `product-intelligence/engine`, `meta/decision-engine`, `sonnet-prompt-auto-review`, `klaviyo`, `pattern-matcher`, `popup/decide` | Skipped here — these are **cron/request-scoped**, not inline per-ticket agents. Cron-kind Control Tower coverage is its own backlog item (the existing 7-cron registry is selective); flagged, not silently ignored. |
| **Research recipes (fired by a registered parent)** | `research/recipes/verify-coupon-promises`, `research/recipes/verify-subscription-changes` | Skipped — fired by `analyzeTicket`'s severity actions via `ticket/research.requested` ([[../inngest/ticket-research]]); covered transitively by the now-monitored `ai:ticket-analyzer`. |
| **Deprecated / disabled** | `inngest/ai-nightly-analysis` | Skipped — superseded by `ticket-analysis-cron`; the Inngest fn has **no triggers** (disabled). |
| **Follow-up candidates (autonomous + acting, not yet registered)** | `social-comment-orchestrator.ts` (`moderateSocialComment` — auto-moderates social comments) | **Recommended** for a future inline-agent registration; out of this spec's scope (ticket-analyzer / journey / fraud + orchestrator-P2). Logged so it isn't silently uncovered. |

## Callers

[[../inngest/control-tower-monitor]] (`runControlTowerMonitor`) · `src/app/api/developer/control-tower/route.ts` (`buildControlTowerSnapshot`) · the 7 monitored crons + `scripts/builder-worker.ts` + the 3 inline AI agents ([[ticket-analyzer]], [[journey-delivery]], [[fraud-detector]]) — all heartbeat emits.

## Related

[[../specs/control-tower]] · [[../tables/loop_heartbeats]] · [[../tables/loop_alerts]] · [[../tables/worker_heartbeats]] · [[../inngest/control-tower-monitor]] · [[../dashboard/control-tower]] · [[../operational-rules]]
