/**
 * Inngest event worker — agent-todo-execute.
 *
 * Fires on `agent-todo/execute` (sent by POST /api/todos/[id]/approve on approval). Executes the
 * approved todo within seconds so customer replies don't wait.
 *
 * Handles every surviving agent_todo action type (box-escalation-triage P4): the customer-facing ones
 * (customer_reply, customer_action, ticket_close) plus ticket_analysis_rescore — the latter was the
 * retired Claude Code Routine's only DB-action survivor, now executed here. The box (escalation-triage
 * solver/skeptic) only PROPOSES; execution still gates on a human approval and runs here.
 *
 * See docs/brain/lifecycles/agent-todo-system.md.
 */
import { inngest } from "@/lib/inngest/client";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  driftCheck,
  executeCustomerTodo,
  maybeAutoCloseGroup,
} from "@/lib/agent-todos/execute";
import { isCustomerFacing, isInngestExecutable } from "@/lib/agent-todos/constants";
import type { AgentTodo } from "@/lib/agent-todos/types";

export const agentTodoExecute = inngest.createFunction(
  { id: "agent-todo-execute", retries: 1, triggers: [{ event: "agent-todo/execute" }] },
  async ({ event, step }) => {
    const { todo_id } = event.data as { todo_id: string };
    if (!todo_id) return { ok: false, reason: "missing todo_id" };

    const admin = createAdminClient();

    const todo = await step.run("load-todo", async () => {
      const { data } = await admin.from("agent_todos").select("*").eq("id", todo_id).single();
      return data as AgentTodo | null;
    });

    if (!todo) return { ok: false, reason: "todo not found" };
    if (todo.status !== "approved") return { ok: false, reason: `todo not approved (status=${todo.status})` };
    if (!isInngestExecutable(todo.action_type)) {
      return { ok: false, reason: `not an Inngest-executable action: ${todo.action_type}` };
    }

    // ── Drift check — re-fetch live ticket state; supersede if the customer replied since proposal.
    // Only customer-facing actions can go stale this way; a re-score isn't voided by a new inbound.
    const drift = isCustomerFacing(todo.action_type)
      ? await step.run("drift-check", () => driftCheck(admin, todo))
      : { drifted: false as const };
    if (drift.drifted) {
      await step.run("mark-superseded", async () => {
        await admin
          .from("agent_todos")
          .update({
            status: "superseded",
            execution_result: { ok: false, error: drift.reason },
            updated_at: new Date().toISOString(),
          })
          .eq("id", todo.id);
      });
      return { ok: false, reason: "superseded", detail: drift.reason };
    }

    // ── Execute.
    const result = await step.run("execute", () => executeCustomerTodo(admin, todo));

    await step.run("record-result", async () => {
      await admin
        .from("agent_todos")
        .update({
          status: result.ok ? "executed" : "failed",
          execution_result: result,
          executed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", todo.id);
    });

    if (!result.ok) {
      // No silent retry — a failed todo stays failed and surfaces in the queue.
      return { ok: false, reason: "execution failed", detail: result.error };
    }

    // ── Auto-closure: if this was the last customer-facing todo in the group.
    const closed = await step.run("maybe-auto-close", () =>
      maybeAutoCloseGroup(admin, { ...todo, status: "executed" }),
    );

    return { ok: true, executed: todo.action_type, ticket_closed: closed };
  },
);
