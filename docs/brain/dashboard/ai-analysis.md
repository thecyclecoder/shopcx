# Dashboard · ai-analysis

Real-time grading of every closed AI ticket + nightly auto-review of proposed [[../tables/sonnet_prompts]] rules. Three tabs.

**Route:** `/dashboard/ai-analysis`

## Features

**Page title:** AI Analysis

**Tabs:**

| Tab | Purpose |
|---|---|
| Daily | Live "Today" card + last-14-days roll-up grid (click into `/dashboard/ai-analysis/{date}` for the day's per-ticket detail). Each rollup shows avg score, ticket count, action-item count, top issue types. |
| Auto-decisions | Last 50 `sonnet_prompt_decisions` rows. Color-coded badge (green accept / red reject / blue merge+supersede / amber human_review / zinc revise), confidence bar, model reasoning paragraph, references with hover-why, source badge (`cron` / `manual_override` / `safety_test`). |
| Pending review | Proposals where the AI returned `human_review`, sorted by confidence ascending — least-confident first. Includes the safety reason (`[SAFETY] confidence_floor (0.62 < 0.75)` or `[SAFETY] daily_cap (10/10)`). |

**Override buttons** (on every Auto-decision card AND every Pending-review card):

- **Accept manually** — flips `status='approved'`, `enabled=true`. Writes a new [[../tables/sonnet_prompt_decisions]] row with `source='manual_override'`, `performed_by=user.id`, `confidence=1.0`.
- **Reject manually** — flips `status='rejected'`, `enabled=false`.
- **Revert to proposed** — clears `auto_decision`, `status='proposed'`. Lets the next cron run try again.

**Rendering:** `"use client"` component with three-tab state machine.

## Sub-routes

- `[date]/` → per-day detail page (`/dashboard/ai-analysis/2026-06-02`)

## API endpoints called

- `GET /api/workspaces/{id}/ticket-analyses?view=today` — live today card
- `GET /api/workspaces/{id}/ticket-analyses?view=daily` — 14-day rollup
- `GET /api/workspaces/{id}/sonnet-prompt-decisions?view=recent` — last 50 decisions
- `GET /api/workspaces/{id}/sonnet-prompt-decisions?view=pending` — human-review queue
- `POST /api/sonnet-prompts/{id}/override` — admin-only manual override (action: accept / reject / revert)

## Permissions

All workspace members can view. The `POST /api/sonnet-prompts/{id}/override` endpoint is **admin/owner only** — non-admin clicks return 403.

## Files touched

- `src/app/dashboard/ai-analysis/page.tsx` — tabbed page
- `src/app/dashboard/ai-analysis/[date]/page.tsx` — per-day detail
- `src/app/api/workspaces/[id]/sonnet-prompt-decisions/route.ts` — decision feed
- `src/app/api/sonnet-prompts/[id]/override/route.ts` — override endpoint
- `src/app/api/workspaces/[id]/ticket-analyses/route.ts` — existing analysis feed

## Related

[[../tables/ticket_analyses]] · [[../tables/daily_analysis_reports]] · [[../tables/sonnet_prompts]] · [[../tables/sonnet_prompt_decisions]] · [[../tables/ai_token_usage]] · [[../tables/knowledge_gaps]] · [[../inngest/ticket-analysis-cron]] · [[../inngest/daily-analysis-report-cron]] · [[../inngest/sonnet-prompt-auto-review]] · [[../lifecycles/ai-learning]] · [[../lifecycles/research-and-heal]]

---

[[../README]] · [[../../CLAUDE]]
