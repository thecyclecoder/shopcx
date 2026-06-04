# Agent To-Do system

Replace synchronous ticket-by-ticket handling with an async approval queue. A 30-minute routine reasons about escalated tickets (and eventually other surfaces) using the brain + DB, proposes concrete actions (replies, sub mutations, refunds, return labels, new Sonnet rules, brain edits, code changes), and writes them as todos to an approval queue. Dylan + Zach review the queue on `/dashboard/tickets/todos`. Approval triggers execution; rejection routes the ticket to a Claude-chat session for manual handling.

**Business outcome:** today Dylan spends 2-3 hours/day handling escalated tickets and the structural fixes those tickets surface. The system reduces that to ~30 minutes/day of approval clicks while preserving Dylan-level judgment on every customer touch and every system change. The routine never executes customer-facing actions or system changes without explicit human approval.

## Phase 0 — Schema + migration ⏳

- ⏳ New table `agent_todos`:
  ```
  id uuid PK
  workspace_id uuid → workspaces.id
  source text                                   -- 'ticket' | 'csat' | 'cron' | 'manual'
  source_ticket_id uuid → tickets.id (nullable)
  group_id uuid                                 -- links N todos from one logical fix
  action_type text                              -- enum below
  payload jsonb                                 -- action-specific (reply HTML, mutation params, diff)
  summary text                                  -- short label for list view
  context_what_happened text                    -- plain-English customer-side narrative
  context_what_we_propose text                  -- plain-English fix narrative
  pre_exec_context jsonb                        -- snapshot for drift detection
  confidence real
  urgency text                                  -- 'urgent' | 'normal' | 'low'
  status text                                   -- 'pending' | 'approved' | 'executed' | 'rejected' | 'superseded' | 'failed'
  approved_by uuid → auth.users.id (nullable)
  approved_at timestamptz
  approval_role text                            -- 'owner' | 'admin'
  executed_at timestamptz
  execution_result jsonb
  rejected_at timestamptz
  rejected_by uuid → auth.users.id
  reject_reason text
  routine_run_id uuid (nullable)                -- which routine pass proposed this
  created_at timestamptz default now()
  updated_at timestamptz default now()
  ```
- ⏳ `action_type` enum:
  - `customer_reply` — outbound message on the source ticket
  - `customer_action` — sub mutation / refund / return label / loyalty apply / store credit / pause
  - `ticket_close` — for false-positive escalations
  - `sonnet_prompt_new`
  - `sonnet_prompt_edit`
  - `ticket_analysis_rescore` — update an existing `ticket_analyses` row's score/summary/issues when the analyzer got it wrong (e.g. it scored a clean ticket 5/10 because of a misread)
  - `grader_prompt_edit` — propose a change to the per-ticket analyzer's grading rules (the prompts that produce `ticket_analyses`)
  - `escalation_rule_fix` — propose tightening or fixing the auto-escalation triggers (threat-language detector, severe-issue detector, etc.) when a false-positive pattern shows up across multiple tickets
  - `brain_doc_edit`
  - `code_change`
- ⏳ Index on `(workspace_id, status, created_at desc)` for list-view paging.
- ⏳ Index on `(source_ticket_id)` for the linked-todos block on detail page.

## Phase 1 — The 30-min routine ⏳

Inngest function `agent-todo-routine`, cron `*/30 * * * *`, concurrency limit 1.

Per run:

1. **Reasoning pass** — for each open or recently-closed ticket where `escalated_at IS NOT NULL` AND no `agent_todos` row with status in `('pending','approved','executed')` exists for that ticket:
   - Load full ticket context: messages, customer record, subs, recent orders, AI analysis, active crisis enrollment if any.
   - Read the brain pages relevant to the message intent (`customer-voice.md`, `operational-rules.md`, the ticket-lifecycle, any matching playbook lifecycle).
   - Use Opus to reason about: what did the customer want, what did the AI do, what's the gap, what's the fix.
   - Decide one of:
     - **No action needed** (false-positive escalation) → propose single `ticket_close` todo with urgency=low.
     - **Customer fix needed** → propose linked todos: 1× `customer_reply` + N× `customer_action` (one per mutation), all sharing the same `group_id`.
     - **System gap** → additionally propose linked `sonnet_prompt_*`, `brain_doc_edit`, or `code_change` todo with the same `group_id`. These are owner-approval only.
     - **AI-analysis gap** → if the existing `ticket_analyses` row scored the ticket wrong (e.g. clean ticket scored 5/10 due to a misread, OR a real issue scored 10/10 because the grader missed it), propose a `ticket_analysis_rescore` todo with the corrected score + summary + issues. If the misread reflects a pattern (multiple tickets the grader scored similarly wrong this run), additionally propose a `grader_prompt_edit` to tighten the grader.
     - **Escalation false-positive pattern** → when ≥2 tickets in this run are flagged as false-positive escalations triggered by the same auto-flag rule (e.g. three tickets escalated for "threat language" when no threat exists), propose an `escalation_rule_fix` todo describing the tightening (specific regex / keyword removal / prompt change).
   - Write `context_what_happened` (1 short paragraph) and `context_what_we_propose` (one paragraph or short bulleted list) so Zach can act without reading the conversation.
   - Capture `pre_exec_context` (latest_inbound_message_id, sub state hash, etc.) for drift detection.
2. **Execution pass** — for each `approved` todo where execution is owed (immediate for customer-facing; queued for system-level):
   - Re-verify drift: latest customer reply timestamp vs `pre_exec_context.latest_inbound_at`. If a new inbound message has landed since approval, mark `status='superseded'` with reason, don't execute. (A new proposal will be created on the next reasoning pass.)
   - Execute via the right helper (`sendTicketReply`, `subRemoveItem`, `createFullReturn`, supabase insert into `sonnet_prompts`, file write + commit + push, etc.).
   - Record `execution_result` jsonb (label_url, message_id, commit_sha, etc.).
   - On failure → `status='failed'` with the error; do NOT auto-retry.
3. **Auto-closure pass** — for each `source_ticket_id` where all customer-facing todos (`customer_reply` + `customer_action`) in the group are `executed`:
   - Update `tickets`: `status='closed'`, `escalated_at=null`, `assigned_to=null`, `closed_at=now()`.
   - Insert system note in ticket_messages: *"[System] Resolved via To-Do system. Approved by {role} {name} at {time}."*
   - System-level todos (`sonnet_prompt_*`, `brain_doc_edit`, `code_change`) do NOT block ticket closure. They can be approved + executed later without touching the customer.

**Safety invariants — non-negotiable:**
- The routine NEVER executes a customer-facing or system-level action without a `status='approved'` row.
- The routine NEVER auto-retries failed executions.
- The routine NEVER approves its own proposals.
- Drift check MUST run immediately before execution; expired-context approvals supersede silently.
- For each ticket, only ONE active group of todos at a time. If a routine sees an existing pending/approved group, skip — don't propose a duplicate.

## Phase 2 — Dashboard list view ⏳

Route: `/dashboard/tickets/todos`. Sidebar link: Tickets → **To Do** with role-scoped bubble count.

- ⏳ **List columns:** urgency dot, customer name, summary (1 line), action types (badges), proposed_at, approval state, group indicator.
- ⏳ **Filters:** status (default = pending), urgency, action_type, source (ticket / cron / etc.), assigned-to-me-role (toggle "items I can approve").
- ⏳ **Group rendering:** todos sharing a `group_id` collapse into one row by default; expand to see each individual todo.
- ⏳ **Bubble count = items the current viewer can approve.** For Dylan: all pending. For Zach: pending where `action_type IN ('customer_reply','customer_action','ticket_close')`.
- ⏳ **Visibility ≠ approval.** Zach sees everything, including owner-only todos. Owner-only rows render with *"Needs owner access to approve"* instead of approve/reject buttons.

## Phase 3 — Dashboard detail view ⏳

Route: `/dashboard/tickets/todos/[id]`.

- ⏳ **Header:** customer, LTV, source ticket subject + id, escalation reason.
- ⏳ **"What happened" block** — pulls from `context_what_happened` (plain English, 1 paragraph).
- ⏳ **"What we propose" block** — pulls from `context_what_we_propose` (plain English, may be bulleted).
- ⏳ **Linked todos panel** — shows every todo in the same `group_id`. Each row: action_type badge, summary, approval state, approver name + role + time when not pending. Approve / Reject buttons inline per row; or "Needs owner access" greyed pill if the viewer's role can't approve that type.
- ⏳ **Action preview** — for `customer_reply`, render the HTML message inline (read-only) so the approver sees exactly what the customer would see. For `customer_action`, render a structured diff (e.g. "Remove Strawberry Lemonade from sub 946db2fd / next billing 2026-06-24"). For `sonnet_prompt_*`, render the rule content as a diff against any existing prompt. For `brain_doc_edit` and `code_change`, render the unified diff.
- ⏳ **Conversation appendix** — collapsed by default. Click to expand the full ticket_messages log. This exists for verification, not for primary comprehension; the two context blocks above should be enough.

## Phase 4 — Approval API + execution ⏳

- ⏳ `POST /api/todos/[id]/approve`
  - Auth: `workspace_members.role` of the caller must allow the `action_type`.
  - Set `status='approved'`, stamp `approved_by/at/role`.
  - **For customer-facing actions** (`customer_reply`, `customer_action`, `ticket_close`) → fire `inngest.send('agent-todo/execute', { todo_id })` for immediate execution. Drift-check runs inside the worker.
  - **For system-level actions** (`sonnet_prompt_*`, `brain_doc_edit`, `code_change`) → leave status='approved'; the next 30-min routine tick picks it up. (Reason: code/brain changes can wait minutes; customer can't.)
  - Return the updated todo for optimistic UI refresh.
- ⏳ `POST /api/todos/[id]/reject`
  - Auth: same role gate as approve.
  - Set `status='rejected'`, stamp `rejected_by/at`, save `reject_reason` (optional text from the dialog).
  - **Ticket is NOT auto-closed on reject.** It stays in its current escalated state so Dylan can pick it up in a Claude-chat session.
  - If all todos in the group are rejected, add a tag to the source ticket: `todo:rejected` so Dylan can filter the rejected pile from the regular ticket inbox.
- ⏳ Inngest worker `agent-todo-execute` (event `agent-todo/execute`):
  - Load todo.
  - Drift check via `pre_exec_context`.
  - Dispatch by `action_type` to the right helper.
  - Update `status` + `execution_result` based on outcome.
  - If this was the last unexecuted customer-facing todo in the group → run auto-closure step from Phase 1.

## Phase 5 — Backfill + first run ⏳

- ⏳ One-shot script: for each currently-escalated ticket (the 7 in the queue right now), run the routine's reasoning pass once and write its todos. Confirms the pipeline end-to-end on real data before going live.
- ⏳ After backfill validates, enable the cron trigger.

## Phase 6 — Brain index updates ⏳

- ⏳ Update `docs/brain/specs/README.md` Active Project 1-3 to mention the To-Do system as their common feedback surface (since it'll route fixes back into each project).
- ⏳ New brain page: `docs/brain/dashboard/tickets__todos.md` (list view).
- ⏳ New brain page: `docs/brain/dashboard/tickets__todos__id.md` (detail view).
- ⏳ New brain page: `docs/brain/tables/agent_todos.md`.
- ⏳ New brain page: `docs/brain/inngest/agent-todo-routine.md`.
- ⏳ New brain page: `docs/brain/lifecycles/agent-todo-system.md` (the end-to-end trace). After this spec ships, fold the spec content here and delete the spec per project-management convention.

## Safety / invariants

- **Approval gate is non-negotiable.** No action executes without a `status='approved'` row and a matching `approved_by/role`.
- **Role-gated approval.** Permissions matrix:
  | action_type | Approver |
  |---|---|
  | `customer_reply`, `customer_action`, `ticket_close` | owner OR admin |
  | `ticket_analysis_rescore` | owner OR admin (it's per-ticket data correction, not a system-wide change) |
  | `sonnet_prompt_new`, `sonnet_prompt_edit` | owner only |
  | `grader_prompt_edit`, `escalation_rule_fix` | owner only |
  | `brain_doc_edit`, `code_change` | owner only |
- **Visibility ≠ approval.** Both roles see all todos. Approval buttons are gated; non-approvers see a *"Needs owner access to approve"* indicator.
- **Drift detection.** Every execution worker re-fetches the latest ticket state and compares against `pre_exec_context`. If the customer replied between approval and execution, supersede silently and re-propose next pass.
- **One active group per ticket.** Reasoning pass skips tickets that already have a pending or approved group of todos.
- **Customer-facing immediate, system-level deferred.** Approving a `customer_reply` fires it within seconds via the event-triggered worker. Approving a `sonnet_prompt_edit` waits for the next 30-min routine tick. This keeps reply latency low while keeping system changes batched.
- **No silent retries on failure.** A `failed` todo stays failed and surfaces in the queue with the error; humans decide next step.
- **Rejection is the Claude-chat escape hatch.** Rejected todos do NOT auto-close the ticket. Dylan picks them up in conversation here.

## Completion criteria

- ⏳ Schema migration applied; `agent_todos` table exists with all columns + indexes.
- ⏳ Inngest function `agent-todo-routine` registered, cron + concurrency configured.
- ⏳ The 7 currently-escalated tickets each have a populated todo group after backfill.
- ⏳ `/dashboard/tickets/todos` list view renders, role-scoped bubble count works.
- ⏳ `/dashboard/tickets/todos/[id]` detail view renders all blocks (what happened, what we propose, linked todos, action preview, collapsed conversation).
- ⏳ Approve fires immediate execution for `customer_reply`; the customer sees the message within ~30s of click.
- ⏳ Approve queues `sonnet_prompt_new` for next routine tick; executed on tick.
- ⏳ Reject marks todo + ticket; doesn't auto-close ticket.
- ⏳ Customer-facing group execute → ticket auto-closes + unescalates + unassigns + system note added.
- ⏳ Brain pages written; spec content folded into `lifecycles/agent-todo-system.md`; this spec file deleted.

## Open questions

- **Bubble-count refresh cadence.** Real-time via supabase realtime, or poll every N seconds? Lean realtime if it's cheap.
- **Failed-todo replay.** Right now manually inspect + decide. If the failure rate stays high we may want a "retry" button on the detail view. Start without and revisit after first month of data.
- **Multi-routine coordination.** This spec assumes one routine. Future: CSAT-driven todos, sub-health-driven todos, etc. Should be additive — the routine name + reasoning logic differ, but the table + dashboard surface stays one.

## Related

[[../tables/tickets]] · [[../tables/ticket_messages]] · [[../tables/ticket_analyses]] · [[../tables/sonnet_prompts]] · [[../lifecycles/ticket-lifecycle]] · [[../lifecycles/ai-learning]] · [[../customer-voice]] · [[../operational-rules]] · [[../project-management]]
