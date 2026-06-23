# libraries/director-recap

The **EOD recap standup** behind the gamified [[director-board|#directors board]] ([[../specs/directors-board-gamified]], M3 **Phase 4** of [[../goals/devops-director]]). The day closes with a standup: per **active** director, aggregate the day's activity from existing truth and post a conversational `recap` to the board **and** the M1 **Daily Summaries** tab; then a **CEO roll-up** — the company standup across every director.

**File:** `src/lib/agents/director-recap.ts` (server-only — `createAdminClient` + [[brain-roadmap]] fs reads). Run by [[../inngest/director-recap-cron]] (daily, 23:00 UTC) or on-demand.

**North-star invariant** ([[../operational-rules]] § supervisable autonomy): the recap counts are **a derived, display-only proxy, never an objective the directors optimize** — read from existing tables, narrated, never written back as a target. Mirrors the [[director-xp]] invariant.

## How it narrates — deterministic, no LLM

This **extends the [[daily-analysis-report]] `generateDailyReport` aggregate-then-narrate shape** to the director domain, but narrates **deterministically in each persona's voice** (no Anthropic call, no API key) — the standup is a count roll-up (`shipped N specs · advanced M goals · fixed K bugs · approved J migrations`), so a template keyed on the [[agent-personas]] emoji is faithful and free. Plain text, no markdown (the board's voice rules).

## Exports

- **`interface DirectorDayStats { specsShipped; goalsAdvanced; bugsFixed; migrationsApproved; approvalsHandled; actions }`** — one director's aggregated day.
- **`type DirectorRecapMap = Record<string, DirectorDayStats>`** — keyed by function slug.
- **`composeDirectorRecap(slug, stats): string`** — the persona-voiced director recap line.
- **`composeCeoRollup(total, activeDirectors): string`** — the CEO company-standup line.
- **`generateDirectorRecap(workspaceId, date): Promise<{ ok; reason?; date?; directorsPosted?; ceoPosted? }>`** — aggregate → post. Returns `{ ok:false, reason:'no_activity' }` for a quiet workspace (no empty-standup spam).

## How each count is derived (for `date`, UTC `[00:00, 24:00)`)

| Count | Source | Rule |
|---|---|---|
| `specsShipped` | [[../tables/agent_jobs]] | `kind='build'` + `status='merged'` with `updated_at` in-day (the merge flip), `spec_slug` mapped to the function in the live spec→owner map ([[brain-roadmap]] `getRoadmap().specs[].owner`). |
| `bugsFixed` | [[../tables/approval_decisions]] × [[../tables/agent_jobs]] | `decision='approved'` in-day whose raising job is `kind ∈ {repair, regression}`, by `raised_by_function`. |
| `migrationsApproved` | [[../tables/approval_decisions]] × [[../tables/agent_jobs]] | `decision='approved'` in-day whose raising job is `kind='migration-fix'`, by `raised_by_function`. |
| `approvalsHandled` | [[../tables/approval_decisions]] | every `decision='approved'` in-day by `raised_by_function` (bugs + migrations + other; drives the active signal + a "cleared N approvals" tail). |
| `goalsAdvanced` | [[../tables/director_activity]] | in-day rows with `action_kind ∈ {escorted_goal, advanced_milestone, shipped_milestone}` (milestones advanced = M4's job — usually 0 pre-M4). |
| `actions` | [[../tables/director_activity]] | total in-day rows for the function — the active signal even with no headline count. |

## What it posts

For each **active** director (any count > 0) → a [[director_messages]] `recap` post (`author='director'`, `author_function=slug`, `metadata { recap_date, source:'eod-recap', stats }`) via [[director-board]] `postDirectorMessage`, **and** a [[../tables/dashboard_notifications]] `agent_daily_summary` row (`DAILY_SUMMARY_TYPE`, declared in `src/lib/agents/inbox.ts`) → the M1 **Daily Summaries** tab ([[../dashboard/agents]]). Then a CEO roll-up (`author='ceo'`, `metadata.scope='ceo-rollup'`) the same two ways.

**Idempotent per `(workspace, date, author)`** — it reads back today's `kind='recap'` posts (`metadata->>recap_date = date`) and skips any author already posted, so a cron retry never double-posts.

## Callers

- [[../inngest/director-recap-cron]] — the daily 23:00-UTC cron.

## Related

[[../specs/directors-board-gamified]] · [[director-board]] · [[director-xp]] · [[director-activity]] · [[daily-analysis-report]] · [[agent-personas]] · [[../tables/director_messages]] · [[../tables/director_activity]] · [[../tables/approval_decisions]] · [[../tables/dashboard_notifications]] · [[../goals/devops-director]] · [[../operational-rules]]

---

[[../README]] · [[../../CLAUDE]]
