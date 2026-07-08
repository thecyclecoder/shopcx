/**
 * cs-director — the Phase-2 executor that materializes June's (💬 CS Director) verdicts into real
 * actions ([[../../docs/brain/specs/cs-director-call-phase-2-executor-fires-june-verdicts.md]]).
 *
 * The runner (`runCsDirectorCallJob` in scripts/builder-worker.ts) is Phase 1 of the CS Director hard-
 * call lane — it reads the ticket / triage_runs / customer slice, dispatches the Max session, and
 * records the returned verdict to [[../../docs/brain/tables/director_activity.md]] as the AUDIT trail
 * (`action_kind='cs_director_call'`, `director_function='cs'`). Everything after that was a stub the
 * derived-from ticket (115350d5 — the portal changedate escalation where June ruled
 * `approve_remedy: change_next_date -> 2026-10-06` at 06:35 and NOTHING fired until a human ran it by
 * hand) exposed. `applyBoxCsDirectorCall` is the deterministic mutator that closes that gap — the
 * SAME shape as `applyBoxDeployReview` in [[deploy-guardian]] (Reva's Phase-3 mutator): the box session
 * decides read-only + returns a typed verdict; this writer routes it to the per-decision handler.
 *
 * PHASE 2 (this file): the `approve_remedy` handler NOW EXECUTES.
 *   - `handleApproveRemedy` builds a `direct_action` `SonnetDecision` from the verdict's `RemedyPlan`
 *     (`action_type` + `payload`) and fires it through `executeSonnetDecision` (the same real
 *     executor prod uses — see [[../../docs/brain/recipes/run-orchestrator-action]]) with a NO-OP send
 *     fn so the executor does NOT deliver ANY customer message itself. If the executor returns without
 *     escalation (the action succeeded + verify passed), we THEN deliver the RemedyPlan's customer
 *     message via `deliverTicketMessage`. A failed action never sends a customer message — the
 *     mutator returns `needs_attention:true` and the runner parks the job so a human can eyeball.
 *   - `handleAuthorSpec` + `handleEscalateFounder` remain Phase-3 stubs (routing contract exists;
 *     the actual mutations land in Phase 3).
 *
 * PHASE 2 INVARIANT (execute-then-message, from the derived-from ticket): the customer message is
 * NEVER sent before the action returns success. This is the whole point of the executor — a failed
 * remedy that promised a fix but didn't ship is the exact failure mode the ticket exposed. We control
 * the ordering by passing a no-op `send` to `executeSonnetDecision`; the sole delivery site is the
 * `deliverTicketMessage` call AFTER a clean executor return.
 *
 * See [[../../docs/brain/libraries/cs-director]] · [[deploy-guardian]] ·
 * [[../../docs/brain/tables/director_activity]].
 */
import type { createAdminClient } from "@/lib/supabase/admin";
import type { ActionContext, ActionParams, SonnetDecision } from "@/lib/action-executor";

type Admin = ReturnType<typeof createAdminClient>;

export type CsDirectorDecision = "approve_remedy" | "author_spec" | "escalate_founder";

/**
 * The verdict shape the CS Director emits — mirrors `CsDirectorVerdict` in
 * scripts/builder-worker.ts (kept structurally compatible so the runner can pass its normalized
 * verdict verbatim). The runner is the sole normalization site (`normalizeCsDirectorVerdict`).
 *
 * - `remedy` — the AUTO-APPLY RemedyPlan on `approve_remedy` (Phase 2 fires it through
 *   `executeSonnetDecision`). Shape: `{ action_type, payload?, customer_message?, summary?, … }`.
 * - `spec_seed` — the SpecSeed on `author_spec` (Phase 3 hands it to the specs SDK).
 * - `recommended_remedy` — a suggestion the CEO card carries on `escalate_founder` (kept
 *   distinct from `remedy` so a mis-typed verdict cannot silently upgrade a suggestion into an
 *   execution).
 */
export interface CsDirectorVerdictInput {
  decision: CsDirectorDecision;
  reasoning: string;
  remedy?: Record<string, unknown>;
  spec_seed?: Record<string, unknown>;
  recommended_remedy?: Record<string, unknown>;
}

/**
 * The mutator returns a structured result — never throws — so the runner can surface what happened
 * on the agent_jobs `log_tail` (same shape `ApplyBoxDeployReviewResult` uses in [[deploy-guardian]]).
 *
 * - `ok` — the scaffold routed cleanly (even a no-op decision counts as ok — the audit row is the
 *   primary trail; a routing miss is only a real failure if the DB/import layer itself threw).
 * - `handler` — which per-decision branch was taken (`approve_remedy` / `author_spec` /
 *   `escalate_founder` / `noop`). Kept on the result so the runner's log_tail names it.
 * - `reason` — populated when `ok:false` (a job lookup miss / a thrown catch, OR a Phase-2 remedy
 *   action that escalated). Follows the same opaque-string shape as deploy-guardian's result reasons.
 * - `needs_attention` — Phase 2: the remedy action failed (executor escalated / plan malformed / no
 *   ticket resolved). The runner MUST park the job `needs_attention` instead of `completed` so a
 *   human eyeballs the `log_tail` (the customer never got a "we've fixed it" message we didn't back).
 * - `error` — the machine-readable line the runner writes to `agent_jobs.error` when
 *   `needs_attention` is true (mirrors what `update(jobId, { status:'needs_attention', error })` uses
 *   elsewhere in the worker).
 * - `message_delivered` — Phase 2: true iff a customer-facing message was delivered via
 *   `deliverTicketMessage` after the executor returned clean (verification bullet: "the customer
 *   message is sent only after the remedy action returns success"). Surfaced so the runner's
 *   `log_tail` reflects whether a customer heard back.
 */
export interface ApplyBoxCsDirectorCallResult {
  ok: boolean;
  handler?: "approve_remedy" | "author_spec" | "escalate_founder" | "noop";
  reason?: string;
  needs_attention?: boolean;
  error?: string;
  message_delivered?: boolean;
}

// ── Pure planners (unit-tested) ────────────────────────────────────────────────────────────────

/**
 * A normalized executable plan derived from June's RemedyPlan (`verdict.remedy`). Kept intentionally
 * small — `actionType` maps 1:1 to a `directActionHandlers` key (e.g. `change_next_date` →
 * `subscriptionUpdateNextBillingDate` under the hood), and `actionParams` flows straight into the
 * `SonnetDecision.actions[0]` bag alongside `type`. The customer message is separated from the plan
 * so the ordering invariant (execute → THEN message) is enforced by the caller, not smuggled inside a
 * `response_message` field the executor would deliver on our behalf.
 */
export interface RemedyExecutionPlan {
  actionType: string;
  actionParams: Record<string, unknown>;
  customerMessage: string | null;
}

/**
 * Extract the customer-facing message from a RemedyPlan. The RemedyPlan shape is `Record<string,
 * unknown>` (the formal type lands alongside this executor), so we check the plausible field names
 * an author would use. `customer_message` is the canonical form (aligns with the ticket-improve
 * plan-executor's response shape); `response_message` / `message` / `customer_reply` are accepted
 * fallbacks so a slightly-off verdict still delivers what June wanted the customer to hear.
 */
export function extractRemedyCustomerMessage(remedy: Record<string, unknown>): string | null {
  for (const key of ["customer_message", "response_message", "message", "customer_reply"]) {
    const value = remedy[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

/**
 * Plan the executor's next step from June's RemedyPlan. `ok:false` means the plan is malformed and
 * the executor MUST park the job `needs_attention` without touching the customer — no action
 * signature to fire against, no message to deliver honestly. Pure so the test suite can exercise
 * every branch without a Supabase mock.
 */
export function planRemedyExecution(
  remedy: Record<string, unknown> | undefined | null,
): { ok: true; plan: RemedyExecutionPlan } | { ok: false; reason: string } {
  if (!remedy || typeof remedy !== "object" || Array.isArray(remedy)) {
    return { ok: false, reason: "remedy_missing" };
  }
  const actionTypeRaw = remedy.action_type;
  const actionType = typeof actionTypeRaw === "string" ? actionTypeRaw.trim() : "";
  if (!actionType) return { ok: false, reason: "remedy_missing_action_type" };
  const payload =
    remedy.payload && typeof remedy.payload === "object" && !Array.isArray(remedy.payload)
      ? (remedy.payload as Record<string, unknown>)
      : {};
  const customerMessage = extractRemedyCustomerMessage(remedy);
  return { ok: true, plan: { actionType, actionParams: payload, customerMessage } };
}

/**
 * Build the `SonnetDecision` we hand to `executeSonnetDecision`. Always `action_type:'direct_action'`
 * (the RemedyPlan is a single typed commerce action, e.g. `change_next_date` /
 * `subscriptionUpdateNextBillingDate` / `apply_coupon`); NEVER carries `response_message` (the
 * customer message is delivered AFTER the executor returns success, by `deliverTicketMessage`, not
 * by the executor's own send path — see the execute-then-message invariant in the file header).
 * Pure so the test suite can assert the exact shape.
 */
export function buildRemedySonnetDecision(
  plan: RemedyExecutionPlan,
  reasoning: string,
): SonnetDecision {
  const { actionType, actionParams } = plan;
  const params: ActionParams = { type: actionType, ...(actionParams as Partial<ActionParams>) } as ActionParams;
  return {
    reasoning: reasoning?.trim() || "cs-director approve_remedy",
    action_type: "direct_action",
    actions: [params],
    // NO response_message — we own delivery. Setting response_message here would let
    // executeSonnetDecision deliver via our no-op send fn (a silent drop, but still a foot-gun); the
    // Phase-2 executor's contract is explicit: message flows through deliverTicketMessage AFTER
    // executor success, never through the executor's own send.
  };
}

// ── Injectable dependency surface (real defaults + test overrides) ─────────────────────────────

/**
 * The subset of concrete calls `handleApproveRemedy` needs to execute the remedy. Injected so the
 * ordering + failure invariants can be exercised without booting the full action-executor / ticket-
 * delivery surface in unit tests. Defaults resolve to the real imports at first call (dynamic imports
 * mirror the runner's own pattern in scripts/builder-worker.ts so a tsc pass on this module doesn't
 * drag in the action-executor's transitive deps).
 */
export interface ApproveRemedyDeps {
  loadTicketFacts: (
    admin: Admin,
    ticketId: string,
  ) => Promise<{ customer_id: string | null; channel: string | null } | null>;
  loadWorkspaceSandbox: (admin: Admin, workspaceId: string) => Promise<boolean>;
  runExecutor: (
    ctx: ActionContext,
    decision: SonnetDecision,
    send: (msg: string, sandbox: boolean) => Promise<void>,
    sysNote: (msg: string) => Promise<void>,
  ) => Promise<{ messageSent: boolean; escalated: boolean; closed: boolean; statusManaged: boolean }>;
  deliverMessage: (
    admin: Admin,
    workspaceId: string,
    ticketId: string,
    channel: string,
    message: string,
    sandbox: boolean,
  ) => Promise<void>;
}

async function defaultLoadTicketFacts(
  admin: Admin,
  ticketId: string,
): Promise<{ customer_id: string | null; channel: string | null } | null> {
  const { data } = await admin
    .from("tickets")
    .select("customer_id, channel")
    .eq("id", ticketId)
    .maybeSingle();
  if (!data) return null;
  const row = data as { customer_id: string | null; channel: string | null };
  return { customer_id: row.customer_id ?? null, channel: row.channel ?? null };
}

async function defaultLoadWorkspaceSandbox(admin: Admin, workspaceId: string): Promise<boolean> {
  const { data } = await admin
    .from("workspaces")
    .select("sandbox_mode")
    .eq("id", workspaceId)
    .maybeSingle();
  return (data as { sandbox_mode?: boolean } | null)?.sandbox_mode === true;
}

async function defaultRunExecutor(
  ctx: ActionContext,
  decision: SonnetDecision,
  send: (msg: string, sandbox: boolean) => Promise<void>,
  sysNote: (msg: string) => Promise<void>,
): Promise<{ messageSent: boolean; escalated: boolean; closed: boolean; statusManaged: boolean }> {
  const { executeSonnetDecision } = await import("@/lib/action-executor");
  return executeSonnetDecision(ctx, decision, null, send, sysNote);
}

async function defaultDeliverMessage(
  admin: Admin,
  workspaceId: string,
  ticketId: string,
  channel: string,
  message: string,
  sandbox: boolean,
): Promise<void> {
  const { deliverTicketMessage } = await import("@/lib/ticket-delivery");
  await deliverTicketMessage(admin, workspaceId, ticketId, channel, message, sandbox);
}

const defaultApproveRemedyDeps: ApproveRemedyDeps = {
  loadTicketFacts: defaultLoadTicketFacts,
  loadWorkspaceSandbox: defaultLoadWorkspaceSandbox,
  runExecutor: defaultRunExecutor,
  deliverMessage: defaultDeliverMessage,
};

// ── Handlers ───────────────────────────────────────────────────────────────────────────────────

/**
 * Phase 2 executor for `approve_remedy` (docs/brain/specs/cs-director-call-phase-2-executor-fires-
 * june-verdicts.md § Phase 2). Runs the RemedyPlan through `executeSonnetDecision` (the same real
 * executor prod uses — see [[../../docs/brain/recipes/run-orchestrator-action]]) and delivers the
 * customer message via `deliverTicketMessage` ONLY AFTER the executor returns without escalation.
 *
 * Execute-then-message invariant (from the derived-from ticket 115350d5): the customer message is
 * never sent before the action returns success. Enforced by (a) not passing `response_message` on the
 * `SonnetDecision`, so the executor has nothing to deliver via its own send path; (b) passing a NO-OP
 * `send` fn so any executor-internal message (verify-failure holding text, escalate holding text) is
 * SUPPRESSED; (c) calling `deliverTicketMessage` OURSELVES only on a clean executor return. A failed
 * action returns `needs_attention:true` → the runner parks the job so a human sees WHY.
 *
 * Defensive fail-safes:
 *  - Missing/malformed remedy → `needs_attention` (no plan to fire against).
 *  - Missing ticket_id / job.instructions unparseable → `needs_attention` (can't resolve the
 *    customer + channel; delivering blind would violate the ordering invariant differently — no
 *    read-time customer, no promise to deliver).
 *  - Executor threw / `escalated=true` on return → `needs_attention`, NO customer message.
 *
 * Never throws — all failures return a structured result so the runner logs it on `log_tail` and
 * decides `needs_attention` vs `completed` from the flag.
 */
async function handleApproveRemedy(
  admin: Admin,
  jobId: string,
  workspaceId: string,
  verdict: CsDirectorVerdictInput,
  deps: ApproveRemedyDeps = defaultApproveRemedyDeps,
): Promise<ApplyBoxCsDirectorCallResult> {
  const tag = `[cs-director:${jobId.slice(0, 8)}]`;
  try {
    // 1. Plan the RemedyPlan → executable shape. A missing action_type means the LLM did not name a
    //    concrete commerce action; we can't fire anything, and delivering a "we did X" message would
    //    be the exact false-promise class the derived-from ticket surfaced.
    const planned = planRemedyExecution(verdict.remedy);
    if (!planned.ok) {
      const error = `approve_remedy: remedy plan malformed (${planned.reason}) — no action fired, no customer message sent`;
      console.warn(`${tag} ${error}`);
      return {
        ok: false,
        handler: "approve_remedy",
        needs_attention: true,
        reason: planned.reason,
        error,
      };
    }
    const { actionType, customerMessage } = planned.plan;

    // 2. Resolve the ticket from job.instructions (same shape the runner reads at Phase 1). We look
    //    it up here instead of taking it as a parameter to keep the applyBoxCsDirectorCall signature
    //    identical to applyBoxDeployReview — one Admin + jobId + typed verdict, mirrors the reva
    //    contract.
    const { data: jobRow } = await admin
      .from("agent_jobs")
      .select("instructions")
      .eq("id", jobId)
      .maybeSingle();
    let ticketId: string | null = null;
    if (jobRow) {
      try {
        const inst = (jobRow as { instructions: string | null }).instructions;
        const parsed = inst ? (JSON.parse(inst) as { ticket_id?: string }) : null;
        if (parsed?.ticket_id) ticketId = String(parsed.ticket_id);
      } catch {
        /* fall through to the guard below */
      }
    }
    if (!ticketId) {
      const error = `approve_remedy: ticket_id not resolvable from job.instructions — no action fired, no customer message sent`;
      console.warn(`${tag} ${error}`);
      return {
        ok: false,
        handler: "approve_remedy",
        needs_attention: true,
        reason: "ticket_id_unresolved",
        error,
      };
    }

    // 3. Resolve the ticket's customer + channel and the workspace sandbox flag — the ActionContext
    //    executeSonnetDecision needs. A missing customer_id here means the ticket is unowned (never
    //    happens on real escalated tickets, but guard defensively — a customer-less action would
    //    also fail deep inside handleDirectAction with a less useful error).
    const facts = await deps.loadTicketFacts(admin, ticketId);
    if (!facts || !facts.customer_id) {
      const error = `approve_remedy: ticket ${ticketId.slice(0, 8)} has no customer_id — no action fired, no customer message sent`;
      console.warn(`${tag} ${error}`);
      return {
        ok: false,
        handler: "approve_remedy",
        needs_attention: true,
        reason: "ticket_missing_customer",
        error,
      };
    }
    const sandbox = await deps.loadWorkspaceSandbox(admin, workspaceId);

    // 4. Build the direct_action SonnetDecision. NO response_message — we own delivery.
    const decision = buildRemedySonnetDecision(planned.plan, verdict.reasoning);

    // 5. Suppress the executor's own send path so the customer never hears anything until AFTER we
    //    confirm a clean return. `send` is called both on the success path (would deliver
    //    response_message, which we didn't set) and on the failure path (holding messages inside
    //    handleDirectAction); we no-op it and drive delivery ourselves. `sysNote` writes an internal
    //    ticket_messages row so the audit thread shows what the executor did — same visibility=
    //    'internal' + author_type='system' shape every other executor caller uses.
    const suppressedSend = async (_msg: string, _sb: boolean): Promise<void> => {
      /* no-op — customer message is delivered by deliverTicketMessage below, only after success */
    };
    const sysNote = async (msg: string): Promise<void> => {
      try {
        await admin.from("ticket_messages").insert({
          ticket_id: ticketId,
          direction: "outbound",
          visibility: "internal",
          author_type: "system",
          body: `[cs-director/approve_remedy] ${msg}`,
        });
      } catch {
        /* internal-note failure is best-effort — never blocks execution */
      }
    };

    const ctx: ActionContext = {
      admin,
      workspaceId,
      ticketId,
      customerId: facts.customer_id,
      channel: facts.channel || "email",
      sandbox,
    };

    // 6. Fire the action. `executeSonnetDecision` runs actions first, verifies, and only THEN would
    //    call send(response_message) — but our response_message is undefined + our send is a no-op,
    //    so the executor's own return marks the SOLE synchronization point between "action done" and
    //    "message delivered". This is the ordering the Phase-2 spec pins.
    let executorResult: { messageSent: boolean; escalated: boolean; closed: boolean; statusManaged: boolean };
    try {
      executorResult = await deps.runExecutor(ctx, decision, suppressedSend, sysNote);
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      const error = `approve_remedy: executor threw (${errMsg}) — no customer message sent`;
      console.warn(`${tag} ${error}`);
      return {
        ok: false,
        handler: "approve_remedy",
        needs_attention: true,
        reason: "executor_threw",
        error,
      };
    }

    // 7. Failure path: executor escalated (verify failure / action failure). No customer message —
    //    the whole reason this executor exists is to NOT promise something we didn't do.
    if (executorResult.escalated) {
      const error = `approve_remedy: action ${actionType} escalated by executor (verify or run failed) — no customer message sent`;
      console.warn(`${tag} ${error}`);
      return {
        ok: false,
        handler: "approve_remedy",
        needs_attention: true,
        reason: "remedy_action_escalated",
        error,
      };
    }

    // 8. Success path: deliver the customer message. If June did not include one (rare — the prompt
    //    strongly implies one on approve_remedy, but the shape is Record<string, unknown> so it can
    //    be missing), we still return ok — the action fired, and the runner's per-verdict internal
    //    note + ticket transition close the loop.
    if (customerMessage) {
      try {
        await deps.deliverMessage(admin, workspaceId, ticketId, ctx.channel, customerMessage, sandbox);
        console.log(`${tag} approve_remedy: action=${actionType} ok · customer message delivered`);
        return { ok: true, handler: "approve_remedy", message_delivered: true };
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        const error = `approve_remedy: action ${actionType} succeeded but delivery threw (${errMsg})`;
        console.warn(`${tag} ${error}`);
        // The action DID fire; the delivery race is a real failure (customer didn't hear back) so
        // we surface it as needs_attention — a human confirms and re-delivers.
        return {
          ok: false,
          handler: "approve_remedy",
          needs_attention: true,
          reason: "delivery_threw_after_success",
          error,
        };
      }
    }

    console.log(`${tag} approve_remedy: action=${actionType} ok · no customer message on remedy (skipped delivery)`);
    return { ok: true, handler: "approve_remedy", message_delivered: false };
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    console.error(`${tag} handleApproveRemedy threw:`, errMsg);
    return {
      ok: false,
      handler: "approve_remedy",
      needs_attention: true,
      reason: "handler_threw",
      error: `approve_remedy: handler threw (${errMsg})`,
    };
  }
}

/**
 * Phase 3 executor stub for `author_spec`. Phase 3 will hand the verdict's `spec_seed` to the specs
 * SDK (`authorSpecRowStructured` — never a raw insert per CLAUDE.md § "PM data WRITES go through the
 * specs-table SDK"), anchored to a CS mandate. Phase 1 logs the intent + returns clean.
 */
async function handleAuthorSpec(
  _admin: Admin,
  jobId: string,
  _verdict: CsDirectorVerdictInput,
): Promise<ApplyBoxCsDirectorCallResult> {
  console.log(`[cs-director:${jobId.slice(0, 8)}] author_spec routed (Phase 2 scaffold — specs SDK stub, no spec authored)`);
  return { ok: true, handler: "author_spec" };
}

/**
 * Phase 3 executor stub for `escalate_founder`. The runner (`runCsDirectorCallJob`) already mints the
 * CEO `dashboard_notifications` card on every `escalate_founder` verdict per
 * [[../../docs/brain/specs/escalate-founder-reliably-creates-the-ceo-inbox-card-with-diagnosis-and-recommendation]] —
 * so Phase 2 of this executor is a logged no-op that acknowledges the routing without a second
 * insert. Phase 3 of this spec formalizes the card contract inside the executor (single writer, one
 * consistent shape) and adds the linkage back to the originating ticket / triage_run.
 */
async function handleEscalateFounder(
  _admin: Admin,
  jobId: string,
  _verdict: CsDirectorVerdictInput,
): Promise<ApplyBoxCsDirectorCallResult> {
  console.log(`[cs-director:${jobId.slice(0, 8)}] escalate_founder routed (Phase 2 scaffold — CEO card minted by runner; executor stub, no second write)`);
  return { ok: true, handler: "escalate_founder" };
}

// ── Public entrypoint ──────────────────────────────────────────────────────────────────────────

/**
 * Apply June's typed verdict to the artifact behind ONE `kind='cs-director-call'` agent_jobs row
 * (docs/brain/specs/cs-director-call-phase-2-executor-fires-june-verdicts.md — Phase 2 wires the
 * `approve_remedy` handler; Phase 3 wires author_spec + escalate_founder).
 *
 * The runner (`runCsDirectorCallJob` in scripts/builder-worker.ts) calls this ONCE per job,
 * immediately after `recordDirectorActivity` writes the Phase-1 audit row — so the mutator sees the
 * SAME normalized verdict the audit trail carries. Decision routing:
 *
 *  - `approve_remedy`   → `handleApproveRemedy` (Phase 2 — fires via `executeSonnetDecision`,
 *                         then delivers via `deliverTicketMessage`; a failed action returns
 *                         `needs_attention:true` so the runner parks the job).
 *  - `author_spec`      → `handleAuthorSpec` (Phase 3 authors via the specs SDK; Phase 2 stub).
 *  - `escalate_founder` → `handleEscalateFounder` (Phase 3 formalizes; the runner already mints the
 *                         CEO card, so Phase 2 stub logs the routing and returns clean).
 *  - anything else      → logged no-op (still `ok:true` — the audit row is the trail; a shape drift
 *                         out of `normalizeCsDirectorVerdict` should never crash the runner).
 *
 * Never throws — a thrown handler / job-lookup miss returns `{ ok:false, reason }` so the runner can
 * log it on the job's `log_tail` without rolling back the completed job. Same shape contract as
 * `applyBoxDeployReview` in [[deploy-guardian]].
 */
export async function applyBoxCsDirectorCall(
  admin: Admin,
  jobId: string,
  verdict: CsDirectorVerdictInput,
  deps: ApproveRemedyDeps = defaultApproveRemedyDeps,
): Promise<ApplyBoxCsDirectorCallResult> {
  try {
    const { data: jobRow } = await admin
      .from("agent_jobs")
      .select("id, workspace_id, kind")
      .eq("id", jobId)
      .maybeSingle();
    if (!jobRow) return { ok: false, reason: "job_not_found" };
    const job = jobRow as { id: string; workspace_id: string; kind: string };
    if (job.kind !== "cs-director-call") return { ok: false, reason: `wrong_kind:${job.kind}` };

    if (verdict.decision === "approve_remedy") {
      return handleApproveRemedy(admin, jobId, job.workspace_id, verdict, deps);
    }
    if (verdict.decision === "author_spec") return handleAuthorSpec(admin, jobId, verdict);
    if (verdict.decision === "escalate_founder") return handleEscalateFounder(admin, jobId, verdict);

    console.log(`[cs-director:${jobId.slice(0, 8)}] no actionable decision ('${String(verdict.decision)}') — clean no-op`);
    return { ok: true, handler: "noop" };
  } catch (e) {
    console.error(`[cs-director] applyBoxCsDirectorCall threw:`, e instanceof Error ? e.message : e);
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}
