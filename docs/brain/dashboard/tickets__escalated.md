# dashboard/tickets/escalated

Observability surface for the **whole** escalation pipeline. Under the Agent To-Do model, escalations route to the routine (`escalated_to = NULL`) — so the old `escalated_to = me` filter is wrong. This view shows every escalated ticket and where it sits in the pipeline. The action surface is [[tickets__todos]]; this is the at-a-glance health view.

**Route:** `/dashboard/tickets/escalated` · **File:** `src/app/dashboard/tickets/escalated/page.tsx` · **API:** `GET /api/escalated`
**Sidebar:** Tickets → **Escalated**.

## Behavior
- Shows every **open** (non-terminal) ticket where `escalated_at IS NOT NULL`, sorted by `escalated_at desc` (no `escalated_to=me` filter). The query also excludes `status IN (closed, resolved, archived)` — escalation is an open-state concept, so a resolved ticket can never surface here even if a stale flag lingers. The close/resolve write paths clear the flags directly; this filter is belt-and-suspenders. See [[../specs/clear-escalation-on-resolve]].
- **"Routed to" badge** per row, derived from the ticket's `agent_todos` group + `escalated_to`:
  - `routine` (gray) — escalated, no todo group yet.
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
