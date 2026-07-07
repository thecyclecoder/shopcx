# libraries/ticket-merge

Merge duplicate tickets into a single home (the target). The source ticket is preserved as a thin archived stub keyed by `merged_into`, but the **conversation, FK references, and escalation all live on the target.**

> **Archived tickets ARE mergeable** (changed 2026-06-12). A prior, archived thread is often exactly the context you need to pull into a live ticket — the old blanket "cannot merge archived tickets" guard blocked that and broke a real case (Suzanne Doucet). The target-selection sort now **prefers a live (non-archived) ticket as the target**, so archived rows merge in as *sources* and an active ticket's messages are never moved into an archived stub.

**File:** `src/lib/ticket-merge.ts`

## Why this shape

Pre-2026-06-05 the merge copied messages onto the target and left the source intact with its own (now duplicated) conversation. That created two visible homes for the same support thread, cluttered the inbox, and caused real escalation work to get auto-archived when a customer's follow-up email triggered a fresh merge ([ticket 1215239b](https://shopcx.ai/dashboard/tickets/1215239b-cde6-48d3-913f-d6ec4c0de8f8) was the trigger). The current design ("Option B") makes the target authoritative and the source a redirect-only stub.

## What a merge does

For every non-target source ticket in the merge:

1. **Move (not copy) `ticket_messages`** — `UPDATE ticket_messages SET ticket_id = target` for everything on the source. Email message-id linkage stays intact because we don't reinsert rows.
2. **Carry forward tags, playbook/journey state, agent intervention, do_not_reply** to the target if the target doesn't already have them (target's state wins on conflict).
   - **`assigned_to` only carries forward if the source's `agent_intervened=true`** (a real human worked it). A bare routine/auto-assignment (assigned to the agent-todo routine with `agent_intervened=false`) must NOT propagate — it would flip the merged ticket into "agent-handled / defer" mode in the orchestrator (`agentAssigned` gate, `unified-ticket-handler.ts`) and block the standard cancel/refund playbooks even though no human is on it. (Ida McDonald 2026-06-10: a merged routine-assignment killed her refund flow.)
3. **Carry forward escalation** — if the source has `escalated_at` / `escalated_to` / `escalation_reason` and the target doesn't, copy them. Then **clear escalation on the source**. The work lives on the target now; an escalated source stub would just be a ghost.
4. **Repoint FK references** via `repointTicketRefs()` — see table below.
5. **Insert a system note on the target**: `[System] {mergedBy} merged ticket "{subject}" ({source.id}) into this ticket ({N} messages).` The UUID is auto-linked by the renderer (see [Dashboard render](#dashboard-render)).
6. **Archive the source**: `status='archived'`, `archived_at=now()`, `merged_into=target.id`. Source has no messages and no FK refs left — pure stub.

If the target was previously `closed` and didn't inherit `do_not_reply` through the merge, the target reopens to `open` so the agent can engage.

Finally, **lock in the pre-merge state as a durable Sonnet summary** on the target via `merge_summary` + `merge_summary_at` on [[../tables/tickets]] (Phase 1 of [[../specs/ticket-merge-summary-and-context-cap]]). Downstream orchestrator turns read this compact state snapshot instead of re-costing the full merged history to Opus on every turn — the failure mode measured on ticket 49ddd6c4 ($8.92 via [[ai-usage]] `usageCostCents`). Summary writing is fire-and-forget: a Sonnet outage / missing key never blocks the merge (Phase 2's context assembly falls back to legacy behavior when `merge_summary` is NULL).

## Merge summary lifecycle

- **First merge on a target** → Sonnet summarizes the full merged target thread (up to 500 messages).
- **Repeat merge on a target that already has a summary** → the prior summary is carried forward as "PRIOR STATE" and only the newly-moved message ids feed the summarizer. No merge event ever re-costs unchanged history to Sonnet.
- **Repeat merge that moved zero messages** → `shouldRegenerateMergeSummary(prior, 0)` returns `false`; the write is skipped. This is the Phase-1 verification bullet "does not re-summarize unchanged history on a later unrelated update."

The persist call uses compare-and-set (`.eq("id", target).eq("workspace_id", ws).select("id")`) so a stale target id can't scribble across another workspace's row.

## Target selection — order by customer activity

The target is the ticket where the **customer most recently spoke**, not just the newest one created. We sort `last_customer_reply_at DESC NULLS LAST, created_at DESC` and take the first. Reason: a customer who has switched to a fresh chat session can't see replies dropped into an older one — the merge needs to land in whatever surface they're actually watching. Same logic applies to email back-and-forth where one of multiple recent tickets is the live conversation.

## FKs that follow the conversation

`repointTicketRefs(admin, sourceId, targetId)` walks an explicit allow-list of `[table, column]` pairs and runs `UPDATE … SET column = target WHERE column = source` on each. Unknown/missing tables are tolerated (logged, skipped) so adding new tables doesn't break this. Current list lives in `TICKET_FK_TABLES`:

| Table | Column | Why it follows |
|---|---|---|
| `returns` | `ticket_id` | The return was initiated during the conversation |
| `agent_todos` | `source_ticket_id` | Todos describe work for that conversation |
| `ticket_analyses` | `ticket_id` | Analysis grades the live conversation |
| `ticket_csat` | `ticket_id` | CSAT belongs to the conversation outcome |
| `store_credit_log` | `ticket_id` | Issuance tied to the conversation |
| `replacements` | `ticket_id` | Replacement initiated during the conversation |
| `appstle_api_calls` | `ticket_id` | Actions fired during the conversation |
| `journey_sessions` | `ticket_id` | Journey scoped to the conversation |
| `email_log` | `ticket_id` | Email-tracking events for the conversation |
| `pattern_feedback` | `ticket_id` | Agent feedback tied to the conversation |
| `chargeback_subscription_actions` | `ticket_id` | Actions fired during the conversation |
| `chargeback_monitor` | `ticket_id` | Chargeback context for the conversation |
| `macro_usage_log` | `ticket_id` | Macros applied during the conversation |
| `ai_token_usage` | `ticket_id` | AI cost attribution |
| `crisis_customer_actions` | `ticket_id` | Crisis actions during the conversation |

Explicitly **NOT repointed** (these are provenance/historical-link columns, not "belongs to" relationships):
- `ticket_analyses.derived_from_ticket_id`
- `sonnet_prompts.derived_from_ticket_id`

## Stub semantics

A merge stub is a `tickets` row with:
- `status = 'archived'`
- `archived_at` set
- `merged_into` = the live target (always the terminal of any chain)
- `escalated_*` cleared (escalation moved to target)
- No `ticket_messages` linking to it
- No FK refs from related tables

The stub exists for two reasons:
1. **Email thread resolution.** Customer's `In-Reply-To` header might still reference the source's `email_message_id`. The inbound email webhook resolves that to the source, then follows `merged_into` to the live target (see [Inbound routing](#inbound-routing)).
2. **Audit / breadcrumb.** Anyone landing on the stub's URL gets redirected by the dashboard via the merge note, which is rendered with a clickable target UUID.

Stubs are filtered out of:
- The customer portal (`/api/portal/support/tickets` queries `merged_into IS NULL`)
- The auto-merge candidate query in `unified-ticket-handler.ts` (same filter)

They are **NOT** filtered out of the agent dashboard list — agents can still find them via search if they're looking for a specific id.

## Inbound routing

`app/api/webhooks/email/route.ts` resolves an incoming reply to a ticket via In-Reply-To. After the match, it calls `resolveMergedTarget(admin, ticketId)` which walks the `merged_into` chain to the terminal live ticket (max 10 hops, cycle-safe). The new message is appended on the terminal target, not on the stub. Without this, a customer reply on the stub's thread would create a brand-new ticket and immediately trigger another auto-merge.

## Dashboard render

`src/app/dashboard/tickets/[id]/page.tsx` renders system notes through a UUID-linkifier: any `[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}` inside an `author_type='system'` message becomes a `/dashboard/tickets/<uuid>` link (shortened to the 8-char prefix as the visible label). Primary use: the merge breadcrumb. Generalizes for any future system note that drops a ticket id into the body.

## AI analysis skips stubs

`analyzeTicket()` in `src/lib/ticket-analyzer.ts` returns early with `reason: "merged_into_other"` when the ticket has `merged_into` set. Analysis runs only on the terminal target. Reason: grading an empty stub would always score poorly + re-escalate, and grading a target that hasn't been auto-closed yet happens on its own close cycle.

## Auto-merge trigger

`src/lib/inngest/unified-ticket-handler.ts` runs the auto-merge when a new ticket arrives: it queries the customer's other tickets in the last 14 days that don't already have `merged_into` set, and if any match it calls `mergeTickets()` with the full set. The "newest" customer-activity ticket is what becomes the target — typically the brand-new ticket being processed.

## Backfill (one-time, 2026-06-05)

`scripts/backfill-merge-stubs.ts` reconciles tickets that were merged under the old "copy + keep" model. It:
- Walks `merged_into` chains to the terminal target (handles A→B→C cases — 124 chains collapsed)
- For each source's `ticket_messages`, dedupes against the target: exact twin (body + author + created_at + direction) → delete from source; orphan (post-merge activity that landed on the source asynchronously) → move to target; merge breadcrumb (`[System] This ticket was merged into ticket …`) → drop
- Repoints all FK rows via `repointTicketRefs`
- Carries source escalation to target where target wasn't already escalated, clears on source
- Re-archives any source that had been unarchived during the interim "escalated never archived" rule

Result (2026-06-05): 7,363 dup messages deleted, 112 orphan messages moved, 251 breadcrumbs dropped, 1,186 FK rows repointed, 24 escalations carried, 40 sources re-archived, 124 chains collapsed.

Re-run idempotent — running the script again after data is clean is a no-op.

## Exports

### `mergeTickets(workspaceId, ticketIds, mergedBy?) → Promise<MergeResult>`
Merges 2+ tickets. Picks target = ticket with most recent customer activity. Rejects archived inputs and already-merged inputs.

### `repointTicketRefs(admin, sourceId, targetId) → Promise<{table, updated, error?}[]>`
Reusable FK-repointer used by both the live merge and the backfill.

### `resolveMergedTarget(admin, ticketId) → Promise<string>`
Follow the `merged_into` chain to the terminal id (max 10 hops). Used by the email-inbound router.

### `shouldRegenerateMergeSummary(priorSummary, newlyMovedCount) → boolean`
Pure predicate. Returns `true` on a first merge (no prior summary) or a repeat merge that moved new content in. Returns `false` when a prior summary exists AND this event moved zero messages — that's the "don't re-cost unchanged history" case. Unit-tested in `src/lib/ticket-merge.test.ts`.

### `buildMergeSummaryPrompt(priorSummary, messages) → { system, user }`
Pure builder for the Sonnet summarizer prompt. Two shapes — first-merge vs. repeat-merge — so a repeat merge only feeds the newly-moved messages plus the prior summary as "PRIOR STATE." Unit-tested.

### `MergeResult` — interface
`{ success, targetTicketId, mergedCount, messagesMoved, error? }`

## Callers

- `src/app/api/tickets/merge/route.ts` — bulk action from the agent UI
- `src/lib/inngest/unified-ticket-handler.ts` — auto-merge on new inbound ticket
- `src/app/api/webhooks/email/route.ts` — calls `resolveMergedTarget` only
- `src/lib/ticket-analyzer.ts` — checks `merged_into` to skip stubs
- `scripts/backfill-merge-stubs.ts` — one-time reconciliation

## Gotchas

- **Don't filter the agent dashboard list by `merged_into IS NULL`.** Stubs are intentionally findable if an agent searches by id; the inbox-level filters (status, escalated, etc.) already keep them out of the default views.
- **Email threads on stubs work via the redirect, not by reinstating the stub.** Customers replying to old chains should land on the live target via `resolveMergedTarget`, not by un-archiving the stub.
- **Escalation always lives on the live target.** If you see `escalated_at` on a stub (`merged_into IS NOT NULL`), something has bypassed `mergeTickets` — investigate; don't paper over it.
- **`repointTicketRefs` is best-effort.** A missing table name in the allow-list won't fail the merge, it'll just leave that table's rows pointing at the stub. Add to `TICKET_FK_TABLES` when introducing new ticket-referencing tables.

---

[[../README]] · [[../../CLAUDE]]
