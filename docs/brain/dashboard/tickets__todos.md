# dashboard/tickets/todos

The To-Do approval queue — the primary action surface for the Agent To-Do system. Dylan + Zach review proposed actions here and approve/reject.

**Route:** `/dashboard/tickets/todos` · **File:** `src/app/dashboard/tickets/todos/page.tsx` · **API:** `GET /api/todos`
**Sidebar:** Tickets → **To Do**, with a role-scoped bubble count (`approvable_count`).

## List view
- **Group rendering:** todos sharing a `group_id` collapse into one row (expand with the ▸ N toggle to see each todo).
- **Columns:** urgency dot · customer name · summary (links to detail) · action-type badges · proposed_at · approval state.
- **Filters:** status (default `pending`), urgency, action_type, source, and an "Items I can approve" toggle (`mine=true`).

## Bubble count = items the current viewer can approve
- Dylan (owner): all pending.
- Zach (admin): pending `customer_reply`/`customer_action`/`ticket_close`/`ticket_analysis_rescore`.
- Computed server-side in `GET /api/todos` (`approvable_count`) via `canApprove(role, action_type)`.

## Visibility ≠ approval
Both roles see every todo, including owner-only system todos. Rows the viewer can't approve render *"Needs owner access to approve"* instead of buttons (gate on `can_approve`, set per-row by the API).

## Approve / reject
Buttons live on the detail page ([[tickets__todos__id]]). Approve → `POST /api/todos/[id]/approve` (fires the Inngest worker for customer-facing, wakes the Routine for system-level). Reject → `POST /api/todos/[id]/reject` (ticket NOT auto-closed; group-wide rejection escalates the ticket to the **owner** and tags `todo:rejected`).

## Related
[[tickets__todos__id]] · [[tickets__escalated]] · [[branches]] · [[../tables/agent_todos]] · [[../inngest/agent-todo-routine]] · [[../lifecycles/agent-todo-system]]
