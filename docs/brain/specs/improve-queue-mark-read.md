# Improve Queue — Mark-as-Read / Dismiss ⏳

**Owner:** [[../functions/platform]] · **Parent:** extends [[improve-queue]] (shipped #127) — the v1 surfaced answered Improve turns but had no way to clear them, so the queue + nav badge **persist forever**. This adds the dismiss the founder asked for: "once I've read it, it's done (sometimes there are actions, sometimes no)."

A read/seen state on each Improve session so an answered turn drops off the **"Waiting on you"** list (and decrements the nav badge) once the founder/CX manager has seen it — regardless of whether it had actions. A **later** box reply re-surfaces it, so the badge always means "genuinely new replies you haven't looked at."

## Mechanism
- **Migration:** add `seen_at timestamptz?` to [[../tables/ticket_improve_chats]] (per-session read marker; null = never read).
- **Unread = the box answered since you last looked:** a session is "Waiting on you" when `turn_status ∈ {idle, awaiting_approval, error}` (the box has responded / wants you) **AND (`seen_at IS NULL` OR `updated_at > seen_at`)**. `updated_at` already bumps on every box turn, so a new reply (or a freshly-parked plan) makes `updated_at > seen_at` again → it **re-surfaces**.
- **Mark read** sets `seen_at = updated_at` (clears it from the queue + badge until the next box turn).
- **Two ways to mark read** (both just set `seen_at`):
  1. **Explicit** — a "Mark read" / "Done" button on each queue row (for ones you don't need to open — e.g. an FYI reply with no action).
  2. **Auto on open** — opening that ticket's Improve tab marks the session read (you've seen it). So clicking through from the queue clears it without a second tap.
- **New API:** `POST /api/tickets/improve-queue/seen { ticket_id }` (owner/admin/cs) → sets `seen_at`. The Improve tab page calls it on mount; the queue row's button calls it directly.
- **`awaiting_approval` nuance:** marking read clears it from the *unread* queue, but a still-parked `pending_plan` is separately actionable — keep a small persistent "needs approval" indicator (or a separate filter) so a dismissed-but-unapproved plan isn't lost. (Reading ≠ approving.) Default: the badge counts unread; a parked plan shows a distinct chip even when read.

## UX
- Queue rows get a **Mark read** affordance; reading via click-through auto-clears. The nav badge = count of unread "Waiting on you" sessions. A session you've read stays visible (greyed / "read") under a collapsible **"Earlier"** group until its next box turn, rather than vanishing entirely — so nothing's truly lost.

## Verification
- Box answers a turn → session shows unread in "Waiting on you", badge +1. Click it (or hit "Mark read") → it leaves the unread list, badge −1. Send another turn / get another box reply → it re-surfaces as unread (badge +1). Mark a no-action reply read → gone from unread. A read session that still has a parked plan keeps its "needs approval" chip.

## Phases
- ⏳ **P1:** the `seen_at` migration + unread filter + `…/seen` API + the Mark-read button + auto-mark-on-open + badge counts unread. Fold into [[improve-queue]] + [[../tables/ticket_improve_chats]] on ship.
