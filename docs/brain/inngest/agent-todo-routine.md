# inngest/agent-todo-routine

The Agent To-Do system runs across **two runtimes**. This page covers both the **Claude Code Routine** (reasoning + system-level execution) and the **Inngest event worker** (`agent-todo-execute`, customer-facing immediate execution). End-to-end trace: [[../lifecycles/agent-todo-system]].

| Runtime | Role | Where | Cadence |
|---|---|---|---|
| **Claude Code Routine** `agent-todo-routine` | Reasoning pass + system-level execution (sonnet_prompt inserts, brain/code PRs) + PR cleanup | Anthropic-managed cloud (clones repo, has git + `gh`) | Hourly (+ API trigger) |
| **Inngest worker** `agent-todo-execute` | Customer-facing execution: `customer_reply`, `customer_action`, `ticket_close` | Vercel serverless | Event-triggered |

**Why split:** customer replies can't wait an hour after approval (Inngest fires in seconds); code/brain changes need real git access (only the Routine has it).

## The Inngest worker — `agent-todo-execute`

- **File:** `src/lib/inngest/agent-todo-execute.ts` (registered in `src/app/api/inngest/route.ts`).
- **Trigger:** event `agent-todo/execute` `{ todo_id }`, sent by `POST /api/todos/[id]/approve` for customer-facing action types.
- **Retries:** 1 (no silent retry — a failed todo stays failed and surfaces in the queue).
- **Steps:**
  1. `load-todo` — must be `status='approved'` and a customer-facing type.
  2. `drift-check` — `driftCheck()` compares `pre_exec_context.latest_inbound_message_id` to live. Drift → `status='superseded'`, stop.
  3. `execute` — `executeCustomerTodo()` dispatches:
     - `customer_reply` → insert outbound `ticket_messages` + deliver (email, or chat→email when idle), mirroring `send()` in [[unified-ticket-handler]].
     - `customer_action` → each action in `payload.actions` through `directActionHandlers` ([[../libraries/action-executor]]), with internal-UUID→Shopify contract-id resolution.
     - `ticket_close` → close + unescalate.
  4. `record-result` — `status='executed'|'failed'` + `execution_result`.
  5. `maybe-auto-close` — when the last customer-facing todo in the group executes, close + unescalate + unassign the ticket and add a `[System] Resolved via To-Do system` note.

Execution lib: `src/lib/agent-todos/execute.ts`.

## The Claude Code Routine — `agent-todo-routine`

Configured at `claude.ai/code/routines`. Per-tick entry point: `npx tsx scripts/agent-todo-routine-run.ts` (the Routine sets cwd to the cloned repo root). Stateless between runs — all state lives in [[../tables/agent_todos]].

**Passes (in order):**
1. **Reasoning** — `runReasoningPass()` (`src/lib/agent-todos/reasoning.ts`). For each escalated ticket with no active group: gather context (messages, customer, subs, orders, latest [[../tables/ticket_analyses]]), reason with Opus (`OPUS_MODEL`, tool-use `propose_todos`), write a `pending` group. Decision branches: `no_action`/`customer_fix`/`system_gap`/`analysis_gap`/`escalation_false_positive`.
2. **System-level execution** — approved system-level todos via `executeSystemTodo()` (`src/lib/agent-todos/system-execute.ts`): DB writes for sonnet_prompt / analysis_rescore; CI-gated PRs (`npx tsc --noEmit` → branch → commit → push → `gh pr create`) for brain/code/grader/escalation_rule. **CI gate runs before push; broken branches never reach GitHub.**
3. **PR cleanup** — reconcile merge status of executed PR todos (merged → stamp `execution_result.merged_at`; closed-without-merge → `status='rejected'`, `reject_reason='pr_closed_without_merge'`).

### Setup (one-time, per workspace)
- Repo `shopcx` configured on the routine; default-branch clone at run start.
- Env vars pasted into the routine environment via `npx tsx scripts/print-routine-env.ts | pbcopy` (Anthropic has no env API — this is the workaround). One shared environment "shopcx-production" reused across routines.
- Branch push policy: `claude/`-prefixed only; "Allow unrestricted branch pushes" OFF. **No direct-to-main from the routine.**
- Model: Opus. Triggers: hourly schedule + API endpoint (on-demand wake from the approve API on system-level todos — `AGENT_TODO_ROUTINE_TRIGGER_URL`).
- Verify the Claude GitHub App is installed on `thecyclecoder/shopcx` with `claude/`-branch push + PR-open permission.

## Safety invariants

- NEVER execute without `status='approved'`. NEVER auto-retry. NEVER approve own proposals.
- Drift check immediately before customer-facing execution; expired approvals supersede silently.
- One active group per ticket.
- `code_change` never auto-merges (hard-coded); `brain_doc_edit` only with `payload.auto_merge === true`.

## Related

[[../tables/agent_todos]] · [[unified-ticket-handler]] · [[../libraries/action-executor]] · [[../dashboard/tickets__todos]] · [[../dashboard/branches]] · [[../lifecycles/agent-todo-system]] · [[ticket-analysis-cron]] · [[sonnet-prompt-auto-review]]
