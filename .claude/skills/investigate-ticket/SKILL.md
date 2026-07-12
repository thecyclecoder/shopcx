# investigate-ticket

**When:** the founder wants the full picture of a single support ticket — "what happened on ticket X", "why did Sol not respond / fail on the 2nd turn", "did this reply actually send", "why is Cora not grading this", or hands you a `https://shopcx.ai/dashboard/tickets/{id}` link. Reach for it any time you're about to hand-debug a ticket by querying the DB — this replaces that.

**Why:** debugging a ticket means assembling the same picture every time — the ticket row + customer, the chronological messages (and whether each AI reply actually *shipped* vs staged/cancelled), the Sol **Direction** artifacts (chosen_path + plan shape), the Sol `ticket-handle` box-session jobs (status + terminal_reason + note + error), the merge/redirect history, and Cora's grading state — then reasoning turn-by-turn about where a turn went silent. This skill does all of that in one read and flags the failure modes for you (SILENT TURN: Sol ran but nothing shipped; `plan.steps` narrative instead of executable actions; UNGRADED because closed-but-no-Direction).

**Source of truth = the [[../../../src/lib/tickets-read]] SDK.** The runnable calls `investigateTicket` + `buildTurnTimeline` — all reads go through that SDK, **never raw `.from("tickets")` queries** (CLAUDE.md discipline: reads go through an SDK). Merge-aware: a stale or merged-away id (an archived reply-duplicate) resolves to the surviving ticket automatically via `resolveMergedTarget`.

## Procedure

1. **Run the read-only investigator** with the ticket id OR the dashboard link:
   ```sh
   npx tsx scripts/investigate-ticket.ts <ticket-id | https://shopcx.ai/dashboard/tickets/{id}>
   ```

2. **Read the report top-to-bottom.** It prints, in order:
   - **Header** — subject · status · channel · created/closed · customer · tags · active_playbook · escalation · **Cora grading** (GRADED vs UNGRADED). A `↪ redirected` line means the id you gave was merged away into the ticket shown.
   - **MERGED-IN TICKETS** — prior threads / reply-duplicates absorbed here (each with its own created-at). A reply that spawned a *new* ticket then got merged shows up here — that's the duplicate-ticket-then-merge pattern.
   - **MESSAGES** — chronological; each external AI message is tagged `✅SENT` / `⏳STAGED` / `✖CANCELLED` / `⚠️UNSENT`.
   - **SOL DIRECTIONS** — `LIVE` vs `superseded`, `chosen_path`, `authored_by`, and a `⚠️ plan.steps present` flag when the plan is narrative rather than executable.
   - **SOL ticket-handle JOBS** — status · terminal_reason · session_note · error.
   - **TURN-BY-TURN DIAGNOSIS** — one line per customer turn: which Direction was authored, whether a reply was delivered, whether the plan had action-steps, and a **⚠️ SILENT TURN** flag when Sol ran but nothing shipped.

3. **Diagnose from the flags, not a hunch.** Common findings the report surfaces directly:
   - **SILENT TURN** — a Direction was authored but no reply shipped → Sol's turn produced nothing the worker could send (empty `first_reply`, or a `plan.steps` action the cheap-execution can't execute).
   - **UNGRADED + no LIVE Direction** — Cora's feeder drops tickets with no live Direction; a closed ticket Sol handled without a persisted Direction never gets graded.
   - **MERGED-IN with a newer top-level created_at** — the customer's reply created a duplicate ticket that was merged post-hoc (threading miss).

## Guardrails

- **Read-only.** The runnable and the SDK mutate nothing. Safe to run on any ticket, in any environment.
- **No raw queries.** Everything goes through `tickets-read`. If you need a field the SDK doesn't expose, add it to the SDK — don't reach past it into `.from("tickets")`.
- **Report ≠ fix.** This surfaces what happened; taking action (retriggering Sol, executing a mutation, sending a reply) is a separate, deliberate step.

## Related

- [[../../../src/lib/tickets-read]] — the read SDK this drives (`investigateTicket`, `getTicket` (merge-aware), `getTicketMessages`, `getTicketDirections`, `getTicketHandleJobs`, `getMergedFromTickets`, `buildTurnTimeline`)
- [[../../../src/lib/ticket-merge]] — `resolveMergedTarget` (the redirect follow)
- [[../../../docs/brain/libraries/ticket-directions]] · [[../../../docs/brain/tables/ticket_directions]] — the Direction artifact Sol writes
- [[../../../docs/brain/tables/tickets]] · [[../../../docs/brain/tables/ticket_messages]] — the underlying tables
- `scripts/investigate-ticket.ts` — the runnable this skill drives
