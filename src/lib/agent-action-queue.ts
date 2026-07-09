/**
 * agent-action-queue — the enqueue → worker-execute → poll spine for Sol's cheap-execution.
 *
 * Sol's box session is READ-ONLY. To mutate, she ENQUEUES a validated SonnetDecision here (her only
 * write is a bounded, schema-checked request row — she cannot express anything off the sanctioned
 * action menu). The deterministic execute-worker (builder-worker lane, write creds) CLAIMS the row
 * (atomic compare-and-set), runs it through `executeSonnetDecision` via [[tickets-mutate]]
 * `runTicketDecision` — the one executor with the 39 handlers + journeys/playbooks/workflows +
 * selective-clarify + verify + resolution ledger — and writes the VERIFIED result back. Sol
 * long-polls the row and crafts her reply from the REAL outcome (no blind promise).
 *
 * DRY RUN: a request marked `dry_run` runs with `ctx.sandbox=true` — every action is simulated and
 * any reply is stored as an internal draft, never sent. Full rehearsal on a real ticket, zero side
 * effects. See docs/brain (Sol cheap-execution) + the agent_action_requests migration.
 */
import { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

export type AgentActionStatus =
  | "pending" | "pending_condition" | "running" | "done" | "failed" | "expired";

/** A condition that must hold before a pending_condition row becomes runnable (#15 conditional actions). */
export interface TriggerCondition {
  /** e.g. "journey_complete" | "payment_method_valid" */
  type: string;
  [key: string]: unknown;
}

export interface AgentActionRequest {
  id: string;
  workspace_id: string;
  ticket_id: string;
  customer_id: string | null;
  direction_id: string | null;
  status: AgentActionStatus;
  decision: Record<string, unknown>;
  dry_run: boolean;
  trigger_condition: TriggerCondition | null;
  result: Record<string, unknown> | null;
  error: string | null;
  attempts: number;
  created_at: string;
  claimed_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  expires_at: string | null;
}

const nowIso = () => new Date().toISOString();

const ACTION_TYPES = new Set([
  "direct_action", "journey", "playbook", "workflow", "macro", "kb_response", "ai_response", "escalate",
]);

export interface DecisionValidation { ok: boolean; error?: string }

/**
 * Validate a decision against the sanctioned action surface — THE anti-hallucination boundary. The
 * known direct-action types come from `directActionHandlers` at runtime (zero drift with the executor).
 * This runs in the trusted CLI/worker (not the LLM), so a well-formed request is the only thing that
 * can ever land on the queue.
 */
export async function validateDecision(decision: unknown): Promise<DecisionValidation> {
  if (!decision || typeof decision !== "object") return { ok: false, error: "decision must be an object" };
  const d = decision as Record<string, unknown>;
  const at = d.action_type;
  if (typeof at !== "string" || !ACTION_TYPES.has(at)) {
    return { ok: false, error: `unknown action_type ${JSON.stringify(at)} (allowed: ${[...ACTION_TYPES].join(", ")})` };
  }
  if (at === "direct_action") {
    const actions = d.actions;
    if (!Array.isArray(actions) || actions.length === 0) {
      return { ok: false, error: "direct_action requires a non-empty actions[]" };
    }
    const { directActionHandlers } = await import("@/lib/action-executor");
    const known = new Set(Object.keys(directActionHandlers));
    for (const a of actions) {
      const t = (a as { type?: unknown })?.type;
      if (typeof t !== "string") return { ok: false, error: "each action needs a string 'type'" };
      if (!known.has(t)) return { ok: false, error: `unknown action type "${t}" — not in the executor's handler registry` };
    }
  }
  if ((at === "journey" || at === "playbook" || at === "workflow") && !d.handler_name) {
    return { ok: false, error: `${at} requires handler_name (the journey/playbook/workflow to run)` };
  }
  return { ok: true };
}

export interface EnqueueArgs {
  workspaceId: string;
  ticketId: string;
  customerId?: string | null;
  directionId?: string | null;
  decision: Record<string, unknown>;
  dryRun?: boolean;
  triggerCondition?: TriggerCondition | null;
  /** TTL for a conditional request (abandonment). */
  expiresAt?: string | null;
}

export interface EnqueueResult { ok: boolean; id?: string; status?: AgentActionStatus; error?: string }

/** Validate + insert an action request. Conditional (triggerCondition) → pending_condition, else pending. */
export async function enqueueActionRequest(admin: Admin, args: EnqueueArgs): Promise<EnqueueResult> {
  const v = await validateDecision(args.decision);
  if (!v.ok) return { ok: false, error: v.error };
  const status: AgentActionStatus = args.triggerCondition ? "pending_condition" : "pending";
  const { data, error } = await admin
    .from("agent_action_requests")
    .insert({
      workspace_id: args.workspaceId,
      ticket_id: args.ticketId,
      customer_id: args.customerId ?? null,
      direction_id: args.directionId ?? null,
      status,
      decision: args.decision,
      dry_run: args.dryRun ?? false,
      trigger_condition: args.triggerCondition ?? null,
      expires_at: args.expiresAt ?? null,
    })
    .select("id, status")
    .single();
  if (error) return { ok: false, error: error.message };
  return { ok: true, id: (data as { id: string }).id, status: (data as { status: AgentActionStatus }).status };
}

/** Atomically claim the next runnable pending row (compare-and-set on status). Null when queue empty. */
export async function claimNextPending(admin: Admin): Promise<AgentActionRequest | null> {
  const { data: candidates } = await admin
    .from("agent_action_requests")
    .select("id, attempts")
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(5);
  for (const c of (candidates as Array<{ id: string; attempts: number }> | null) || []) {
    const { data: claimed } = await admin
      .from("agent_action_requests")
      .update({ status: "running", claimed_at: nowIso(), started_at: nowIso(), attempts: (c.attempts || 0) + 1 })
      .eq("id", c.id)
      .eq("status", "pending") // lost the race → another worker claimed it
      .select("*")
      .maybeSingle();
    if (claimed) return claimed as AgentActionRequest;
  }
  return null;
}

async function completeRequest(admin: Admin, id: string, result: Record<string, unknown>): Promise<void> {
  await admin.from("agent_action_requests")
    .update({ status: "done", result, completed_at: nowIso() })
    .eq("id", id);
}

async function failRequest(admin: Admin, id: string, error: string, result?: Record<string, unknown>): Promise<void> {
  await admin.from("agent_action_requests")
    .update({ status: "failed", error: error.slice(0, 2000), result: result ?? null, completed_at: nowIso() })
    .eq("id", id);
}

/**
 * The action types the executor runs as a MUTATION here. A direct_action is action-only: the queue
 * runs the handlers + verifies, but NEVER sends a customer message (Sol composes the sole reply from
 * the real result). Journeys/workflows are customer touches and stay on Sol's Direction path — she
 * does not enqueue them.
 */
const MUTATION_ONLY = new Set(["direct_action"]);

/**
 * Mirror each executed action as a ticket_required_outcomes row reflecting the REAL terminal status —
 * `verified` on a clean run, `failed` when the executor escalated or threw. This is the belt on Sol's
 * suspenders: the send-guard ([[sol-outcome-claim-guard]]) blocks a reply that CLAIMS a money/state
 * outcome (refund, coupon, cancel, pause, …) whose row isn't verified, so a model that wrongly claims
 * success on a failed action is still caught. Tolerant by design: the status comes from the executor's
 * OWN handler result (the real Appstle/DB call), never the honor step's brittle expected_db_state
 * exact-match that false-failed Sofia's Oct-1-vs-Oct-2 renewal.
 */
async function recordOutcomeRows(
  admin: Admin,
  req: AgentActionRequest,
  ok: boolean,
  reason: string | null,
): Promise<void> {
  // A dry-run is a REHEARSAL — it must never touch the real outcome ledger. The simulated result
  // lives only on the request row's `result`; the ticket's ticket_required_outcomes stay untouched.
  if (req.dry_run) return;
  const decision = req.decision as { action_type?: unknown; actions?: unknown };
  if (decision.action_type !== "direct_action" || !Array.isArray(decision.actions)) return;
  const kinds = decision.actions
    .map((a) => (a && typeof a === "object" ? (a as { type?: unknown }).type : null))
    .filter((t): t is string => typeof t === "string" && t.length > 0);
  if (kinds.length === 0) return;
  try {
    const { writeRequiredOutcomes, markOutcomeVerified, markOutcomeFailed } = await import(
      "@/lib/ticket-required-outcomes"
    );
    const rows = await writeRequiredOutcomes(admin, {
      workspace_id: req.workspace_id,
      ticket_id: req.ticket_id,
      direction_id: req.direction_id,
      authored_by: "sol_queue_execute",
      items: kinds.map((kind) => ({ kind, description: `Sol enqueue-executed ${kind}` })),
    });
    for (const row of rows) {
      if (ok) await markOutcomeVerified(admin, { id: row.id, workspace_id: req.workspace_id, from: "pending" });
      else
        await markOutcomeFailed(admin, {
          id: row.id,
          workspace_id: req.workspace_id,
          from: "pending",
          reason: reason ?? "queue execution did not complete cleanly",
        });
    }
  } catch {
    // The outcome-row audit is belt-and-suspenders — never fail the request because it couldn't write.
  }
}

/**
 * Run a claimed request through the production executor and write the verified result back. dry_run →
 * sandbox=true (simulate + draft, no mutation, no send). A direct_action runs ACTION-ONLY (its
 * response_message is blanked so the queue never sends a customer message — Sol owns the reply). On a
 * thrown error OR an escalation the request is failed/flagged — NO false success reaches the customer
 * (the whole point of verify-before-reply); Sol reads the real result on her poll and adapts.
 */
export async function executeActionRequest(admin: Admin, req: AgentActionRequest): Promise<void> {
  try {
    const decision = { ...(req.decision as Record<string, unknown>) };
    // Action-only: a direct_action mutation never sends a customer message from the queue. Sol's
    // first_reply (composed from this result) is the sole customer touch — no double-send.
    if (MUTATION_ONLY.has(decision.action_type as string)) decision.response_message = "";
    const { runTicketDecision } = await import("@/lib/tickets-mutate");
    const r = await runTicketDecision(admin, {
      workspaceId: req.workspace_id,
      ticketId: req.ticket_id,
      decision: decision as unknown as Parameters<typeof runTicketDecision>[1]["decision"],
      sandbox: req.dry_run ? true : undefined, // dry-run forces sandbox; else executor resolves workspace mode
      auditPrefix: req.dry_run ? "[sol:dry-run]" : "[sol:execute]",
    });
    // Tolerant success: a clean run that did NOT escalate. The executor's own verify-before-send
    // (handleDirectAction) already escalates on a real action/verify failure, so `!escalated` is the
    // real signal — not a brittle DB predicate. Sol reads `result` (incl. `ok`) on her poll.
    const ok = !r.escalated;
    const result = { ...r, ok } as Record<string, unknown>;
    await recordOutcomeRows(admin, req, ok, ok ? null : "executor escalated (action or verify failed)");
    // Record done even when escalated — the run COMPLETED; `result.ok=false` tells Sol it didn't land
    // so she adapts (retry / journey / honest "couldn't do that" reply) instead of promising it.
    await completeRequest(admin, req.id, result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await recordOutcomeRows(admin, req, false, msg);
    await failRequest(admin, req.id, msg);
  }
}

/** Read a single request (Sol's poll). */
export async function getRequest(admin: Admin, id: string): Promise<AgentActionRequest | null> {
  const { data } = await admin.from("agent_action_requests").select("*").eq("id", id).maybeSingle();
  return (data as AgentActionRequest) ?? null;
}

const TERMINAL = new Set<AgentActionStatus>(["done", "failed", "expired"]);

/**
 * Long-poll a request until it reaches a terminal status or the timeout lapses. Used by Sol's
 * poll_action_result box tool so she makes one blocking call, not a busy loop. Server-side sleep in a
 * short-lived CLI — fine.
 */
export async function waitForTerminal(
  admin: Admin,
  id: string,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<AgentActionRequest | null> {
  const timeoutMs = opts.timeoutMs ?? 20000;
  const intervalMs = opts.intervalMs ?? 750;
  const deadline = Date.now() + timeoutMs;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const req = await getRequest(admin, id);
    if (!req) return null;
    if (TERMINAL.has(req.status)) return req;
    if (Date.now() >= deadline) return req; // return current (non-terminal) state on timeout
    await new Promise((res) => setTimeout(res, intervalMs));
  }
}

/**
 * Drain runnable pending rows once (the execute-worker's per-tick body). Claims + executes up to
 * `max` rows. Returns how many it processed. Deterministic; safe to call on an interval.
 */
export async function drainPendingOnce(admin: Admin, max = 10): Promise<number> {
  let n = 0;
  for (; n < max; n++) {
    const req = await claimNextPending(admin);
    if (!req) break;
    await executeActionRequest(admin, req);
  }
  return n;
}
