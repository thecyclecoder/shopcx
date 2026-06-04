# Lifecycle: Agent To-Do system

Replaces synchronous ticket-by-ticket handling with an async approval queue. A **Claude Code Routine** reasons about escalated tickets hourly using the brain + DB, proposes concrete actions (replies, sub mutations, refunds, return labels, new Sonnet rules, brain edits, code changes), and writes them as todos. Dylan + Zach review the queue on [[../dashboard/tickets__todos]]; approval triggers execution, rejection routes the ticket to manual handling.

**Business outcome:** Dylan's 2–3 hrs/day of escalation handling drops to ~30 min/day of approval clicks, while preserving Dylan-level judgment on every customer touch and every system change. **The routine never executes a customer-facing action or system change without explicit human approval.**

## Two runtimes
See [[../inngest/agent-todo-routine]] for the full split. Short version:
- **Claude Code Routine** (`agent-todo-routine`, hourly, Anthropic cloud, has git): reasoning pass + system-level execution (DB inserts, brain/code PRs) + PR cleanup.
- **Inngest worker** (`agent-todo-execute`, event-triggered, Vercel): customer-facing immediate execution (`customer_reply`/`customer_action`/`ticket_close`).

## End-to-end trace

1. **Escalation.** The orchestrator escalates a ticket in [[../inngest/unified-ticket-handler]] (3 sites). Under this system those sites set `escalated_to = NULL` and `assigned_to = NULL` — escalations route to the routine, not a human. (`escalation_reason` + `escalated_at` still set; a system note says "Escalated to the To-Do routine.")
2. **Reasoning (hourly).** `runReasoningPass()` finds escalated tickets with no active `agent_todos` group, gathers context (messages, customer, subs, orders, latest [[../tables/ticket_analyses]]), and reasons with Opus (tool-use `propose_todos`). It writes a `pending` group sharing one `group_id`. Decision branches:
   - **no_action** (false-positive) → single `ticket_close`, urgency=low.
   - **customer_fix** → 1 `customer_reply` + N `customer_action`.
   - **system_gap** → additionally `sonnet_prompt_*` / `brain_doc_edit` / `code_change` (owner-approval only).
   - **analysis_gap** → `ticket_analysis_rescore` (+ `grader_prompt_edit` if a pattern).
   - **escalation_false_positive** → `escalation_rule_fix` when ≥2 tickets misfired on the same rule.
   It captures `pre_exec_context` (latest inbound message id) for drift detection and writes the two plain-English context blocks.
3. **Review.** Dylan/Zach open [[../dashboard/tickets__todos]] (grouped list, role-scoped bubble) → [[../dashboard/tickets__todos__id]] (what happened / what we propose / per-todo previews / collapsed conversation).
4. **Approve.**
   - Customer-facing → `POST /api/todos/[id]/approve` fires `agent-todo/execute`. The worker drift-checks, dispatches (`sendTicketReply` / `directActionHandlers` / close), records the result, and auto-closes the ticket when the last customer-facing todo in the group executes (+ system note "Resolved via To-Do system. Approved by {role}…").
   - System-level → the approve API wakes the Routine on-demand (or it waits for the hourly tick). The Routine executes DB actions inline and opens CI-gated `claude/`-branch PRs for brain/code. PR URL lands in `execution_result.pr_url` and surfaces on [[../dashboard/branches]] + the todo detail PR card.
5. **Reject.** `POST /api/todos/[id]/reject` marks the todo (optional reason). The ticket is **not** auto-closed. When the whole group is rejected, the ticket's `escalated_to` is set to the **workspace owner** (always owner — Dylan handles all manual ticket work) and tagged `todo:rejected`; it then appears under "Rejected → me" in [[../dashboard/tickets__escalated]].
6. **Drift.** If the customer replies between approval and execution, the worker marks the todo `superseded` and the next reasoning pass re-proposes against the fresh state.
7. **PR cleanup (hourly).** The Routine reconciles executed PR todos: merged → stamp `execution_result.merged_at`; closed-without-merge → `status='rejected'`, `reject_reason='pr_closed_without_merge'`.

## Code map
- Table: [[../tables/agent_todos]] · migration `supabase/migrations/20260604190000_agent_todos.sql`
- Shared lib: `src/lib/agent-todos/` — `constants.ts` (taxonomy + `canApprove`), `types.ts`, `execute.ts` (customer-facing + drift + auto-close), `reasoning.ts` (Opus pass), `system-execute.ts` (DB + CI-gated PRs).
- Inngest worker: `src/lib/inngest/agent-todo-execute.ts` (registered in `src/app/api/inngest/route.ts`).
- API: `src/app/api/todos/route.ts` (list), `src/app/api/todos/[id]/route.ts` (detail), `…/[id]/approve`, `…/[id]/reject`, `src/app/api/escalated/route.ts`, `src/app/api/branches/route.ts`.
- Dashboard: `src/app/dashboard/tickets/todos/{page,[id]/page}.tsx`, `…/tickets/escalated/page.tsx`, `…/branches/page.tsx`; sidebar links + bubbles in `src/app/dashboard/sidebar.tsx`.
- Scripts: `scripts/print-routine-env.ts`, `scripts/agent-todo-routine-run.ts` (per-tick), `scripts/agent-todo-backfill.ts` (Phase 5).

## Safety invariants
- No action executes without `status='approved'` + matching `approved_by`/`approval_role`. Role gate: `canApprove()`.
- Drift check immediately before customer-facing execution; expired approvals supersede silently.
- One active group per ticket (reasoning pass skips tickets with a pending/approved/executed group).
- No direct-to-main pushes from the routine (`claude/`-branches only). CI gate (`npx tsc --noEmit`) before every PR. `code_change` never auto-merges.
- No silent retries — a `failed` todo stays failed and surfaces in the queue.
- Routine is stateless between runs; state lives in `agent_todos`.

## Status / open work

**Shipped (code):** ✅ schema + migration · ✅ escalation routing change (3 sites) · ✅ reasoning lib + routine run/backfill scripts · ✅ `print-routine-env.ts` · ✅ Inngest worker + approve/reject/list/detail APIs · ✅ To-Do list + detail dashboards · ✅ escalated observability rebuild · ✅ branches surface + APIs · ✅ sidebar links + bubbles · ✅ brain pages. `npx tsc --noEmit` clean.

**Manual / operational (cannot be done from code):**
- ⏳ Apply the migration to the live DB (`supabase db push`).
- ⏳ Create the `agent-todo-routine` at `claude.ai/code/routines`: repo = shopcx, model = Opus, hourly schedule + API trigger, env via `npx tsx scripts/print-routine-env.ts | pbcopy`, branch policy `claude/`-only. Set `AGENT_TODO_ROUTINE_TRIGGER_URL` (+ token) in Vercel so the approve API can wake it; set `GITHUB_TOKEN` for the Branches surface; confirm the Claude GitHub App is installed on `thecyclecoder/shopcx` with branch-push + PR permissions.
- ⏳ Run `npx tsx scripts/agent-todo-backfill.ts` to populate todos for the currently-escalated tickets (incl. Millie's return-label proposal), validate end-to-end, then enable the hourly schedule.

## Related
[[../tables/agent_todos]] · [[../inngest/agent-todo-routine]] · [[../inngest/unified-ticket-handler]] · [[../libraries/action-executor]] · [[../dashboard/tickets__todos]] · [[../dashboard/tickets__todos__id]] · [[../dashboard/tickets__escalated]] · [[../dashboard/branches]] · [[ticket-lifecycle]] · [[ai-learning]] · [[../customer-voice]] · [[../operational-rules]]
