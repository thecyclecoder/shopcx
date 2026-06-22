# dashboard/control-tower

The single "is the machine healthy?" screen ([[../specs/control-tower]] Phase 1 + Phase 2; [[../specs/control-tower-agent-coverage]] adds the inline AI agents; [[../specs/control-tower-complete-coverage]] P1 adds full cron coverage + the reactive event-driven agents) — a green/amber/red tile per autonomous loop. The objective-owner's window from the north star: where the CEO sees whether every proxy-optimizing loop is still alive and doing its job.

**Route:** `/dashboard/developer/control-tower` (client poller, owner-only)
**Sidebar:** **Developer** section (owner-only) → **Control Tower** (right under [[roadmap|Build box]]).

## Surfaces

- **Summary bar** — counts of healthy / warning / alerting loops + "updated Ns ago".
- **Tiles, grouped by kind** (Worker · Crons · **Reactive agents** · Agent lanes · **Inline AI agents**) — each tile shows the loop label + description, its expected cadence, a colored status dot + `statusText`, **last ran**, **last produced** (compacted from the heartbeat's `produced` jsonb), any **open alert** (with how long it's been open + the violation detail), and a **history strip** (last ~10 runs, green/red ticks). The Crons group now covers the **full Inngest cron set** (every `inngest.createFunction` cron), and **Reactive agents** are the event-driven Inngest functions — `unified-ticket-handler` (THE inbound ticket pipeline), `dunning-payment-failed`, `returns-process-delivery`, `journey-session-completed`, `agent-todo-execute`, `chargeback-received` — evaluated like inline agents (idle = green; red on liveness-while-work / error-rate). ([[../specs/control-tower-complete-coverage]] P1.)
  - **green** — healthy, or genuinely idle (no work to do). **amber** — warning (cron awaiting first run, worker mid self-update, a not-ok cron beat). **red** — an active violation that has paged the owners (a P1 liveness/freshness/stuck silence, an **inline-agent** liveness-while-work / error-rate failure ([[../specs/control-tower-agent-coverage]]), **or** a Phase 2 output-assertion failure — escalation idle-while-work, spec-test false-success, renewal integrity — where the loop ran but silently did nothing/wrong).
  - **Inline AI agents** (`ai:ticket-analyzer`, `ai:journey-delivery`, `ai:fraud-detector`, `ai:orchestrator`) — event-driven, no cadence: green when healthy or genuinely idle; red on **liveness-when-work-exists** (upstream work waited but 0 successful runs in the window) or **error-rate** (>50% of ≥5 runs errored). `statusText` carries the window counts ("healthy · N ok", "silent while N awaits", "failing: E/T errored"). `ai:orchestrator` ([[../specs/control-tower-agent-coverage]] Phase 2) is the per-ticket decision agent (`callSonnetOrchestratorV2`): its work-exists probe is inbound customer messages in the 2h window, and a run beats ok:false when it threw or returned a degraded/fallback decision — so a model that errors / parse-fails on every ticket trips error-rate even though it "ran".
- **Errors section** ([[../specs/error-feed-monitoring]] Phase 1 + Phase 2) — four panels (**Vercel errors · Inngest failures · Supabase errors (app-layer) · Supabase errors (DB logs)**) of grouped error incidents from the hidden surfaces. The fourth (Phase 2) is DB-level Supabase errors our app never saw — Postgres/auth/API — polled from the [[../integrations/supabase-management-logs]] API by [[../inngest/supabase-log-poll]] (`source='supabase-logs'`; green until the owner pastes the access token). Each panel shows its recency color (red ≤1 h, amber ≤24 h, else green — "no errors in the last 7 days"), the active-signature + total-occurrence counts, and the recent incidents (title, `×count`, last-seen). A new signature or a re-firing spike pages the owners (rate-limited: a burst of the same error = one page).
- **Spec drift section** ([[../specs/spec-drift-agent]]) — phases whose code is verifiably on `main` but whose emoji is still ⏳/🚧 with **no merged build on record**: the residue the [[../libraries/spec-drift|Spec-Drift Agent]] won't auto-flip. Each open [[../tables/spec_drift]] row shows the spec + `P{n}` + the drift detail, with a **Mark P{n} ✅** one-tap flip (rewrites the phase emoji on `main` via `POST /api/roadmap/spec-drift` → the shared `flipPhaseToShipped` writer, then resolves the row + enqueues a spec-test if now shipped) and a **Dismiss** (resolve the row, leave the markdown). Empty = no unresolved drift. (The agent auto-flips the confident cases — merged build + code on main — without surfacing them; this section is only the ambiguous residue.)
- Polls `GET /api/developer/control-tower` every ~15s. Owner-gated (re-checks `workspace_members.role='owner'`; non-owners see an owner-only notice).

## Data source

- `GET /api/developer/control-tower` (`src/app/api/developer/control-tower/route.ts`) → `buildControlTowerSnapshot()` + `buildErrorFeedSnapshot()` (merged as `errorFeed`) + `getOpenSpecDrift()` (merged as `specDrift`, [[../libraries/spec-drift]]) ([[../libraries/control-tower]]). **Read-only** — the dashboard never opens/resolves alerts or pages; that's the [[../inngest/control-tower-monitor]] cron's job (loops) + the feeders' `recordError` (errors). Same snapshot the monitor evaluates, so the screen and the alerting agree.
- Reads [[../tables/worker_heartbeats]] (box), [[../tables/loop_heartbeats]] (crons + agent kinds + inline agents), [[../tables/loop_alerts]] (open incidents), [[../tables/agent_jobs]] (stuck detection + Phase 2 enqueue checks), plus [[../tables/tickets]] + [[../tables/subscriptions]] for the Phase 2 output assertions, [[../tables/tickets]] + [[../tables/journey_sessions]] + [[../tables/orders]] + [[../tables/ticket_messages]] for the inline-agent work-exists probes, [[../tables/error_events]] for the Errors section, and [[../tables/spec_drift]] for the Spec drift section.

## Permissions

Owner-only — both the page (client `role` guard) and the API (`workspace_members.role='owner'`, 403 otherwise).

## Files

- `src/app/dashboard/developer/control-tower/page.tsx` (tiles + history strip + Errors panels)
- `src/app/api/developer/control-tower/route.ts` (owner-gated snapshot + error feed)
- `src/lib/control-tower/monitor.ts` + `src/lib/control-tower/error-feed.ts` ([[../libraries/control-tower]])
- `src/lib/spec-drift.ts` (`getOpenSpecDrift`) + `src/app/api/roadmap/spec-drift/route.ts` (the one-tap flip/dismiss, [[../libraries/spec-drift]])

## Related

[[../specs/control-tower]] · [[../specs/control-tower-complete-coverage]] · [[../specs/error-feed-monitoring]] · [[../specs/spec-drift-agent]] · [[../inngest/control-tower-monitor]] · [[../inngest/spec-drift-reconcile]] · [[../inngest/inngest-failure-capture]] · [[../inngest/supabase-log-poll]] · [[../integrations/vercel-log-drain]] · [[../integrations/supabase-management-logs]] · [[../libraries/control-tower]] · [[../libraries/spec-drift]] · [[../tables/loop_heartbeats]] · [[../tables/loop_alerts]] · [[../tables/error_events]] · [[../tables/spec_drift]] · [[../tables/error_feed_supabase_config]] · [[roadmap]] · [[../operational-rules]]
