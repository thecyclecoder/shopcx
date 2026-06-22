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

**Escalation indicator:** a row escalated to a **human** (`escalated_to` set) shows the amber escalate icon. A row escalated to the **routine** (`escalated_at` set + `escalated_to IS NULL`) shows the prominent **"🔍 Escalated → AI Investigation"** badge (amber/escalation styling) instead — the visible label for the routine-owned state, superseding the plainer "AI Routine" wording. The `escalated=true` API filter keys on `escalated_at` so routine-escalated tickets surface. See [[../specs/escalate-to-routine-by-default]] · [[../specs/ai-investigation-ticket-visibility]].

**"🔍 Escalated → AI Investigation" badge** (`escalated_at` set + `escalated_to IS NULL`): a shared `AiInvestigationBadge` (`src/components/ai-investigation-badge.tsx`) shown on the ticket **header** (`[id]/page.tsx`), the **list** (compact, `page.tsx`), and the **Escalated** view ("Routed to" column for `routed_to==='routine'`). Appends **"· triage in progress"** when a `triage-escalations` job is in-flight for the workspace — `GET /api/tickets/triage-status` (`{ in_progress }` = an `agent_jobs` `kind='triage-escalations'` row in an active status) via `useTriageInProgress()` (`src/lib/use-triage-in-progress.ts`). The badge informs, it doesn't lock: escalating to a person sets `escalated_to` → the badge flips to that human automatically. The triage routine itself leaves an internal `[AI Investigation]` paper trail on the thread (start + outcome) — see [[../specs/box-escalation-triage]]. Added by [[../specs/ai-investigation-ticket-visibility]].

## Sub-routes

- `[id]/` → [[tickets/[id]]]

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
- `src/app/api/tickets/route.ts` — list + create
- `src/app/api/tickets/bulk/route.ts` — bulk operations
- `src/app/api/tickets/merge/route.ts` — merge duplicates
- `src/components/ai-investigation-badge.tsx` — the shared "🔍 Escalated → AI Investigation" badge
- `src/lib/use-triage-in-progress.ts` — hook for the "· triage in progress" suffix
- `src/app/api/tickets/triage-status/route.ts` — is a triage sweep in-flight for the workspace?

## Related

[[../tables/tickets]] · [[../tables/ticket_messages]] · [[../tables/ticket_views]] · [[../lifecycles/ticket-lifecycle]] · [[../lifecycles/ai-multi-turn]] · [[../recipes/escalate-ticket]] · [[../recipes/send-email-reply]] · [[../recipes/send-chat-reply]] · [[settings/views]] · [[settings/rules]]

---

[[../README]] · [[../../CLAUDE]]
