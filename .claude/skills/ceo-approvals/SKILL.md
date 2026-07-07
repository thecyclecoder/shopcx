# ceo-approvals

**When:** the founder asks to see / triage / clear the approvals **routed to the CEO** ("what's in my CEO inbox", "help me with my approvals", "13 approvals routed to CEO", "dismiss the stale ones"). Also whenever you need to find what's escalated to the human before it silently blocks the autonomous pipeline.

**Why:** the autonomous org escalates to the CEO seat (Henry) only what exceeds a director's leash or what nothing automated can resolve. Those land as `dashboard_notifications` (type `agent_approval_request`, `routed_to_function='ceo'`) and show on the developer/approvals dashboard — but the founder has no fast way to *triage* them: which are real decisions, which are stale outage artifacts safe to dismiss, which mask a real infra problem. This skill surfaces them enriched (spec · phase · who raised · type · pending action + cmd · age · staleness) and gives one command each to approve / decline / dismiss.

**Source of truth = the same code the dashboard uses.** The runnable calls [[../../../src/lib/agents/approvals-feed]] `buildApprovalsFeed` and filters `source==='pending' && escalated` — so the list matches the UI 1:1. See [[../../../docs/brain/dashboard/approvals.md]].

## Procedure

1. **List.** Run the read-only lister:
   ```sh
   npx tsx scripts/ceo-approvals.ts list
   ```
   Each card prints: index, human `typeLabel`, spec/goal + phase, `raised → routed`, `age`, the linked `job` status, the escalation `why`, each pending `action` (id + `cmd` if any), and a `⚠️ STALE` flag when the linked job is already terminal (completed/merged/cancelled/failed) or missing, or the card is >7d old.

2. **Triage into buckets — don't hand the founder 13 raw rows.** Group by root cause and recommend per-bucket, most common:
   - **Outage / "no parseable verdict" artifacts** — deploy-review / ticket-analyze / "Deploy Review Failsafe" cards that parked because a Claude session returned no parseable verdict (an API outage window). The underlying deploy usually already merged; the review just couldn't self-verify. **Recommend dismiss** (or let the deploy-guardian re-verify sweep re-review fresh) — not a real CEO decision.
   - **Real infra failures** — e.g. `authentication_failed / Not logged in` on a Max account (grading/reviews can't run until it's re-logged-in). **Do NOT dismiss** — surface it; it needs a fix, not an acknowledgement.
   - **Blocked-by-a-known-bug** — a repair/author job that hit `InvalidParentError` (bare-function parent) or a similar authoring rail. Note the durable-fix spec that covers it; dismiss only once that fix ships.
   - **Genuine decisions** — out-of-leash / destructive / multi-choice actions raised by a worker (e.g. a storefront campaign from Max). These are the ones that actually want the founder's judgment — present the `cmd`/preview and let them choose.

3. **Act on the founder's call.** Get explicit go-ahead before a mass-dismiss (these are approvals — never clear them on a bare question). Then:
   ```sh
   npx tsx scripts/ceo-approvals.ts approve  <jobId> <actionId> [notes]
   npx tsx scripts/ceo-approvals.ts decline  <jobId> <actionId> [notes]
   npx tsx scripts/ceo-approvals.ts dismiss  <notificationId> [reason]
   ```
   `approve`/`decline` go through `roadmap-actions.approveRoadmapAction` (the same path the dashboard button uses); `dismiss` marks the `dashboard_notifications` card dismissed (stale cleanup — does NOT decide the action, just clears the card).

## Guardrails

- **Read-only by default.** `list` touches nothing. Writes are owner-attributed.
- **Never mass-dismiss on a question.** The founder asking "what's in my inbox" is not consent to clear it. Present the triage, get the go-ahead, then act.
- **Dismiss ≠ decide.** Dismissing a card clears it from the inbox but does not approve/decline the underlying action. Use it for stale/outage artifacts, not for a live decision the founder actually needs to make.
- **A real failure hiding as an approval** (auth, migration-apply, breaker) is a fix, not a dismiss — surface it.
- **Decline destructive/irreversible** unless the founder explicitly approves; when unsure, leave it and ask.

## Related

- [[../../../src/lib/agents/approvals-feed]] — `buildApprovalsFeed` / `countEscalatedApprovals` (the feed this reads)
- [[../../../src/lib/roadmap-actions]] — `approveRoadmapAction` (approve/decline path)
- [[../../../docs/brain/tables/approval_decisions.md]] · [[../../../docs/brain/tables/dashboard_notifications.md]] — the ledger + the pending-card table
- `scripts/ceo-approvals.ts` — the runnable this skill drives
