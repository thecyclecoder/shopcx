# Scorecard page + #directors board-watch line ✅

**Priority:** critical

**Owner:** [[../functions/platform]] · **Parent:** [[../goals/platform-department-scorecard]] — (d) Surfacing
**Blocked-by:** [[platform-scorecard-engine]], [[platform-scorecard-weekly]], [[platform-scorecard-monthly]]

Milestone (d) of the [[../goals/platform-department-scorecard|Platform Department Scorecard]]: **surface it**. The metrics engine + the three cadences ([[platform-scorecard-engine]] / [[platform-scorecard-weekly]] / [[platform-scorecard-monthly]]) fill `platform_scorecard_snapshots`; this spec turns that store into the **instrument panel** — a scorecard page on the Agents hub and a one-line **board-watch** post so the CEO sees the department's health at a glance without opening it. There's no such surface today: [[../dashboard/agents]] renders the org chart, the inbox, and the per-director [[../libraries/director-xp|XP card]] only, and the [[../libraries/director-board|#directors board]] carries persona/recap posts but no trended KPI summary. **Blocked-by all three metric specs** because the page + the board line render the *complete* daily/weekly/monthly card — they consume every cadence's output, so they must ship after the data exists.

## Phase 1 — the read API
- ✅ shipped
- New `GET /api/developer/agents/scorecard` (`src/app/api/developer/agents/scorecard/route.ts`) — **owner-gated** (`workspace_members.role='owner'`, 403 otherwise — mirror every [[../dashboard/agents]] API). Reads **only** `platform_scorecard_snapshots` (never the raw tables — the "read from the scorecard" invariant from [[../libraries/meta__scorecards]]): returns the latest row per `(metric_key, cadence)` with its `value`, `prior_value`, `delta_pct`, `unit`, `detail`, grouped by cadence → `{ daily[], weekly[], monthly[] }`. Optional `?metric=&cadence=` returns that metric's snapshot history (the trend sparkline series).
- Read-only; no new table.

## Phase 2 — the scorecard page
- ✅ shipped
- New page `src/app/dashboard/agents/scorecard/page.tsx` at **`/dashboard/agents/scorecard`**, owner-gated (client `role` guard mirroring [[../dashboard/agents]]). Reachable from the Agents hub (a "Scorecard" entry alongside the org-chart / inbox toggle).
- Three sections — **Daily pulse · Weekly throughput + quality · Monthly leading curve** — each a grid of KPI tiles. Per tile: label, current `value` (formatted by `unit`), a **trend arrow** off `delta_pct` (↑/↓ + good/bad colour — e.g. ↓ on `human_touch_per_build` is *good*, ↓ on `build_success_rate` is *bad*; the per-metric polarity is config), and a small sparkline from the `?metric=` history. Tiles with no data yet (e.g. `deploy_reliability` before [[deploy-health-rollback-guardian]] ships) render a muted "no data yet", never a fake value.
- A **reserved Fleet-spend tile** (Cost / budget) — wired to light up when the [[../goals/grow-surface-platform-agent-team|grow-surface]] **cost governor** (its M4) lands its spend metric into the snapshot store. Cross-goal, **not a hard blocker** here (that spec isn't authored yet); the tile shows "no data yet" until then. Documented so the cost-governor build knows the slot exists.
- Style + structure mirror the existing [[../dashboard/storefront__ad-scorecard]] page (sortable/grouped metric tiles, min-volume/empty states).
- A brain page `dashboard/agents__scorecard.md` + a wikilink from [[../dashboard/agents]].

## Phase 3 — the #directors board-watch line
- ✅ shipped
- Extend the Platform director's daily watch post — `postPlatformWatchUpdate` ([[../libraries/platform-director]], run in the [[../inngest/platform-director-cron]] standing pass) — to append a **one-line scorecard summary** in 🛠️ Ada's voice (plain text, no markdown — the board's voice rules), e.g. *"Scorecard: 6 specs this week · 92% builds green · autonomy 0.78 ↑ · human-touch/build 0.4 ↓"*, posted to the [[../tables/director_messages]] board via [[../libraries/director-board]] `postDirectorMessage`. Pulls the numbers straight from the latest `platform_scorecard_snapshots` rows (no re-computation).
- Also emit/extend the EOD **Daily Summaries** row ([[../libraries/director-recap]] → [[../tables/dashboard_notifications]] `agent_daily_summary`) so the recap deep-links to the scorecard page. Reuses the existing recap plumbing; adds the scorecard headline + link.

## Safety / invariants
- **Owner-only** — both the page (client `role` guard) and the API (`workspace_members.role='owner'`, 403) — mirror [[../dashboard/agents]] / [[../dashboard/control-tower]].
- **Reads the scorecard, never the raw tables** — the page/API/board line all read `platform_scorecard_snapshots` (the [[../libraries/meta__scorecards]] invariant), so the surface can never drift from the persisted, trended truth.
- **Display-only proxy** ([[../operational-rules]] § North star) — surfacing is read + render; it never writes a KPI back as a target. Missing upstream data renders "no data yet", never a fabricated number.
- The board-watch line **re-uses** the existing watch-post + recap plumbing — no second daily cron, no duplicate post.

## Completion criteria
- `GET /api/developer/agents/scorecard` returns `{ daily, weekly, monthly }` from `platform_scorecard_snapshots`, owner-gated (403 for non-owners); `npx tsc --noEmit` clean.
- `/dashboard/agents/scorecard` renders the three cadence sections with trend arrows + sparklines + graceful "no data yet" tiles + the reserved Fleet-spend tile.
- The Platform director's daily board post carries the one-line scorecard summary, and the Daily Summaries recap deep-links to the page.
- A brain page exists for the new dashboard surface, wikilinked from [[../dashboard/agents]].

## Verification
- As the owner, open `/dashboard/agents/scorecard` → expect three sections (Daily pulse · Weekly · Monthly), each tile showing a value + a trend arrow; a metric with no upstream data (e.g. `deploy_reliability`) shows "no data yet", not a number.
- `GET /api/developer/agents/scorecard` as the owner → `{ daily:[…], weekly:[…], monthly:[…] }`; as a non-owner → **403**.
- After a `platform-director-cron` standing pass with Platform live+autonomous → the [[../tables/director_messages]] board has a 🛠️ Ada post whose body includes the "Scorecard: …" one-liner, and the Daily Summaries tab row deep-links to `/dashboard/agents/scorecard`.
- Change underlying data (e.g. a build merges) → next daily snapshot → the tile's value + arrow update on reload (the page reads the snapshot, so it tracks the engine).
