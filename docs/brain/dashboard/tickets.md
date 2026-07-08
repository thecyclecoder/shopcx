# Dashboard · tickets

Master ticket queue. Filters by status, channel, assignee, tags, snooze, escalation. Paginated 25/page. Bulk actions: assign / archive / merge / status change.

**Route:** `/dashboard/tickets`

## Features

**Page title:** Tickets

**Filters:**
- status: all, open, pending, closed, archived
- channel: all, email, chat, portal, social_comments, meta_dm, sms

**Visible buttons (heuristic — actual labels in source):**
- New Ticket
- Cancel
- Delete
- Snoozed
- Save
- Save as View
- Close
- Merge
- Clear
- Previous

**Rendering:** `"use client"` component (client-side state + fetch).

## Sub-routes

- `[id]/` → [[tickets/[id]]]
- `escalated/` → [[tickets/escalated]]
- `improve/` → [[tickets/improve]]
- `todos/` → [[tickets/todos]]
- `analytics/` → [[tickets__analytics]] — Selective-clarify rate + Playbook selection split + Sol economics tiles.
  - **Selective-clarify rate** — see [[../specs/confidence-gated-problem-lockin-and-selective-clarify]] Phase 2.
  - **Playbook selection (session-chosen vs signal-matched, 7d)** — Phase 4 of [[../specs/sol-session-chosen-playbook-selection-retire-brittle-triggers]]. Reads `GET /api/tickets/analytics/playbook-selection-split`, which aggregates `ticket_resolution_events.reasoning` matching `'sol:session-chose-playbook:%'` vs `'sol:matcher-chose-playbook:%'` over the last 7 days. Renders total_session_chosen + total_matcher_chosen headline counts and a top-5-slug split, so an operator can watch Sol's session-based selection displace the deterministic matcher as `ai_channel_config.sol_playbook_selection_active` flips true per channel. No new table — the ledger reasoning field is the source.
  - **Sol economics tile** carries a small "**Sol cap-hits (7d)**" subline below the re-session histogram — a fixed 7-day rolling count of `ticket_resolution_events WHERE reasoning='sol:cap-hit'` sourced from `GET /api/tickets/analytics/sol-cost`'s `cap_hits.total_7d` field, broken down by inflection kind (`frustration` / `drift`). See [[../specs/sol-runaway-re-session-cap-guardrail]] § Phase 3 — the same read backs the [[../libraries/cs-director-digest]] cap-hit `early_warning` storyline that fires when the count exceeds `ai_channel_config.sol_cap_hit_alarm` (default `5`).

## API endpoints called

- `/api/tickets`
- `/api/tickets/bulk`
- `/api/tickets/merge`
- `/api/workspaces/:x/members`
- `/api/workspaces/:x/tags`
- `/api/workspaces/:x/ticket-views`

## Permissions

Role-aware UI — the page reads `workspace.role` to show / hide controls.

## Files touched

- `src/app/dashboard/tickets/page.tsx` — the page itself
- `src/app/dashboard/tickets/[id]/page.tsx` — sub-route
- `src/app/dashboard/tickets/escalated/page.tsx` — sub-route
- `src/app/dashboard/tickets/improve/page.tsx` — sub-route
- `src/app/dashboard/tickets/todos/page.tsx` — sub-route

---

[[../README]] · [[../../CLAUDE]]
