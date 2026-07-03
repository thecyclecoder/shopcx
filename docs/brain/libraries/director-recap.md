# libraries/director-recap

The **EOD recap standup** behind the gamified [[director-board|#directors board]] ([[../specs/directors-board-gamified]], M3 **Phase 4** of [[../goals/devops-director]]; the human-readable **detail page** is [[../specs/director-loop-grading]] **Phase 5**). The day closes with a standup: per **active** director, aggregate the day's activity from existing truth and post a conversational `recap` to the board **and** the M1 **Daily Summaries** tab; then a **CEO roll-up** — the company standup across every director. Each Daily Summaries row deep-links to a **readable day narrative** read from the activity log (`buildDirectorDayNarrative`).

**File:** `src/lib/agents/director-recap.ts` (server-only — `createAdminClient` + [[brain-roadmap]] fs reads). Run by [[../inngest/director-recap-cron]] (daily, 23:00 UTC) or on-demand.

**North-star invariant** ([[../operational-rules]] § supervisable autonomy): the recap counts are **a derived, display-only proxy, never an objective the directors optimize** — read from existing tables, narrated, never written back as a target. Mirrors the [[director-xp]] invariant.

## How it narrates — deterministic, no LLM

This **extends the [[daily-analysis-report]] `generateDailyReport` aggregate-then-narrate shape** to the director domain, but narrates **deterministically in each persona's voice** (no Anthropic call, no API key) — the standup is a count roll-up (`shipped N specs · advanced M goals · fixed K bugs · approved J migrations`), so a template keyed on the [[agent-personas]] emoji is faithful and free. Plain text, no markdown (the board's voice rules).

## Exports

- **`interface DirectorDayStats { specsShipped; goalsAdvanced; bugsFixed; migrationsApproved; approvalsHandled; actions }`** — one director's aggregated day.
- **`type DirectorRecapMap = Record<string, DirectorDayStats>`** — keyed by function slug.
- **`composeDirectorRecap(slug, stats): string`** — the persona-voiced director recap line.
- **`composeCeoRollup(total, activeDirectors): string`** — the CEO company-standup line.
- **`generateDirectorRecap(workspaceId, date): Promise<{ ok; reason?; date?; directorsPosted?; ceoPosted? }>`** — aggregate → post. Returns `{ ok:false, reason:'no_activity' }` for a quiet workspace (no empty-standup spam). The Daily Summaries row it inserts now carries a `link` to the Phase-5 day-narrative detail page (`/dashboard/agents/recap/{date}?function={slug}`; the CEO roll-up links to the cross-director `/dashboard/agents/recap/{date}`).
- **`buildDirectorDayNarrative({ workspaceId, date, functionSlug? }): Promise<DayNarrative>`** (director-loop-grading Phase 5) — the **human-readable detail page** behind a Daily Summaries row. A pure read over that day's [[../tables/director_activity]] rows, grouping each row's action + `spec_slug` + plain-text `reason` ("the why") into ordered categories (`Goals advanced｜Fixes & repairs｜Approvals｜Platform watch｜Board grooming｜Worker coaching｜Escalations｜Activity`). With `functionSlug` → one director's day; without → every active director (the CEO roll-up). Read-only + recomputed each view, so it can never drift from the log it narrates. Returns `{ date, scope: 'director'|'company', directors: DirectorDayNarrative[], empty }`.
- **`interface DayNarrativeItem` / `DayNarrativeGroup` / `DirectorDayNarrative` / `DayNarrative`** — the narrative render contract (consumed by the detail page).

## How each count is derived (for `date`, UTC `[00:00, 24:00)`)

| Count | Source | Rule |
|---|---|---|
| `specsShipped` | [[../tables/agent_jobs]] | `kind='build'` + `status='merged'` with `updated_at` in-day (the merge flip), `spec_slug` mapped to the function via [[director-kpis]] `shippedSpecsByOwner` — which builds the map from the FULL [[specs-table]] `listSpecs` set (folded INCLUDED). Fixes the [[../specs/director-kpi-sdk]] Phase 1 bug where a same-day-folded spec's merge dropped off the count. |
| `bugsFixed` | [[../tables/approval_decisions]] × [[../tables/agent_jobs]] | `decision='approved'` in-day whose raising job is `kind ∈ {repair, regression}`, by `raised_by_function`. |
| `migrationsApproved` | [[../tables/approval_decisions]] × [[../tables/agent_jobs]] | `decision='approved'` in-day whose raising job is `kind='migration-fix'`, by `raised_by_function`. |
| `approvalsHandled` | [[../tables/approval_decisions]] | every `decision='approved'` in-day by `raised_by_function` (bugs + migrations + other; drives the active signal + a "cleared N approvals" tail). |
| `goalsAdvanced` | [[../tables/director_activity]] | in-day rows with `action_kind ∈ {escorted_goal, advanced_milestone, shipped_milestone}` (milestones advanced = M4's job — usually 0 pre-M4). |
| `actions` | [[../tables/director_activity]] | total in-day rows for the function — the active signal even with no headline count. |

## What it posts

For each **active** director (any count > 0) → a [[director_messages]] `recap` post (`author='director'`, `author_function=slug`, `metadata { recap_date, source:'eod-recap', stats }`) via [[director-board]] `postDirectorMessage`, **and** a [[../tables/dashboard_notifications]] `agent_daily_summary` row (`DAILY_SUMMARY_TYPE`, declared in `src/lib/agents/inbox.ts`) → the M1 **Daily Summaries** tab ([[../dashboard/agents]]). Then a CEO roll-up (`author='ceo'`, `metadata.scope='ceo-rollup'`) the same two ways.

**Idempotent per `(workspace, date, author)`** — it reads back today's `kind='recap'` posts (`metadata->>recap_date = date`) and skips any author already posted, so a cron retry never double-posts.

## The human-readable detail page (director-loop-grading Phase 5)

The one-line standup is the **headline**; the Daily Summaries row deep-links to the **drill-down** — a readable narrative of the director's day. `buildDirectorDayNarrative` reads that day's [[../tables/director_activity]] rows and groups each one's action + spec + `reason` into ordered categories, so the CEO can read *what it fixed + why, which goal it moved + how far, what it escalated* — not just the counts.

- **Surface:** `GET /api/developer/agents/recap?date=YYYY-MM-DD&function={slug}` (`src/app/api/developer/agents/recap/route.ts`, owner-gated, read-only) → the narrative. Rendered at `/dashboard/agents/recap/[date]/page.tsx` (`?function=` → one director; omitted → the company roll-up across every active director).
- The narrative is **a query over the activity log, never hand-maintained** ([[../operational-rules]] § North star) — recomputed on each view, so it can't drift from the log. No new table, no LLM.

## Callers

- [[../inngest/director-recap-cron]] — the daily 23:00-UTC cron.

## Related

[[../specs/directors-board-gamified]] · [[../specs/director-loop-grading]] · [[../specs/director-kpi-sdk]] · [[director-kpis]] · [[director-board]] · [[director-xp]] · [[director-activity]] · [[daily-analysis-report]] · [[agent-personas]] · [[../dashboard/agents]] · [[../tables/director_messages]] · [[../tables/director_activity]] · [[../tables/approval_decisions]] · [[../tables/dashboard_notifications]] · [[../goals/devops-director]] · [[../operational-rules]]

---

[[../README]] · [[../../CLAUDE]]
