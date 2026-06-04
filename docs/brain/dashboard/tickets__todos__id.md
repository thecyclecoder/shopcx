# dashboard/tickets/todos/[id]

Detail + approval view for a single todo (and its group).

**Route:** `/dashboard/tickets/todos/[id]` · **File:** `src/app/dashboard/tickets/todos/[id]/page.tsx` · **API:** `GET /api/todos/[id]`

## Blocks
- **Header** — customer name, LTV (sum of order `total_cents`), source ticket subject + short id (links to [[tickets__id]]), escalation reason.
- **"What happened"** — `context_what_happened` (plain English, 1 paragraph).
- **"What we propose"** — `context_what_we_propose` (paragraph or bullets).
- **Proposed actions panel** — every todo in the `group_id`. Per row: action-type badge, summary, status, and approve/reject buttons inline — or a greyed *"Needs owner access to approve"* pill when `can_approve` is false. Non-pending rows show approver name + role + time (and PR card / error when present).
- **Action preview** (per `action_type`):
  - `customer_reply` → the HTML message rendered inline (read-only, exactly what the customer sees).
  - `customer_action` → `diff_summary` + the structured `actions` JSON.
  - `ticket_analysis_rescore` → new score + summary.
  - `sonnet_prompt_*` → title/category + rule content.
  - `brain_doc_edit`/`code_change`/`grader_prompt_edit`/`escalation_rule_fix` → the unified diff (dark code block) + file path.
- **PR card** — when `execution_result.pr_url` is set (executed brain/code todos): branch + "Open PR in GitHub", with a `merged` marker after the cleanup pass stamps `merged_at`.
- **Conversation appendix** — collapsed by default; expands the full `ticket_messages` log for verification.

## Approve / reject
- Approve → `POST /api/todos/[id]/approve`. Role-gated by `action_type`. Customer-facing → `inngest.send('agent-todo/execute')`; system-level → wakes the Routine (`AGENT_TODO_ROUTINE_TRIGGER_URL`) or waits for the hourly tick.
- Reject → `POST /api/todos/[id]/reject` (optional reason). Ticket stays escalated. Group-wide rejection → `escalated_to = owner` + tag `todo:rejected`.

## Related
[[tickets__todos]] · [[tickets__escalated]] · [[branches]] · [[../tables/agent_todos]] · [[../inngest/agent-todo-routine]] · [[../lifecycles/agent-todo-system]]
