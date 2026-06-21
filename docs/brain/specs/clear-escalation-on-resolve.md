# Clear Escalation Flags on Resolve/Close ⏳

**Owner:** [[../functions/cs]] · **Parent:** escalation-lifecycle hygiene, completes [[box-escalation-triage]] + [[escalate-to-routine-by-default]]. Found 2026-06-21: a **closed** ticket (`5965ee60` "Wrong product delivered", Sheryl Dickey, resolved 2026-06-05) still showed on the Escalated list because `escalated_at` was never cleared on close — it lingered ~16 days post-resolution.

**The bug.** Escalation is set (`escalated_at`, `escalated_to`, `escalation_reason`) but **never cleared when the ticket is resolved/closed**. So the Escalated view + any `escalated_at IS NOT NULL` consumer show resolved tickets as still-escalated. (The triage cron itself dodges this — it filters out `closed`/`archived` — but the human-facing list doesn't, and it's just wrong state.)

## Fix
1. **On resolve/close, clear the escalation flags.** Wherever a ticket transitions to `closed`/`resolved`/`archived` (the status-write paths — `maybeAutoCloseGroup`, the manual close action, workflow/journey closes, the triage auto-close), also set `escalated_at = null`, `escalated_to = null`, `escalation_reason = null` in the same update. An escalation is, by definition, an *open* state; resolving it ends it. (Reopening a ticket does **not** auto-re-escalate — escalation is a fresh decision.)
2. **Belt-and-suspenders on the read side.** The Escalated dashboard view (`/dashboard/tickets/escalated`) should only list tickets whose status is **not** `closed`/`resolved`/`archived` (so even a stray stale flag can't surface a resolved ticket).
3. **One-time stale cleanup (gated).** A small script clears `escalated_at`/`escalated_to`/`escalation_reason` on any existing `closed`/`resolved`/`archived` ticket that still carries them. (As of 2026-06-21 the count is **0** — `5965ee60` was already cleared by hand — so this is a safety net / no-op, but ship it idempotent for future-proofing + run `--apply` gated.)

## Verification
- Escalate a ticket (to the routine or a human) → it shows on the Escalated list; **resolve/close it** → `escalated_at`/`escalated_to`/`escalation_reason` are now `null` and it **drops off** the Escalated list immediately.
- The triage auto-close path (`maybeAutoCloseGroup`) clears the flags when it closes + unescalates.
- The Escalated view never renders a `closed`/`resolved`/`archived` ticket even if a flag is stale.
- Reopening a resolved ticket does not silently re-escalate it (flags stay null until a new escalation decision).

## Phase 1 — clear-on-close + view filter + stale sweep ⏳
Clear escalation flags in the resolve/close status-write paths; filter the Escalated view to non-terminal statuses; the idempotent gated stale-sweep script. Brain: [[box-escalation-triage]] · [[../libraries/ticket-analyzer]] / the close paths · [[../dashboard/tickets]] (Escalated view). Fold on ship.
