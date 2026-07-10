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
 * PHASE 2 (approve_remedy): the handler NOW EXECUTES.
 *   - `handleApproveRemedy` builds a `direct_action` `SonnetDecision` from the verdict's `RemedyPlan`
 *     (`action_type` + `payload`) and fires it through `executeSonnetDecision` (the same real
 *     executor prod uses — see [[../../docs/brain/recipes/run-orchestrator-action]]) with a NO-OP send
 *     fn so the executor does NOT deliver ANY customer message itself. If the executor returns without
 *     escalation (the action succeeded + verify passed), we THEN deliver the RemedyPlan's customer
 *     message via `deliverTicketMessage`. A failed action never sends a customer message — the
 *     mutator returns `needs_attention:true` and the runner parks the job so a human can eyeball.
 *
 * PHASE 3 (author_spec + escalate_founder): the remaining handlers materialize.
 *   - `handleAuthorSpec` calls `authorSpecRowStructured` (the specs SDK — NEVER a raw insert per
 *     CLAUDE.md § "PM data WRITES go through the specs-table SDK") from the verdict's `spec_seed`
 *     (`slug`/`title`/`intent`/`problem`). The authored spec is `owner='cs'` with a bare
 *     `[[../functions/cs]]` parent (the SDK's Phase-2 auto-anchor deterministically picks a CS
 *     mandate), `autoBuild:false` (Roadmap-commissioned per CEO directive 2026-06-29 — Ada builds
 *     every spec, all functions), and its summary carries a `**Derived-from-ticket:** {ticket_id}`
 *     header — that's the LINKAGE BACK Phase 3's verification requires. A malformed spec_seed / SDK
 *     failure returns `needs_attention:true` (never a silent no-write).
 *   - `handleEscalateFounder` FORMALIZES THE LINKAGE-BACK CONTRACT the runner already writes. The
 *     runner is the SOLE writer of the CEO `dashboard_notifications` card per
 *     [[../../docs/brain/specs/escalate-founder-reliably-creates-the-ceo-inbox-card-with-diagnosis-and-recommendation]] —
 *     minted AFTER `applyBoxCsDirectorCall` returns, so the executor cannot verify the card exists
 *     at this seat and MUST NOT double-mint (a duplicate card would page the CEO twice). The
 *     executor's Phase-3 role is to RESOLVE + RETURN the linkage payload (`ticket_id` +
 *     `triage_run_id` from the job's instructions) so the runner's `log_tail` / audit surface names
 *     the linkage explicitly, and the result carries a machine-readable form future coverage /
 *     bounce-back handlers can pick up without re-parsing.
 *
 * PHASE 2 INVARIANT (execute-then-message, from the derived-from ticket): the customer message is
 * NEVER sent before the action returns success. This is the whole point of the executor — a failed
 * remedy that promised a fix but didn't ship is the exact failure mode the ticket exposed. We control
 * the ordering by passing a no-op `send` to `executeSonnetDecision`; the sole delivery site is the
 * `deliverTicketMessage` call AFTER a clean executor return.
 *
 * PHASE 3 INVARIANT (single writer per surface): the runner + this executor together respect the
 * single-deterministic-writer principle from the north star ([[../../docs/brain/operational-rules]]
 * § supervisable autonomy). The runner mints the CEO card (single writer), the executor writes the
 * authored spec via the SDK chokepoint (single writer), and the audit row on `director_activity`
 * lives on the runner (single writer). No handler in this file re-writes any of those artifacts —
 * duplicates would page the CEO twice / land two specs with the same slug / corrupt the audit trail.
 *
 * See [[../../docs/brain/libraries/cs-director]] · [[deploy-guardian]] ·
 * [[../../docs/brain/tables/director_activity]].
 */
import type { createAdminClient } from "@/lib/supabase/admin";
import type { ActionContext, ActionParams, SonnetDecision } from "@/lib/action-executor";
import type { AuthorSpecOpts, StructuredSpecInput } from "@/lib/author-spec";

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
  /**
   * `approve_remedy`: the remedy was a refund/credit over the workspace threshold and was PARKED for
   * founder SMS approval (via [[june-remedy-approval]]) instead of executing. The ticket is held
   * escalated-to-owner; the runner MUST NOT apply its usual approve_remedy deescalate/close transition
   * (the parked state is authoritative until the founder decides + the deferred sweep executes).
   */
  awaiting_founder_approval?: boolean;
  /**
   * Phase 3 (`author_spec`): the slug the specs SDK actually landed. Surfaced so the runner's
   * `log_tail` + a downstream Roadmap join can name the authored spec without re-parsing the
   * verdict's `spec_seed` (the LLM may pass a slug shape we normalize before the SDK write).
   */
  spec_slug?: string;
  /**
   * Phase 3 (`escalate_founder`): the ticket_id the executor resolved from `job.instructions` when it
   * routed this verdict — the LINKAGE-BACK marker the spec's Phase-3 verification asks for. The
   * runner is the sole writer of the CEO card + its metadata carries the same ticket_id; this field
   * surfaces the same fact on the executor's result so the audit surface names it in one place.
   */
  linkage_ticket_id?: string | null;
  /**
   * Phase 3 (`escalate_founder`): the triage_run_id from `job.instructions` (null when this call
   * did not go through the triage audit slice — a synthetic dispatch, or a Phase-1 no-triage lane).
   * Same linkage-back purpose as `linkage_ticket_id` above.
   */
  linkage_triage_run_id?: string | null;
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

    // 3b. FOUNDER-APPROVAL GATE (Cora/June dial-in). A refund/credit over the workspace threshold is
    //     NOT auto-executed — June parks it, raises a plain-language card into Eve's cockpit, and texts
    //     the founder for a yes/no/ask decision. The deferred sweep (executeApprovedJuneRemedies, box
    //     ~60s beat) fires it on approve. Everything else (date changes, coupons within limit,
    //     replacements, sub-threshold refunds) runs autonomously below. See [[june-remedy-approval]].
    if (verdict.remedy) {
      const { getRefundApprovalThresholdCents, remedyNeedsFounderApproval, raiseJuneRemedyApproval } =
        await import("@/lib/june-remedy-approval");
      const threshold = await getRefundApprovalThresholdCents(admin, workspaceId);
      const gate = remedyNeedsFounderApproval(verdict.remedy, threshold);
      if (gate.gated) {
        const raised = await raiseJuneRemedyApproval(admin, {
          workspaceId,
          ticketId,
          remedy: verdict.remedy,
          actionType: gate.actionType || actionType,
          amountCents: gate.amountCents,
          reasoning: verdict.reasoning,
        });
        console.log(`${tag} approve_remedy: refund/credit over threshold → parked for founder approval (via ${raised.via})`);
        return {
          ok: true,
          handler: "approve_remedy",
          awaiting_founder_approval: true,
          reason: `awaiting_founder_approval:${raised.via}`,
          message_delivered: false,
        };
      }
    }

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

// ── Phase 3 planners ──────────────────────────────────────────────────────────────────────────

/**
 * A normalized spec-seed extracted from June's `verdict.spec_seed` — everything the specs SDK needs to
 * land a Derived-from-ticket spec cleanly. `slug` is normalized (lower-kebab-case, alphanum + dashes
 * only) so a slightly-off shape from the LLM (`My Slug!` / `foo_bar`) still writes as a valid
 * `public.specs` row. The four content fields are REQUIRED — an SDK write with a blank body / no
 * verification / no plain-language intent fails the SDK's own guard rails (`assertEveryPhaseHasBody`
 * / `assertEveryPhaseHasChecks` / `assertEveryNodeHasIntent`) so we reject up-front and park
 * needs_attention rather than throw deep inside the chokepoint.
 */
export interface AuthorSpecPlan {
  slug: string;
  title: string;
  intent: string;
  problem: string;
  /** Optional structural target the LLM may name (e.g. a file or function) — surfaced in the summary
   *  when present so the future builder sees where June thought the fix should land. */
  target: string | null;
}

/**
 * Normalize the `spec_seed`'s slug — mirrors the improve-plan-executor's slugify (`replace(/[^a-z0-9-]/gi,
 * '-').toLowerCase()`) so an LLM that emitted `Cs Analyzer Coupon Gap` or `cs_analyzer_coupon_gap`
 * still lands `cs-analyzer-coupon-gap` (a valid `specs.slug` shape). Empty-after-normalize means the
 * seed had no usable slug — the planner falls back to `needs_attention` for that.
 */
function normalizeSpecSlug(raw: string): string {
  return raw.replace(/[^a-z0-9-]/gi, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
}

/**
 * Plan the specs-SDK write from June's `verdict.spec_seed`. `ok:false` means the seed is malformed
 * (missing slug/title/intent/problem OR the slug normalizes to empty) — the executor MUST park the
 * job needs_attention without touching the specs table, because a raw insert would violate the
 * "specs SDK is the sole writer" invariant AND a blank/incomplete spec would fail the SDK guards
 * anyway. Pure so the test suite can exercise every branch without a Supabase mock.
 */
export function planAuthorSpec(
  seed: Record<string, unknown> | undefined | null,
): { ok: true; plan: AuthorSpecPlan } | { ok: false; reason: string } {
  if (!seed || typeof seed !== "object" || Array.isArray(seed)) {
    return { ok: false, reason: "spec_seed_missing" };
  }
  const slugRaw = typeof seed.slug === "string" ? seed.slug.trim() : "";
  const title = typeof seed.title === "string" ? seed.title.trim() : "";
  const intent = typeof seed.intent === "string" ? seed.intent.trim() : "";
  const problem = typeof seed.problem === "string" ? seed.problem.trim() : "";
  if (!slugRaw) return { ok: false, reason: "spec_seed_missing_slug" };
  if (!title) return { ok: false, reason: "spec_seed_missing_title" };
  if (!intent) return { ok: false, reason: "spec_seed_missing_intent" };
  if (!problem) return { ok: false, reason: "spec_seed_missing_problem" };
  const slug = normalizeSpecSlug(slugRaw);
  if (!slug) return { ok: false, reason: "spec_seed_slug_empties_after_normalize" };
  const target =
    typeof seed.target === "string" && seed.target.trim().length > 0 ? seed.target.trim() : null;
  return { ok: true, plan: { slug, title, intent, problem, target } };
}

/**
 * Build the `StructuredSpecInput` handed to `authorSpecRowStructured`. Pure so the test suite can
 * assert the exact shape — every field the SDK's authoring gates check (`why`/`what`/`phases` with
 * body + verification + why + what) is populated, and the Derived-from-ticket linkage is prepended
 * to the summary as the FIRST line so a reader (or `grep`) can spot it without reading the whole
 * body. Owner is always `'cs'` (June's function); parent is always the bare `[[../functions/cs]]`
 * wikilink so the SDK's Phase-2 auto-anchor deterministically resolves it to a specific CS mandate
 * (same pattern the improve-plan-executor uses when the LLM omitted the mandate pick).
 */
export function buildAuthorSpecInput(plan: AuthorSpecPlan, ticketId: string): StructuredSpecInput {
  const targetLine = plan.target ? `\n\n**Target:** \`${plan.target}\`` : "";
  const summary = [
    `**Derived-from-ticket:** \`${ticketId}\``,
    ``,
    plan.intent,
    ``,
    `## Problem (from ticket \`${ticketId}\`)`,
    plan.problem,
    targetLine ? targetLine.trimStart() : ``,
    ``,
    `> Authored by the CS Director (💬 June) from ticket \`${ticketId}\` via the cs-director-call executor. Commission the build from the Roadmap board (owner = cs).`,
  ]
    .filter((line) => line !== "")
    .join("\n");
  const whyLine = `Ticket ${ticketId} surfaced a product gap the CS Director ruled needs a structural fix (not a per-customer remedy).`;
  const whatLine = `When this spec ships, the product gap identified in ticket ${ticketId} is addressed.`;
  const phaseBody = [
    `Implement the fix scoped from the problem above.`,
    ``,
    `Land the code change + the matching brain page in the SAME PR (CLAUDE.md hard rule).`,
  ].join("\n");
  const phaseVerification = [
    `Reproduce the ticket scenario → confirm the fixed behavior, and that the ticket that surfaced it (\`${ticketId}\`) would now be handled correctly.`,
    `\`npx tsc --noEmit\` passes.`,
  ].join("\n");
  return {
    title: plan.title,
    summary,
    owner: "cs",
    parent: `[[../functions/cs]]`,
    blocked_by: [],
    autoBuild: false, // CEO directive 2026-06-29 — Ada is the sole builder; specs commission on Roadmap.
    why: whyLine,
    what: whatLine,
    phases: [
      {
        title: `P1 — implement the fix`,
        body: phaseBody,
        verification: phaseVerification,
        status: "planned",
        why: whyLine,
        what: whatLine,
      },
    ],
  };
}

// ── Phase 3 injectable dependencies ────────────────────────────────────────────────────────────

/**
 * The subset of concrete calls `handleAuthorSpec` needs to write via the specs SDK. Injected so the
 * SDK-write invariant + malformed-seed failure paths can be exercised without booting the full
 * author-spec chokepoint's transitive deps (mandate resolver, brain-refs suggester, etc.) in unit
 * tests. Default resolves to the real `authorSpecRowStructured` at first call (dynamic import
 * mirrors the runner's own pattern in scripts/builder-worker.ts).
 */
export interface AuthorSpecDeps {
  authorSpec: (
    workspaceId: string,
    slug: string,
    spec: StructuredSpecInput,
    intendedStatus: "planned" | "deferred",
    opts?: AuthorSpecOpts,
  ) => Promise<boolean>;
}

async function defaultAuthorSpec(
  workspaceId: string,
  slug: string,
  spec: StructuredSpecInput,
  intendedStatus: "planned" | "deferred",
  opts?: AuthorSpecOpts,
): Promise<boolean> {
  const { authorSpecRowStructured } = await import("@/lib/author-spec");
  return authorSpecRowStructured(workspaceId, slug, spec, intendedStatus, opts);
}

const defaultAuthorSpecDeps: AuthorSpecDeps = {
  authorSpec: defaultAuthorSpec,
};

// ── Shared: resolve linkage from job.instructions ──────────────────────────────────────────────

/**
 * Pull ticket_id + triage_run_id out of an `agent_jobs.instructions` JSON string. Best-effort — a
 * malformed / missing instructions row returns nulls, and the caller decides whether that's a
 * needs_attention (approve_remedy / author_spec — the linkage back matters for what they write) or
 * a clean no-op (escalate_founder — the runner already wrote the linkage on the CEO card).
 */
function parseLinkageFromInstructions(
  instructions: string | null | undefined,
): { ticketId: string | null; triageRunId: string | null } {
  if (!instructions) return { ticketId: null, triageRunId: null };
  try {
    const parsed = JSON.parse(instructions) as { ticket_id?: string; triage_run_id?: string };
    return {
      ticketId: typeof parsed?.ticket_id === "string" ? String(parsed.ticket_id) : null,
      triageRunId: typeof parsed?.triage_run_id === "string" ? String(parsed.triage_run_id) : null,
    };
  } catch {
    return { ticketId: null, triageRunId: null };
  }
}

async function resolveLinkageFromJob(
  admin: Admin,
  jobId: string,
): Promise<{ ticketId: string | null; triageRunId: string | null }> {
  const { data: jobRow } = await admin
    .from("agent_jobs")
    .select("instructions")
    .eq("id", jobId)
    .maybeSingle();
  if (!jobRow) return { ticketId: null, triageRunId: null };
  return parseLinkageFromInstructions((jobRow as { instructions: string | null }).instructions);
}

// ── Phase 3 handlers ───────────────────────────────────────────────────────────────────────────

/**
 * Phase 3 executor for `author_spec` (docs/brain/specs/cs-director-call-phase-2-executor-fires-
 * june-verdicts.md § Phase 3). Writes June's `spec_seed` through the specs SDK
 * (`authorSpecRowStructured`) — NEVER a raw `.from('specs').insert` (CLAUDE.md § "PM data WRITES go
 * through the specs-table SDK", enforced by `_check-pm-sdk-compliance.ts`). The authored spec:
 *
 *  - `owner: 'cs'` — June's function; the spec lives in her portfolio on the Roadmap.
 *  - `parent: '[[../functions/cs]]'` — bare parent; the SDK's Phase-2 auto-anchor deterministically
 *    resolves it to a specific CS mandate (same pattern the improve-plan-executor uses).
 *  - `autoBuild: false` — the CEO directive (2026-06-29) is Ada builds every spec, all functions;
 *    a director-authored spec commissions on the Roadmap, not straight to build.
 *  - `intendedStatus: 'planned'` — a freshly-authored ticket-derived spec lands in the planned lane,
 *    ready for review + commissioning.
 *  - summary carries `**Derived-from-ticket:** {ticket_id}` as the first line — the LINKAGE BACK
 *    Phase 3's verification bullet asks for (a Roadmap reader can trace the spec to the ticket that
 *    surfaced it in one grep).
 *
 * Fail-safes (all park needs_attention — never a silent no-write):
 *  - `spec_seed` malformed / missing required fields → `spec_seed_missing_*`.
 *  - `ticket_id` unresolvable from `job.instructions` → `ticket_id_unresolved` (the Derived-from
 *    linkage would be blank, which defeats the whole point of the linkage bullet).
 *  - SDK write returned `false` (chokepoint's guard failed — invalid parent / spec-body-empty /
 *    runaway derivative fix / etc.) → `author_spec_write_returned_false`.
 *  - SDK write threw (`AuthorWriteFailedError` or an underlying Supabase error) → `author_spec_threw`.
 */
async function handleAuthorSpec(
  admin: Admin,
  jobId: string,
  workspaceId: string,
  verdict: CsDirectorVerdictInput,
  deps: AuthorSpecDeps = defaultAuthorSpecDeps,
): Promise<ApplyBoxCsDirectorCallResult> {
  const tag = `[cs-director:${jobId.slice(0, 8)}]`;
  try {
    // 1. Plan the seed. A missing required field is a stop-the-line — we never author a spec that
    //    would fail the SDK's own guard rails deep in the chokepoint (a blank body / no verification
    //    / no plain-language intent all throw with a different error class we'd have to translate).
    const planned = planAuthorSpec(verdict.spec_seed);
    if (!planned.ok) {
      const error = `author_spec: spec_seed malformed (${planned.reason}) — no spec written`;
      console.warn(`${tag} ${error}`);
      return {
        ok: false,
        handler: "author_spec",
        needs_attention: true,
        reason: planned.reason,
        error,
      };
    }

    // 2. Resolve ticket_id for the Derived-from-ticket LINKAGE-BACK header. The runner's Phase-1
    //    enqueue guarantees `ticket_id` in the instructions, but we defend against a shape drift
    //    class (instructions unparseable / a synthetic job that dispatched without the JSON payload).
    //    A blank linkage would defeat verification bullet #3, so we park instead of authoring.
    const linkage = await resolveLinkageFromJob(admin, jobId);
    if (!linkage.ticketId) {
      const error = `author_spec: ticket_id not resolvable from job.instructions — Derived-from linkage would be blank, no spec written`;
      console.warn(`${tag} ${error}`);
      return {
        ok: false,
        handler: "author_spec",
        needs_attention: true,
        reason: "ticket_id_unresolved",
        error,
      };
    }

    // 3. Build the structured input + hand it to the SDK. `intendedStatusSetBy` is the surface a
    //    grader / audit reader uses to trace which author path landed this spec — same convention
    //    the improve-plan-executor uses (`box:ticket-improve`) so the two ticket-derived spec paths
    //    are grep-able by prefix (`box:*`).
    const specInput = buildAuthorSpecInput(planned.plan, linkage.ticketId);
    let authored = false;
    try {
      authored = await deps.authorSpec(workspaceId, planned.plan.slug, specInput, "planned", {
        intendedStatusSetBy: "box:cs-director-call",
      });
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      const error = `author_spec: SDK threw (${errMsg}) — no spec written`;
      console.warn(`${tag} ${error}`);
      return {
        ok: false,
        handler: "author_spec",
        needs_attention: true,
        reason: "author_spec_threw",
        error,
      };
    }
    if (!authored) {
      const error = `author_spec: SDK returned false for slug=${planned.plan.slug} (chokepoint guard rejected / runaway-fix circuit-breaker tripped) — no spec written`;
      console.warn(`${tag} ${error}`);
      return {
        ok: false,
        handler: "author_spec",
        needs_attention: true,
        reason: "author_spec_write_returned_false",
        error,
      };
    }
    console.log(`${tag} author_spec: SDK wrote slug=${planned.plan.slug} (derived-from ticket=${linkage.ticketId.slice(0, 8)})`);
    return { ok: true, handler: "author_spec", spec_slug: planned.plan.slug };
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    console.error(`${tag} handleAuthorSpec threw:`, errMsg);
    return {
      ok: false,
      handler: "author_spec",
      needs_attention: true,
      reason: "handler_threw",
      error: `author_spec: handler threw (${errMsg})`,
    };
  }
}

/**
 * Phase 3 executor for `escalate_founder` (docs/brain/specs/cs-director-call-phase-2-executor-fires-
 * june-verdicts.md § Phase 3). FORMALIZES THE LINKAGE-BACK CONTRACT — the runner is the SOLE WRITER
 * of the CEO `dashboard_notifications` card per [[../../docs/brain/specs/escalate-founder-reliably-
 * creates-the-ceo-inbox-card-with-diagnosis-and-recommendation]] (minted after this executor
 * returns), and this handler NEVER mints a second card (a duplicate would page the CEO twice).
 *
 * What the executor DOES on Phase 3:
 *  - Resolves the ticket_id + triage_run_id from `job.instructions` — the same values the runner
 *    reads to stamp the card's metadata (`metadata.ticket_id` / `metadata.triage_run_id`), so the
 *    two writers agree on the linkage.
 *  - Returns them on the result as `linkage_ticket_id` + `linkage_triage_run_id` so the runner's
 *    `log_tail` names the linkage in a machine-readable form. This IS the "record the linkage back
 *    to the originating ticket / triage_run" verification bullet — a bounce-back handler / audit
 *    join can pull the linkage off the result without re-reading the CEO card's JSON metadata blob.
 *
 * A missing ticket_id here is NOT a needs_attention — it's the same shape drift class the runner's
 * Phase-1 guard already caught at enqueue time, so we log a warning and return `ok:true` with a
 * `null` linkage. The runner's audit row on `director_activity` is the primary trail regardless.
 */
async function handleEscalateFounder(
  admin: Admin,
  jobId: string,
  _verdict: CsDirectorVerdictInput,
): Promise<ApplyBoxCsDirectorCallResult> {
  const tag = `[cs-director:${jobId.slice(0, 8)}]`;
  try {
    const linkage = await resolveLinkageFromJob(admin, jobId);
    if (!linkage.ticketId) {
      console.warn(`${tag} escalate_founder: no ticket_id in job.instructions — linkage payload will be null`);
    } else {
      console.log(
        `${tag} escalate_founder: linkage ticket=${linkage.ticketId.slice(0, 8)}${linkage.triageRunId ? ` triage_run=${linkage.triageRunId.slice(0, 8)}` : ""} — CEO card minted by runner (single writer)`,
      );
    }
    return {
      ok: true,
      handler: "escalate_founder",
      linkage_ticket_id: linkage.ticketId,
      linkage_triage_run_id: linkage.triageRunId,
    };
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    console.error(`${tag} handleEscalateFounder threw:`, errMsg);
    // Non-fatal — the runner is the sole card writer; a linkage-resolve blip doesn't roll back the
    // runner's audit row + card mint. Surface as ok:true with a null linkage.
    return {
      ok: true,
      handler: "escalate_founder",
      linkage_ticket_id: null,
      linkage_triage_run_id: null,
      reason: `linkage_resolve_threw: ${errMsg}`,
    };
  }
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
/**
 * The full injectable dependency surface for `applyBoxCsDirectorCall` — a union of the Phase-2
 * approve_remedy deps and the Phase-3 author_spec deps. Kept as a single input so the runner's
 * single call site stays clean AND unit tests can override only the fields they exercise (the rest
 * fall back to real defaults). Fields are declared optional here because the union of two full deps
 * bags is the same shape as either bag on its own — the executor threads whichever set the routed
 * decision needs.
 */
export interface CsDirectorApplyDeps {
  approveRemedy?: ApproveRemedyDeps;
  authorSpec?: AuthorSpecDeps;
}

export async function applyBoxCsDirectorCall(
  admin: Admin,
  jobId: string,
  verdict: CsDirectorVerdictInput,
  deps: CsDirectorApplyDeps | ApproveRemedyDeps = {},
): Promise<ApplyBoxCsDirectorCallResult> {
  try {
    // Backwards-compat shim: Phase 2 tests pass an `ApproveRemedyDeps` bag directly (loadTicketFacts
    // / loadWorkspaceSandbox / runExecutor / deliverMessage). Detect that shape by presence of one
    // of the known ApproveRemedyDeps keys and rebranch it into the new CsDirectorApplyDeps union.
    const isLegacyApproveBag =
      deps && typeof deps === "object" && "loadTicketFacts" in (deps as Record<string, unknown>);
    const normalizedDeps: CsDirectorApplyDeps = isLegacyApproveBag
      ? { approveRemedy: deps as ApproveRemedyDeps }
      : (deps as CsDirectorApplyDeps);
    const approveRemedyDeps = normalizedDeps.approveRemedy ?? defaultApproveRemedyDeps;
    const authorSpecDeps = normalizedDeps.authorSpec ?? defaultAuthorSpecDeps;

    const { data: jobRow } = await admin
      .from("agent_jobs")
      .select("id, workspace_id, kind")
      .eq("id", jobId)
      .maybeSingle();
    if (!jobRow) return { ok: false, reason: "job_not_found" };
    const job = jobRow as { id: string; workspace_id: string; kind: string };
    if (job.kind !== "cs-director-call") return { ok: false, reason: `wrong_kind:${job.kind}` };

    if (verdict.decision === "approve_remedy") {
      return handleApproveRemedy(admin, jobId, job.workspace_id, verdict, approveRemedyDeps);
    }
    if (verdict.decision === "author_spec") {
      return handleAuthorSpec(admin, jobId, job.workspace_id, verdict, authorSpecDeps);
    }
    if (verdict.decision === "escalate_founder") return handleEscalateFounder(admin, jobId, verdict);

    console.log(`[cs-director:${jobId.slice(0, 8)}] no actionable decision ('${String(verdict.decision)}') — clean no-op`);
    return { ok: true, handler: "noop" };
  } catch (e) {
    console.error(`[cs-director] applyBoxCsDirectorCall threw:`, e instanceof Error ? e.message : e);
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}
