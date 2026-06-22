# Clear Escalation Flags on Resolve/Close ✅

**Owner:** [[../functions/cs]] · **Parent:** escalation-lifecycle hygiene, completes [[box-escalation-triage]] + [[escalate-to-routine-by-default]]. Found 2026-06-21: a **closed** ticket (`5965ee60` "Wrong product delivered", Sheryl Dickey, resolved 2026-06-05) still showed on the Escalated list because `escalated_at` was never cleared on close — it lingered ~16 days post-resolution.

**The bug.** Escalation is set (`escalated_at`, `escalated_to`, `escalation_reason`) but **never cleared when the ticket is resolved/closed**. So the Escalated view + any `escalated_at IS NOT NULL` consumer show resolved tickets as still-escalated. (The triage cron itself dodges this — it filters out `closed`/`archived` — but the human-facing list doesn't, and it's just wrong state.)

## Fix
1. **On resolve/close, clear the escalation flags.** Wherever a ticket transitions to `closed`/`resolved`/`archived` (the status-write paths — `maybeAutoCloseGroup`, the manual close action, workflow/journey closes, the triage auto-close), also set `escalated_at = null`, `escalated_to = null`, `escalation_reason = null` in the same update. An escalation is, by definition, an *open* state; resolving it ends it. (Reopening a ticket does **not** auto-re-escalate — escalation is a fresh decision.)
2. **Belt-and-suspenders on the read side.** The Escalated dashboard view (`/dashboard/tickets/escalated`) should only list tickets whose status is **not** `closed`/`resolved`/`archived` (so even a stray stale flag can't surface a resolved ticket).
3. **One-time stale cleanup (gated).** A small script clears `escalated_at`/`escalated_to`/`escalation_reason` on any existing `closed`/`resolved`/`archived` ticket that still carries them. (As of 2026-06-21 the count is **0** — `5965ee60` was already cleared by hand — so this is a safety net / no-op, but ship it idempotent for future-proofing + run `--apply` gated.)

## Verification
- On `/dashboard/tickets/escalated`, escalate a ticket (set `escalated_to` via the ticket detail, or force `escalated_at=now()`) → it appears in the list. Then close it (ticket detail "Close", or `PATCH /api/tickets/{id}` with `{status:"closed"}`) → re-query the ticket row → expect `escalated_at`, `escalated_to`, `escalation_reason` all `null`, and the ticket **gone** from the Escalated list on refresh.
- On the bulk action bar, select an escalated ticket and bulk-**Close** (`POST /api/tickets/bulk` `action:"close"`) → expect its three escalation columns `null`.
- DB check: `select count(*) from tickets where status in ('closed','resolved','archived') and (escalated_at is not null or escalated_to is not null or escalation_reason is not null)` → expect **0** (no terminal-status ticket carries escalation flags).
- Belt-and-suspenders: manually set `escalated_at=now()` on an already-`closed` ticket → `GET /api/escalated` → expect that ticket is **not** returned (the `status NOT IN (closed,resolved,archived)` filter drops it).
- Reopen a resolved ticket (`PATCH /api/tickets/{id}` `{status:"open"}`) → expect escalation columns stay `null` (reopening does not auto-re-escalate).
- Stale sweep: `npx tsx scripts/sweep-stale-escalation-on-closed.ts` → expect a dry-run report of 0 affected rows (or lists any stragglers); `--apply` clears them and is idempotent on re-run.

## Phase 1 — clear-on-close + view filter + stale sweep ✅
Clear escalation flags in the resolve/close status-write paths; filter the Escalated view to non-terminal statuses; the idempotent gated stale-sweep script. Brain: [[box-escalation-triage]] · [[../libraries/ticket-analyzer]] / the close paths · [[../dashboard/tickets]] (Escalated view). Fold on ship.

**Shipped.** Escalation flags (`escalated_at`/`escalated_to`/`escalation_reason`) are now cleared in every terminal-status write path:
- `maybeAutoCloseGroup` + `executeTicketClose` (`src/lib/agent-todos/execute.ts`) — already cleared; left as-is.
- Manual close/archive (`src/app/api/tickets/[id]/route.ts` PATCH) — was archived-only; now clears on `closed`/`resolved`/`archived`.
- Bulk `close` + `set_status=closed` (`src/app/api/tickets/bulk/route.ts`).
- Workflow `sendReply` close (`src/lib/workflow-executor.ts`).
- Manual send-journey / run-workflow closes (`src/app/api/tickets/[id]/send-journey/route.ts`, `.../run-workflow/route.ts`).
- Journey-outcome closes — all 5 close paths (`src/lib/inngest/journey-outcomes.ts`).
- Portal remediation + cancel-journey closes (`src/lib/portal/remediation.ts`, `src/lib/portal/handlers/cancel-journey.ts`).
- Unified-handler `setStatus` + spam-bot + fraud closes (`src/lib/inngest/unified-ticket-handler.ts`).
- `improve-plan-executor.ts` already clears conditionally; `auto-archive.ts` only archives rows where `escalated_at IS NULL`, so no change needed.

Read-side filter: `GET /api/escalated` now excludes `status IN (closed,resolved,archived)`. One-time gated stale sweep: `scripts/sweep-stale-escalation-on-closed.ts` (dry-run default, `--apply` gated; idempotent — clears flags on any terminal-status ticket still carrying them, currently 0).
