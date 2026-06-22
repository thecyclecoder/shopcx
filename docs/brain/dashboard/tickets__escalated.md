# dashboard/tickets/escalated

Observability surface for the **whole** escalation pipeline. Under the Agent To-Do model, escalations route to the routine (`escalated_to = NULL`) — so the old `escalated_to = me` filter is wrong. This view shows every escalated ticket and where it sits in the pipeline. The action surface is [[tickets__todos]]; this is the at-a-glance health view.

**Route:** `/dashboard/tickets/escalated` · **File:** `src/app/dashboard/tickets/escalated/page.tsx` · **API:** `GET /api/escalated`
**Sidebar:** Tickets → **Escalated**.

## Behavior
- Shows **every** ticket where `escalated_at IS NOT NULL`, sorted by `escalated_at desc` (no `escalated_to=me` filter).
- **"Routed to" badge** per row, derived from the ticket's `agent_todos` group + `escalated_to`:
  - `🤖 AI Routine` (gray) — escalated to the routine (`escalated_to = NULL`), no todo group yet. Every system escalation now defaults here ([[../specs/escalate-to-routine-by-default]]); a human can also pick "🤖 AI Routine" in the ticket escalate dropdown.
  - `todo:pending` (amber) — group has pending todos.
  - `todo:approved` (blue) — todos approved, awaiting execution.
  - `rejected → {first_name}` (red) — ≥1 rejected todo, `escalated_to` set to that user.
  - `assigned → {first_name}` (zinc, legacy) — pre-routine human assignment, no todos.

## Filter chips (counts in parens)
`All` · `Routine pending` · `Awaiting approval` · `Approved, pending execute` · `Rejected → me` · `Assigned to human (legacy)`.
**Default chip:** `Awaiting approval` if it has rows, else `All`.

## Sidebar bubble — new meaning
- **Old:** count of `escalated_to = me` tickets.
- **New:** the **"Rejected → me"** pile — tickets that need human thinking (a todo was rejected and the ticket landed in the owner's inbox). Distinct from the To-Do bubble: To-Do = "approve these"; Escalated = "think about these."

The legacy "Escalations" sub-tree (Open/Pending/Closed by `escalation_mine`) remains in the sidebar but is mostly empty under the new model — humans only appear in `escalated_to` after rejecting a todo.

## Related
[[tickets__todos]] · [[tickets__todos__id]] · [[../tables/agent_todos]] · [[../inngest/agent-todo-routine]] · [[../lifecycles/agent-todo-system]]
