# Dashboard · ai-analysis

Daily AI quality analysis dashboard. Low-score tickets, gap patterns, research-and-heal status. Paused 2026-04-28; surface remains for review.

**Route:** `/dashboard/ai-analysis`

## Features

**Page title:** AI Analysis

**Visible buttons (heuristic — actual labels in source):**
- Accept manually
- Reject manually
- Revert to proposed

**Rendering:** `"use client"` component (client-side state + fetch).

**Day boundary = US Central, not the server's UTC clock** (fix/ai-analysis-central-day). All three views (`today`, `?date=`, `daily`) anchor "which calendar day is it" to `America/Chicago` (`WORKSPACE_TZ`) via [[../libraries/central-day]], not the Vercel box's UTC clock. The old `new Date(); setHours(0,0,0,0)` computed UTC-midnight, so at ~7 PM+ Central it rolled "today" to TOMORROW (the dashboard read 7/11 on the evening of 7/10) and scooped a full extra UTC-evening slice; the `?date=` + `daily` buckets used a naive `iso.slice(0,10)` (UTC day) that pushed evening-Central tickets into the next day. Now: `today` selects `gte centralTodayStartUtcIso()`, `?date=` bounds by `centralDayWindowUtc` + buckets by `centralDateStr`, `daily` buckets by `centralDateStr` (DST-safe).

**Today card — two volume denominators + a cheap-vs-Sol split** (`?view=today` on [[../../../src/app/api/workspaces/[id]/ticket-analyses/route]], cora-grades-every-ai-handled-ticket-not-just-sol):
- **`graded_handled`** — the card's numerator: how many of today's HANDLED tickets carry a grade (a `ticket_analyses` row, from any time — a grade lands ~30 min after the last customer message). The card reads "**`graded_handled` of `handled_tickets` handled tickets graded**". This replaced the old numerator `analyzed` (= grade rows CREATED today over ANY ticket), a different population that produced nonsense like "21 of 16". `analyzed` is still returned (today's grading activity, feeds the avg-score line) but is no longer the numerator.
- **`new_tickets`** — inbound tickets CREATED today (the day's fresh volume).
- **`handled_tickets`** — tickets whose LAST CUSTOMER MESSAGE is today; can exceed `new_tickets` because a slow-responder returns to an older ticket. This is the denominator the score sits under — the card reads "**N of `handled_tickets` handled tickets graded**".
- Both **exclude merged-away duplicates** (`merged_into IS NOT NULL` — the survivor carries the conversation) and **outbound-only sends** (a ticket with no customer message, e.g. a dunning email).
- **`handled_cheap` / `handled_sol`** — of the handled set, how many the low-cost Sonnet/Haiku path carried (`sol_handled_at` null, `ai_handled_at` set) vs needed a Sol session (`sol_handled_at` set). The card shows "(X cheap · Y Sol)".
- The card now renders whenever there is handled volume, even before any grade lands (previously required `analyzed > 0`).

## Sub-routes

- `[id]/` → [[ai-analysis/[id]]]

## API endpoints called

- `/api/sonnet-prompts/:x/override`
- `/api/workspaces/:x/sonnet-prompt-decisions`
- `/api/workspaces/:x/ticket-analyses`

## Permissions

All workspace members. No role gate in the page itself; gated only by middleware auth + workspace membership.

## Files touched

- `src/app/dashboard/ai-analysis/page.tsx` — the page itself
- `src/app/dashboard/ai-analysis/[id]/page.tsx` — sub-route

---

[[../README]] · [[../../CLAUDE]]
