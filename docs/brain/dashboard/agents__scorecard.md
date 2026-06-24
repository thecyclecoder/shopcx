# Dashboard · agents/scorecard

The owner-only **Platform Department Scorecard** surface — milestone (d) of the [[../goals/platform-department-scorecard|Platform Department Scorecard]] goal ([[../specs/platform-scorecard-surface]]). The instrument panel for the Platform department: the daily pulse, the weekly throughput + quality view, and the monthly leading curve, all read off the persisted, trended store the engine + cadence specs fill — never the raw tables, so the surface can never drift from the snapshot's truth.

**Route:** `/dashboard/agents/scorecard` (client poller, owner-only) · reachable from the [[agents|Agents hub]] header ("Scorecard →").

## Surfaces

- **Three cadence sections — Daily pulse · Weekly throughput + quality · Monthly leading curve.** Each section is a grid of KPI tiles, one per metric in that cadence's display registry ([[../libraries/platform-scorecard-display]]). The registries mirror the engine's three per-cadence metric registries ([[../libraries/platform-scorecard]] DAILY / WEEKLY / MONTHLY).
- **KPI tile** — label · current `value` (formatted by `unit`: count → integer; ratio/pct → `XX.X%`; hours → `X.Xh`) · **trend arrow** off `delta_pct` tinted by the per-metric polarity (e.g. ↓ on `human_touch_per_build` is **good**; ↓ on `build_success_rate` is **bad**) · a small **sparkline** rendered from the metric's `?metric=&cadence=` history. A tile with no snapshot yet renders muted **"no data yet"**, never a fabricated number (display-only proxy, [[../operational-rules]] § North star).
- **Reserved Fleet-spend tile** (Cost / budget) — a cross-goal slot at the foot of the daily section, wired to light up when the [[../goals/grow-surface-platform-agent-team]] **cost governor**'s M4 spend metric lands in `platform_scorecard_snapshots`. Renders "no data yet · cost governor" until then; documented here so that build knows the slot exists.
- **Regression tiles** ([[../specs/regression-backlog-reconciliation-scorecard]] Phase 1) — "Regressions today" sits in the daily section (`regressions` metric — headline `value` is the sum of `detected + fixed + reconciled + escalated`, `detail` carries each leg the board-watch line renders); "Re-verification coverage" sits in the weekly section (`regression_coverage_pct` — share of live shipped specs with a spec-test run in the trailing week, `detail.missing[]` is the queue the standing re-verification sweep should pick up next).

## Data source

- `GET /api/developer/agents/scorecard` (`src/app/api/developer/agents/scorecard/route.ts`) — owner-gated (`workspace_members.role='owner'`, 403 otherwise — mirrors every [[agents|Agents hub]] API). Reads **only** [[../tables/platform_scorecard_snapshots]] (the "read from the scorecard, never the raw tables" invariant from [[../libraries/meta__scorecards]]). Two modes:
  - default → `{ daily, weekly, monthly }`, the latest snapshot per `(metric_key, cadence)` with `value`, `prior_value`, `delta_pct`, `unit`, `window_days`, `snapshot_date`, `detail`.
  - `?metric=KEY&cadence=daily|weekly|monthly` → that metric's `history` (chronological, oldest → newest, up to 60 points) — the sparkline series.
- The snapshot store is written **only** by [[../libraries/platform-scorecard]] `computePlatformScorecard` ([[../specs/platform-scorecard-engine]]) on the [[../inngest/platform-director-cron]] standing pass. This page is purely a reader; missing upstream data → "no data yet".
- The page's display config (label + polarity per metric) lives in [[../libraries/platform-scorecard-display]] — declarative, no migration to add a tile.

## Permissions

Owner-only — both the page (client `role` guard) and the API (`workspace_members.role='owner'`, 403 otherwise). Mirrors [[agents]] / [[control-tower]].

## Files touched

- `src/app/dashboard/agents/scorecard/page.tsx` — the page (client component, three cadence sections + sparklines)
- `src/app/api/developer/agents/scorecard/route.ts` — the read API
- `src/lib/agents/platform-scorecard-display.ts` — display config (label + polarity per metric) + the watch-line composer
- `src/app/dashboard/agents/page.tsx` — adds the "Scorecard →" header link from the Agents hub

## Invariants

- **Owner-only** — page + API ([[../specs/platform-scorecard-surface]] safety).
- **Reads the scorecard, never the raw tables** — every tile + the watch line + the recap row read [[../tables/platform_scorecard_snapshots]] only ([[../libraries/meta__scorecards]] invariant), so the surface can never drift from the persisted, trended truth.
- **Display-only proxy** ([[../operational-rules]] § North star) — surfacing is read + render; the KPIs are never written back as targets. Missing upstream data renders "no data yet", never a fabricated value.
- The board-watch one-liner + the EOD recap deep-link **reuse the existing watch-post + recap plumbing** — no second daily cron, no duplicate post.

## See also

- [[../specs/platform-scorecard-surface]] — this spec
- [[../specs/regression-backlog-reconciliation-scorecard]] — the two regression tiles (daily `regressions` + weekly `regression_coverage_pct`) + the dedicated board-watch line
- [[../specs/platform-scorecard-engine]] / [[../specs/platform-scorecard-weekly]] / [[../specs/platform-scorecard-monthly]] — the engines that fill the snapshot store
- [[../tables/platform_scorecard_snapshots]] · [[../libraries/platform-scorecard]] · [[../libraries/platform-scorecard-display]]
- [[../libraries/platform-director]] `postPlatformWatchUpdate` — the board-watch line consumer
- [[../libraries/director-recap]] — the EOD recap deep-link consumer
- [[agents]] — the Agents hub that links here

---

[[../README]] · [[../../CLAUDE]]
