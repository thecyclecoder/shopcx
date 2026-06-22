# dashboard/control-tower

The single "is the machine healthy?" screen ([[../specs/control-tower]] Phase 1) — a green/amber/red tile per autonomous loop. The objective-owner's window from the north star: where the CEO sees whether every proxy-optimizing loop is still alive and doing its job.

**Route:** `/dashboard/developer/control-tower` (client poller, owner-only)
**Sidebar:** **Developer** section (owner-only) → **Control Tower** (right under [[roadmap|Build box]]).

## Surfaces

- **Summary bar** — counts of healthy / warning / alerting loops + "updated Ns ago".
- **Tiles, grouped by kind** (Worker · Crons · Agent lanes · Inline AI agents) — each tile shows the loop label + description, its expected cadence, a colored status dot + `statusText`, **last ran**, **last produced** (compacted from the heartbeat's `produced` jsonb), any **open alert** (with how long it's been open + the violation detail), and a **history strip** (last ~10 runs, green/red ticks).
  - **green** — healthy, or genuinely idle (no work to do). **amber** — warning (cron awaiting first run, worker mid self-update, a not-ok cron beat). **red** — an active violation that has paged the owners.
  - **Inline AI agents** (`ai:ticket-analyzer` QC grader, `ai:journey-delivery`, `ai:fraud-detector`) are event-driven, so their tile shows the rolling-window error rate + last-produced and goes **red** on either **silent-while-work-exists** ("silent while N awaited") or an **error-rate spike** ("N/M runs errored"). A genuinely-idle agent (no work in the window) stays **green**. `ai:orchestrator` joins them in agent-coverage Phase 2.
- Polls `GET /api/developer/control-tower` every ~15s. Owner-gated (re-checks `workspace_members.role='owner'`; non-owners see an owner-only notice).

## Data source

- `GET /api/developer/control-tower` (`src/app/api/developer/control-tower/route.ts`) → `buildControlTowerSnapshot()` ([[../libraries/control-tower]]). **Read-only** — the dashboard never opens/resolves alerts or pages; that's the [[../inngest/control-tower-monitor]] cron's job. Same snapshot the monitor evaluates, so the screen and the alerting agree.
- Reads [[../tables/worker_heartbeats]] (box), [[../tables/loop_heartbeats]] (crons + agent kinds + inline AI agents), [[../tables/loop_alerts]] (open incidents), [[../tables/agent_jobs]] (stuck detection), plus per-inline-agent upstream work counts ([[../tables/tickets]] / `journey_sessions` / [[../tables/orders]]).

## Permissions

Owner-only — both the page (client `role` guard) and the API (`workspace_members.role='owner'`, 403 otherwise).

## Files

- `src/app/dashboard/developer/control-tower/page.tsx` (tiles + history strip)
- `src/app/api/developer/control-tower/route.ts` (owner-gated snapshot)
- `src/lib/control-tower/monitor.ts` ([[../libraries/control-tower]])

## Related

[[../specs/control-tower]] · [[../inngest/control-tower-monitor]] · [[../libraries/control-tower]] · [[../tables/loop_heartbeats]] · [[../tables/loop_alerts]] · [[roadmap]] · [[../operational-rules]]
