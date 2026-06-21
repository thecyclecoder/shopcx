# Suppress CSAT surveys on tickets we never actually replied to ✅

**Owner:** [[../functions/cs]] · **Parent:** CS mandate "Ticket-derived product fixes" · **Derived-from-ticket:** `f5d1be18-aee2-43c0-8d6b-258e0fa4453a`

The CSAT cron (`src/lib/inngest/ticket-csat.ts`, `ticket-csat-cron`) sends a survey to every ticket that is `status='closed'` + has a `customer_id` + closed 48h-7d ago + `csat_sent_at IS NULL`. It never checks whether we actually engaged the customer. Result: out-of-office / auto-reply / spam tickets the AI correctly ignored still get "how did we do?" emails, and the auto-responder's mailbox owner rates 1 — polluting the CSAT average with noise.

## Problem (from ticket `f5d1be18-aee2-43c0-8d6b-258e0fa4453a`)
An OOF auto-reply to our "First 100 Get 55% Off" marketing blast created a ticket (subject "Automatic reply: …"), tagged `outreach`/`cls:outreach`, `ai_turn_count=0`, with **zero customer-facing outbound messages** (all outbound rows were `system/internal`). The AI did nothing — correct. But the cron surveyed it anyway and got a 1-star (CSAT row `954fb4f9-…`, since deleted). The ticket-analyzer already skips grading these tickets (`do_not_reply` + `SKIP_TAGS`), but the CSAT cron has no equivalent guard. Note `ai_turn_count` is NOT a usable signal — it was 0 on the legit angry-customer tickets too.

## Fix
Add an eligibility guard to the cron's per-ticket send step, and stamp `csat_sent_at` on skip so the ticket leaves the scan window (mirrors the existing too-old skip path). Skip the survey when ANY of:
1. **No customer-facing outbound message ever sent** — the principled, universal signal: `ticket_messages` has no row with `direction='outbound' AND visibility != 'internal'`. If we never sent the customer anything, there is nothing to rate. This alone catches the OOF case and every "did nothing" variant.
2. `tickets.do_not_reply = true` — the AI intentionally didn't reply (wrong company / spam); the same flag the analyzer skips on.
3. Tags overlap the skip set `{ outreach, cls:outreach, spam:bot }` — cheap early filter.

Signal #1 is load-bearing; #2/#3 are cheap pre-filters. Reuse `SKIP_TAGS` (currently a private const in `src/lib/ticket-analyzer.ts`) by extracting it to a shared module (e.g. `src/lib/ticket-tags.ts`) so both consumers share one source of truth. Implement in the `find-due` loop (batch is 50, so a per-ticket `ticket_messages` existence query is fine) or fold a `NOT EXISTS` into the query.

## Phases
- ✅ **P1 — eligibility guard** — `src/lib/inngest/ticket-csat.ts`: before the send in the `find-due` loop, compute eligibility; on ineligible, set `csat_sent_at = now()` and skip the email. `SKIP_TAGS` extracted to the shared `src/lib/ticket-tags.ts` module, imported here and in `ticket-analyzer.ts`. Per-ticket `send-{id}` step now returns its outcome (`sent`/`skipped_no_reply`/`no_email`) instead of mutating an outer counter (replay-safe); fn returns counts (`sent`, `skipped_too_old`, `skipped_no_reply`, `batch_size`). `npx tsc --noEmit` clean.
- ✅ **P2 — brain refresh** — `docs/brain/inngest/ticket-csat.md` rewritten to match the code (cron `*/15`, stamps `csat_sent_at`, no score, both passes + eligibility guard). Gotcha added to `docs/brain/tables/ticket_csat.md` and a new "§3a Only survey tickets we actually answered" + flow box updated in `docs/brain/lifecycles/csat.md`.
- ✅ **P3 (optional) — backfill in-window noise** — `scripts/audit-csat-inwindow-noise.ts` authored: mirrors the cron's eligibility logic over the current 48h-7d in-window set, prints ineligible tickets (dry-run default), stamps `csat_sent_at` on `--apply`. The `--apply` run is a gated prod mutation (owner runs it).

## Verification
- On the build box, `npx tsx scripts/audit-csat-inwindow-noise.ts` (dry run) → expect it to print the in-window scan count and the ineligible tickets with reason tags (`no_customer_outbound` / `do_not_reply` / `skip_tag`); an `f5d1be18-…`-shaped ticket (closed auto-reply, 0 customer-facing outbound) appears in the ineligible list. No DB writes happen.
- Run that script with `--apply` (gated prod mutation) → expect the listed tickets to get `csat_sent_at = now()` stamped; re-running the dry run after shows 0 ineligible left in the window.
- After the next cron tick (`ticket-csat-cron`, `*/15`), check its run output → `skipped_no_reply` > 0 when noise tickets were in window; a normal resolved ticket with ≥1 `outbound` / non-`internal` message (e.g. `75cfe7c0-…`, `f21db601-…`) is still in `sent`.
- In Supabase, pick a `do_not_reply=true` ticket and one tagged `outreach`/`spam:bot` that closed 48h-7d ago with `csat_sent_at IS NULL` → after a cron tick both have `csat_sent_at` stamped and no CSAT email was sent (no Resend log).
- `grep -rn "SKIP_TAGS" src/` → both `src/lib/inngest/ticket-csat.ts` and `src/lib/ticket-analyzer.ts` import it from `@/lib/ticket-tags`; the const is defined in exactly one place. `npx tsc --noEmit` clean.
- On `/dashboard/csat`, the 30-day low-rating list no longer contains "Automatic reply: …"-subject rows once the in-window noise is stamped and the cron stops surveying new ones.

> Authored by the Developer Message Center from ticket `f5d1be18-aee2-43c0-8d6b-258e0fa4453a`. Commission the build from the Roadmap board (owner = cs).