# Suppress CSAT surveys on tickets we never actually replied to ⏳

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
- ⏳ **P1 — eligibility guard** — `src/lib/inngest/ticket-csat.ts`: before the send in the `find-due` loop, compute eligibility; on ineligible, set `csat_sent_at = now()` and skip the email. Extract `SKIP_TAGS` to a shared module, import it here and in `ticket-analyzer.ts`. Return counts (`sent`, `skipped_too_old`, `skipped_no_reply`). `npx tsc --noEmit` clean.
- ⏳ **P2 — brain refresh** — `docs/brain/inngest/ticket-csat.md` is stale (claims event-trigger `ticket/closed` + "writes tickets.csat_score" — neither is true; it's a `*/15` cron that stamps `tickets.csat_sent_at` and writes no score). Rewrite it to match the code + document the new eligibility rule. Add a gotcha to `docs/brain/tables/ticket_csat.md` ("CSAT is only sent for tickets we actually answered — auto-reply/OOF/spam/do_not_reply tickets are skipped + stamped") and to `docs/brain/lifecycles/csat.md`.
- ⏳ **P3 (optional) — backfill in-window noise** — one-off audit script: find currently in-window closed tickets (48h-7d, `csat_sent_at IS NULL`) that are ineligible under the new rule and stamp them skipped, so the next tick doesn't survey them. Dry-run → `--apply`.

## Verification
- Run the `find-due` logic over an `f5d1be18-…`-shaped ticket (closed auto-reply, 0 customer-facing outbound) → expect skipped, `csat_sent_at` stamped, no email, `skipped_no_reply` incremented.
- A normal resolved ticket with ≥1 `outbound/.../external` message (e.g. `75cfe7c0-…`, `f21db601-…`) → still surveyed.
- A `do_not_reply=true` ticket and a ticket tagged `outreach`/`spam:bot` → skipped.
- `SKIP_TAGS` imported from one shared module by both `ticket-csat.ts` and `ticket-analyzer.ts`; `npx tsc --noEmit` clean.
- 30-day low-CSAT report no longer contains auto-reply-subject rows.

> Authored by the Developer Message Center from ticket `f5d1be18-aee2-43c0-8d6b-258e0fa4453a`. Commission the build from the Roadmap board (owner = cs).