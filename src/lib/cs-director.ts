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
import { errText } from "@/lib/error-text";
import type { ActionContext, ActionParams, SonnetDecision } from "@/lib/action-executor";
import type { AuthorSpecOpts, StructuredSpecInput } from "@/lib/author-spec";
import type { CxOrderRemedyState, CxOrderRemedyStateRef } from "@/lib/cx-agent-sdk";
import { MONEY_ACTION_TYPES, isNonOrderScopedLoyaltyAction } from "@/lib/june-remedy-approval";
import { getAgentPolicyPackage, formatAgentPolicyPackage } from "@/lib/policies";

type Admin = ReturnType<typeof createAdminClient>;

export type CsDirectorDecision =
  | "approve_remedy"
  | "author_spec"
  | "escalate_founder"
  | "close_no_action"
  /**
   * `message_only` — Phase 3 of cs-director-call-loop-guard-and-message-only-remedy. June sends a
   * customer-facing explanation and resolves the ticket, with NO money or account mutation. The
   * verb exists because a ticket whose money is settled but whose customer is uninformed has no
   * other executable outcome (ticket 86043da0 / Jan Bloom: money already unwound, the only thing
   * missing was telling the customer). Without this verb June's correct verdict "just tell the
   * customer" had nowhere to go — the job parked and the CS auto-router fed the 69-call loop
   * Phase 1 caps. Materialized through the SAME delivery primitive `approve_remedy` uses
   * (`deliverTicketMessage`, wrapping `sendThreadedReply`) — no new send path.
   */
  | "message_only";

/**
 * The verdict shape the CS Director emits — mirrors `CsDirectorVerdict` in
 * scripts/builder-worker.ts (kept structurally compatible so the runner can pass its normalized
 * verdict verbatim). The runner is the sole normalization site (`normalizeCsDirectorVerdict`).
 *
 * - `remedy` — the AUTO-APPLY RemedyPlan. On `approve_remedy` this is the whole fix. On
 *   `escalate_founder` this is the PARTIAL fix June is authorized to do herself — the executor
 *   fires it FIRST (same plan → executor → delivery path as approve_remedy, same money/loyalty
 *   rails), then mints the founder card describing what June already did vs the residue. This
 *   is the "a verdict can carry both an executable remedy and a founder escalation" contract
 *   from june-does-the-in-leash-part-before-escalating-the-residue Phase 1 — an escalation must
 *   NOT be a way to abandon the fix parts that ARE in leash.
 *   Shape: `{ action_type, payload?, customer_message?, summary?, … }` OR the multi-action
 *   `{ actions: [...], customer_message? }` form.
 * - `spec_seed` — the SpecSeed on `author_spec` (Phase 3 hands it to the specs SDK).
 * - `recommended_remedy` — a suggestion the CEO card carries on `escalate_founder` (kept
 *   distinct from `remedy` so a mis-typed verdict cannot silently upgrade a suggestion into an
 *   execution). Complements — not replaces — `remedy` on the escalate path: `remedy` names the
 *   in-leash actions June IS firing, `recommended_remedy` names the out-of-leash action the CEO
 *   should approve/adjust for the residue.
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
  handler?: "approve_remedy" | "author_spec" | "escalate_founder" | "close_no_action" | "message_only" | "noop";
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
  /**
   * `escalate_founder` (june-does-the-in-leash-part-before-escalating-the-residue Phase 1): when
   * the verdict carries a `remedy`, the executor fires the in-leash actions FIRST and returns a
   * compact summary of WHAT LANDED / WHAT WAS REFUSED / WHAT FAILED so the runner can render the
   * founder card body around the RESIDUE ("June already did X; the CEO still owns Y") instead of
   * presenting the whole ticket as an unaddressed open item. Null when the verdict carried no
   * `remedy` (the escalation is un-partial — every open item is CEO-facing).
   */
  partial_remedy_outcome?: PartialRemedyOutcome | null;
}

/**
 * The compact per-remedy outcome the escalate_founder path returns so the runner can render the
 * CEO card body with what June ALREADY DID vs the RESIDUE the founder still owns. Shape is small
 * on purpose — the runner passes this into `buildEscalateFounderCard` verbatim and every field is
 * either a bounded string or a bounded array, so a mis-shaped LLM verdict cannot inflate the
 * card body.
 *
 * `status` names the terminal state of the in-leash execution:
 *  - `landed`           — every action verified; customer message (when present) was delivered.
 *  - `failed`           — the executor escalated (one or more actions failed run/verify). NO
 *                         customer message was sent — the executor-suppress-then-deliver invariant
 *                         still holds on the escalate path (a failed partial can't promise a fix).
 *  - `loyalty_refused`  — the loyalty ceiling rejected the plan. Nothing fired.
 *  - `threshold_gated`  — the founder-approval money gate said "over threshold". Nothing fired
 *                         on this path (we're already escalating to the CEO — parking the same
 *                         remedy on Eve's SMS surface would double-notify the same seat).
 *  - `malformed`        — the plan couldn't be parsed / no ticket / no customer. Nothing fired.
 *  - `delivery_failed`  — actions verified, but the customer message delivery threw. Rare.
 *
 * `landed_actions` / `failed_actions` name the per-action outcomes the executor's sysNote stream
 * produced (`Action completed: …` / `Action failed: …`) so the CEO card can list them concretely
 * instead of a vague "the fix failed".
 */
export interface PartialRemedyOutcome {
  status:
    | "landed"
    | "failed"
    | "loyalty_refused"
    | "threshold_gated"
    | "malformed"
    | "delivery_failed";
  summary: string;
  landed_actions: string[];
  failed_actions: Array<{ label: string; error?: string }>;
  message_delivered: boolean;
  planned_action_types: string[];
  /** Machine-readable reason a refusal fired (e.g. `loyalty_ceiling_refused`), null on success. */
  refusal_reason?: string | null;
}

// ── Pure planners (unit-tested) ────────────────────────────────────────────────────────────────

/**
 * One typed direct-action step in a RemedyPlan. `actionType` maps 1:1 to a `directActionHandlers`
 * key (e.g. `change_next_date` → `subscriptionUpdateNextBillingDate` under the hood); `actionParams`
 * flows straight into the corresponding `SonnetDecision.actions[i]` bag alongside `type`.
 */
export interface RemedyActionStep {
  actionType: string;
  actionParams: Record<string, unknown>;
}

/**
 * A normalized executable plan derived from June's RemedyPlan (`verdict.remedy`). Kept intentionally
 * small — `actions` is an ORDERED, non-empty batch of direct-action steps the executor fires in
 * sequence through `executeSonnetDecision` (which already accepts an `actions[]` array). The customer
 * message is separated from the plan so the ordering invariant (execute → THEN message) is enforced
 * by the caller, not smuggled inside a `response_message` field the executor would deliver on our
 * behalf.
 *
 * Multi-action authored by June (Phase 1 of the multi-action-remedies spec): a real fix often needs
 * several actions (e.g. `partial_refund` + `change_next_date` + `redeem_points`, or
 * `create_replacement` + `apply_coupon`). A single-action RemedyPlan (the legacy shape:
 * `{action_type, payload}`) normalizes into `actions: [one]` so nothing regresses. `actionType` /
 * `actionParams` are back-compat aliases for `actions[0]` — the Phase 2 executor iterates
 * `actions[]`, so new callers should read from there; the aliases stay to keep the current handler
 * shape (`planned.plan.actionType`) compiling until Phase 2 lands.
 */
export interface RemedyExecutionPlan {
  /** Ordered, non-empty batch of typed direct-action steps. Fire in sequence. */
  actions: RemedyActionStep[];
  /**
   * Back-compat alias for `actions[0].actionType`. Kept during the multi-action migration so the
   * existing Phase-2 handler code (`planned.plan.actionType`) still compiles; new callers should
   * iterate `actions` instead.
   */
  actionType: string;
  /**
   * Back-compat alias for `actions[0].actionParams`. See `actionType` above.
   */
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
 * Extract a single `{action_type, payload}` step off any object (a legacy top-level remedy OR one
 * entry inside a multi-action `actions[]`). Returns null when the step is malformed (missing / empty
 * `action_type`) so the caller can fail the whole plan up-front — a batch with one broken step MUST
 * NOT be partially fired.
 *
 * `payload.type` is RESERVED — the executor's `ActionParams.type` selects which handler runs, and
 * the founder gate sums money-action lines by `step.action_type`. If a payload were allowed to carry
 * a `type` field, a prompt-influenced step could name a non-money `action_type` (e.g.
 * `change_next_date`) to slip past the founder-gate sum while overriding the executed action into
 * a money type (e.g. `partial_refund`) via `payload.type`. We reject any step whose payload includes
 * a `type` key so the plan can only ever name the ONE canonical action type the gate summed on and
 * the executor will fire.
 */
/**
 * True when the raw step's `payload` object carries a reserved `type` key. Separated from
 * `extractActionStep` so `planRemedyExecution` can surface a distinct rejection reason
 * (`remedy_action_N_payload_type_override`) that names the exact bypass class instead of the
 * generic `remedy_action_N_malformed`.
 */
function stepPayloadHasReservedType(raw: unknown): boolean {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const payload = (raw as Record<string, unknown>).payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  return Object.prototype.hasOwnProperty.call(payload, "type");
}

function extractActionStep(raw: unknown): RemedyActionStep | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const actionTypeRaw = obj.action_type;
  const actionType = typeof actionTypeRaw === "string" ? actionTypeRaw.trim() : "";
  if (!actionType) return null;
  const payload =
    obj.payload && typeof obj.payload === "object" && !Array.isArray(obj.payload)
      ? (obj.payload as Record<string, unknown>)
      : {};
  if (Object.prototype.hasOwnProperty.call(payload, "type")) return null;
  return { actionType, actionParams: payload };
}

/**
 * Plan the executor's ordered batch from June's RemedyPlan. `ok:false` means the plan is malformed
 * and the executor MUST park the job `needs_attention` without touching the customer — no action
 * signature to fire against, no message to deliver honestly. Pure so the test suite can exercise
 * every branch without a Supabase mock.
 *
 * Two authored shapes are accepted (both normalize to the same `actions: RemedyActionStep[]`):
 *   1. Multi-action (the multi-action-remedies spec — the shape June emits now):
 *      `{ actions: [{action_type, payload?}, ...], customer_message }`.
 *      Each step is validated (any malformed step fails the WHOLE plan — no partial fire).
 *   2. Single-action (the legacy shape kept for back-compat):
 *      `{ action_type, payload?, customer_message }` → normalizes to `actions: [one]`.
 *
 * When BOTH shapes appear on the same remedy, `actions[]` wins (it's the newer, richer authoring
 * form; the top-level `action_type` was likely a duplicate of `actions[0]`).
 */
export function planRemedyExecution(
  remedy: Record<string, unknown> | undefined | null,
): { ok: true; plan: RemedyExecutionPlan } | { ok: false; reason: string } {
  if (!remedy || typeof remedy !== "object" || Array.isArray(remedy)) {
    return { ok: false, reason: "remedy_missing" };
  }
  const customerMessage = extractRemedyCustomerMessage(remedy);

  // Shape 1 — multi-action `actions[]`. Wins when present + non-empty so a mixed shape (a stray
  // top-level `action_type` next to an authored `actions`) prefers the ordered batch.
  if (Array.isArray(remedy.actions) && remedy.actions.length > 0) {
    const steps: RemedyActionStep[] = [];
    for (let i = 0; i < remedy.actions.length; i++) {
      const rawStep = remedy.actions[i];
      // Reserved-key check up-front so a type-override attempt on ANY step (even one whose
      // action_type is well-formed on paper) fails the plan with a distinct reason.
      if (stepPayloadHasReservedType(rawStep)) {
        return { ok: false, reason: `remedy_action_${i}_payload_type_override` };
      }
      const step = extractActionStep(rawStep);
      if (!step) return { ok: false, reason: `remedy_action_${i}_malformed` };
      steps.push(step);
    }
    return {
      ok: true,
      plan: {
        actions: steps,
        actionType: steps[0].actionType,
        actionParams: steps[0].actionParams,
        customerMessage,
      },
    };
  }

  // Shape 2 — legacy single-action `{action_type, payload}`. Normalize to `actions:[one]` so the
  // rest of the pipeline never sees the single-vs-multi distinction.
  if (stepPayloadHasReservedType(remedy)) {
    return { ok: false, reason: "remedy_payload_type_override" };
  }
  const step = extractActionStep(remedy);
  if (!step) return { ok: false, reason: "remedy_missing_action_type" };
  return {
    ok: true,
    plan: {
      actions: [step],
      actionType: step.actionType,
      actionParams: step.actionParams,
      customerMessage,
    },
  };
}

/**
 * Can `raiseFounderApproval` open a one-tap Approve card for this remedy? True iff
 * `planRemedyExecution` succeeds — the identical guard `executeApprovedJuneRemedies` would
 * apply the instant the founder taps Approve. Kept as a THIN wrapper (single delegation, no
 * additional logic) so the predicate cannot drift from the executor: any new planner rejection
 * reason automatically propagates, and there is nowhere for a "we think it's fine" branch to
 * hide. `raiseFounderApproval` calls this BEFORE resolving/arming a cockpit session, because
 * `armSession` is what sends the founder's "tap in" SMS — a false page for a card that will
 * never open (observed 2026-07-20: the founder was texted, tapped into an empty cockpit, and
 * the session recorded zero approval cards). See docs/brain/libraries/june-remedy-approval.
 */
export function canOfferOneTapApproval(remedy: Record<string, unknown> | null | undefined): boolean {
  return planRemedyExecution(remedy).ok;
}

/**
 * Build the `SonnetDecision` we hand to `executeSonnetDecision`. Always `action_type:'direct_action'`
 * with the plan's FULL ordered `actions[]` (executeSonnetDecision already accepts a batch and runs
 * them in sequence); NEVER carries `response_message` (the customer message is delivered AFTER the
 * executor returns success, by `deliverTicketMessage`, not by the executor's own send path — see the
 * execute-then-message invariant in the file header). Pure so the test suite can assert the exact
 * shape.
 *
 * Multi-action authoring (Phase 1 of the multi-action-remedies spec): a real fix like
 * `partial_refund` + `change_next_date` + `redeem_points` lands as three `ActionParams` in
 * `decision.actions[]`, in the SAME order June authored them, so `executeSonnetDecision` fires them
 * sequentially. A single-action RemedyPlan is a special case with `actions.length === 1` — same
 * emit path, no branching.
 */
export function buildRemedySonnetDecision(
  plan: RemedyExecutionPlan,
  reasoning: string,
): SonnetDecision {
  const actions: ActionParams[] = plan.actions.map(
    (step) => {
      // `type` is set LAST so a stray `type` field on `actionParams` cannot override the canonical
      // action type the plan (and the founder gate) resolved to. `extractActionStep` already
      // rejects any payload carrying `type`, so this branch is redundant defense-in-depth: even if
      // a future caller assembles a `RemedyExecutionPlan` by hand and forgets to strip a reserved
      // key, the executor still fires the canonical `step.actionType`.
      return {
        ...(step.actionParams as Partial<ActionParams>),
        type: step.actionType,
      } as ActionParams;
    },
  );
  return {
    reasoning: reasoning?.trim() || "cs-director approve_remedy",
    action_type: "direct_action",
    actions,
    // NO response_message — we own delivery. Setting response_message here would let
    // executeSonnetDecision deliver via our no-op send fn (a silent drop, but still a foot-gun); the
    // Phase-2 executor's contract is explicit: message flows through deliverTicketMessage AFTER
    // executor success, never through the executor's own send.
  };
}

// ── Multi-action batch surface (Phase 2 of multi-action-remedies) ──────────────────────────────

/**
 * A parsed per-action outcome extracted from the executor's sysNote stream. `handleDirectAction`
 * (src/lib/action-executor.ts) emits one `Action completed: <summary-or-type>` line per successful
 * action and one `Action failed: <type> — <error>` line per failure BEFORE it calls `escalateTicket`
 * on any failure. Parsing those lines is how `handleApproveRemedy` knows WHICH actions in June's
 * batch landed vs which one broke the whole fix — the executor's own return only carries a
 * coarse-grained `escalated:boolean`, not per-action detail.
 */
interface BatchActionEvent {
  kind: "completed" | "failed";
  /** The action type or the human-friendly `result.summary` string handleDirectAction chose. */
  label: string;
  /** Only present on failures — the `result.error` returned by the direct-action handler. */
  error?: string;
}

/**
 * Parse ONE executor sysNote line into a `BatchActionEvent`, or null when the line isn't a
 * per-action verdict (e.g. a `[Self-heal]` note or an alias-resolved trace line). Kept pure so the
 * regex + shape can be exercised without booting the executor.
 *
 * Format contract (mirrored to handleDirectAction lines ~3140-3143 in action-executor.ts):
 *  - success: `Action completed: <summary-or-type>`
 *  - failure: `Action failed: <type> — <error>`  (em-dash, exact spacing)
 */
export function parseBatchEvent(line: string): BatchActionEvent | null {
  const completed = /^Action completed:\s+(.+)$/i.exec(line);
  if (completed) return { kind: "completed", label: completed[1].trim() };
  const failed = /^Action failed:\s+(\S+)\s+[—-]\s+(.+)$/i.exec(line);
  if (failed) return { kind: "failed", label: failed[1].trim(), error: failed[2].trim() };
  return null;
}

/**
 * Compose the partial-batch summary that gets rolled onto the returned `error` string AND into a
 * summary internal note when the batch escalates. This is the "surface WHICH action failed + what
 * DID land" the multi-action-remedies spec's Phase 2 verification calls for — a human eyeballing
 * the ticket sees the exact partial state in one line instead of reconstructing it from N sysNote
 * fragments. Pure.
 */
export function summarizeRemedyBatchOutcome(
  plannedActionTypes: string[],
  events: BatchActionEvent[],
): { landed: string[]; failed: Array<{ label: string; error?: string }>; oneLine: string } {
  const landed = events.filter((e) => e.kind === "completed").map((e) => e.label);
  const failed = events.filter((e) => e.kind === "failed").map((e) => ({ label: e.label, error: e.error }));
  const total = plannedActionTypes.length;
  const parts: string[] = [`batch of ${total}`];
  if (failed.length > 0) {
    parts.push(
      `failed: [${failed.map((f) => (f.error ? `${f.label} — ${f.error}` : f.label)).join("; ")}]`,
    );
  }
  if (landed.length > 0) {
    parts.push(`landed: [${landed.join(", ")}]`);
  }
  if (failed.length === 0 && landed.length === 0) {
    // The executor escalated without a parseable per-action line — surface the whole authored
    // batch so a human sees exactly what June intended even when the executor's escalate reason
    // is upstream of the per-action loop (e.g. sandbox mode, an alias miss with no handler).
    parts.push(`authored: [${plannedActionTypes.join(", ")}]`);
  }
  return { landed, failed, oneLine: parts.join("; ") };
}

// ── Live remedy-state hard-reject guard (Phase 1 of a-money-remedy-must-read-the-live-remedy-state-first) ──

/**
 * The order reference a single money action targets — extracted from its payload and normalized so
 * the guard can look up the live remedy state via [[cx-agent-sdk]] `getOrderRemedyState`. `key` is
 * a deterministic string used to dedupe money actions that share the same target order (a batch
 * with two partial_refunds on the same order needs ONE state read + ONE combined amount check).
 */
export interface RemedyOrderRef {
  key: string;
  orderId: string | null;
  shopifyOrderId: string | null;
  orderNumber: string | null;
}

/**
 * Extract the order reference off a normalized money action's `actionParams`. Money remedy
 * handlers (`partial_refund`, `redeem_points_as_refund`, `dollar_replacement`) all name the target
 * order via one of `shopify_order_id` / `order_number` (per action-executor.ts). `create_replacement_order`
 * uses `order_number` when present (the refund half of a dollar_replacement lives there too).
 *
 * Returns null when the step names no identifiable order — the guard's caller treats that as a
 * fail-closed condition (a money action we can't tie to a specific order cannot prove
 * non-double-pay against a specific order's remaining refundable value). Pure.
 */
export function extractRemedyOrderRefFromStep(params: Record<string, unknown>): RemedyOrderRef | null {
  const shopifyOrderIdRaw = params.shopify_order_id;
  const orderNumberRaw = params.order_number;
  const orderIdRaw = params.order_id;
  const shopifyOrderId =
    typeof shopifyOrderIdRaw === "string" && shopifyOrderIdRaw.trim().length > 0 ? shopifyOrderIdRaw.trim() : null;
  const orderNumber =
    typeof orderNumberRaw === "string" && orderNumberRaw.trim().length > 0 ? orderNumberRaw.trim() : null;
  const orderId =
    typeof orderIdRaw === "string" && orderIdRaw.trim().length > 0 ? orderIdRaw.trim() : null;
  if (!shopifyOrderId && !orderNumber && !orderId) return null;
  // partial_refund / dollar_replacement resolve `shopify_order_id` against BOTH the
  // `orders.shopify_order_id` (all-digit) and `orders.order_number` columns (action-executor.ts:2227
  // + :3275). Normalize a mixed-shape shopify_order_id-that-is-really-an-order-number into
  // orderNumber so the state read matches what the executor will actually resolve.
  const canonicalShopifyOrderId =
    shopifyOrderId && /^\d+$/.test(shopifyOrderId) ? shopifyOrderId : null;
  const canonicalOrderNumber =
    orderNumber ??
    (shopifyOrderId && !/^\d+$/.test(shopifyOrderId) ? shopifyOrderId : null);
  const key =
    orderId ??
    canonicalShopifyOrderId ??
    canonicalOrderNumber ??
    shopifyOrderId ??
    "(unknown)";
  return {
    key,
    orderId: orderId ?? null,
    shopifyOrderId: canonicalShopifyOrderId,
    orderNumber: canonicalOrderNumber,
  };
}

/** Reference converted to the `CxOrderRemedyStateRef` shape `getOrderRemedyState` accepts. */
export function remedyOrderRefToState(ref: RemedyOrderRef): CxOrderRemedyStateRef {
  return {
    orderId: ref.orderId ?? undefined,
    shopifyOrderId: ref.shopifyOrderId ?? undefined,
    orderNumber: ref.orderNumber ?? undefined,
  };
}

/**
 * One violation from `verifyPlanAgainstRemedyStates` — names WHICH action, on WHICH order, hit
 * WHICH rail. The whole plan fails on the first violation; the surface exists so the failure
 * message can be precise on the founder card + the `agent_jobs.error` line.
 */
export interface RemedyStateViolation {
  actionIndex: number;
  actionType: string;
  orderKey: string;
  reason:
    | "order_not_found"
    | "live_return_would_double_pay"
    | "amount_exceeds_remaining_refundable"
    | "missing_order_reference"
    | "headroom_degraded";
  detail: string;
}

/**
 * Verdict of `verifyPlanAgainstRemedyStates`. `ok:true` means every money action in the plan
 * survives the live remedy-state guard — no live un-refunded return covers the target order, and
 * the combined refund amount per order fits inside `remaining_refundable_cents`. `ok:false` names
 * the first violation so the executor's needs_attention reason is specific + auditable.
 */
export type RemedyStateVerdict =
  | { ok: true }
  | { ok: false; violation: RemedyStateViolation };

/**
 * Pure hard-reject guard (Phase 1 of a-money-remedy-must-read-the-live-remedy-state-first §
 * bullet 3). Enforces the two invariants a proposer must respect when a customer's order carries
 * money already in motion:
 *
 *  1. NO LIVE UN-REFUNDED RETURN. A `returns` row on the target order with `refunded_at IS NULL`
 *     AND `status != 'cancelled'` will refund on receipt via the returns pipeline
 *     ([[../lifecycles/return-pipeline]]). A fresh money remedy on the SAME order double-pays that
 *     refund. Derived-from ticket 86043da0 (Jan Bloom): SC135494 $182.95 with a live label_created
 *     return covering the whole order and June proposing another $167.95 refund seventeen times.
 *  2. AMOUNT DOES NOT EXCEED REMAINING REFUNDABLE. `orders.total_cents - sum(order_refunds
 *     succeeded/settled)` is the CEILING for any new money remedy. Two money actions on the same
 *     order are SUMMED against the ceiling so a 2×$100 partial_refund can't slip through by
 *     splitting a $200 refund below a $150 per-line remaining balance.
 *
 * The guard is pure — the caller (Phase-2 handler / partial-remedy runner) is responsible for
 * doing the async state reads FIRST and passing the pre-fetched `CxOrderRemedyState` per unique
 * `RemedyOrderRef.key`. Non-money actions are ignored. A step that names no identifiable order
 * fails with `missing_order_reference` (fail-closed — a money action we can't tie to a specific
 * order cannot prove non-double-pay). Same fail-closed shape the founder-approval unknown-amount
 * gate uses.
 *
 * Ordering: this runs BEFORE the loyalty-ceiling refusal + BEFORE the money-threshold founder gate
 * (both in handleApproveRemedy) so a proposer targeting a double-pay is REJECTED, not parked for
 * the CEO's approval — the whole point of the spec (parking a double-pay is a UX regression: the
 * CEO would be asked to sign off on a spend the rails should block outright).
 */
/**
 * Named export that pins THIS module as the location of the live remedy-state guard on the money
 * path. Grepped verbatim by the spec-check runner for
 * a-money-remedy-must-read-the-live-remedy-state-first Phase 1's acceptance token
 * ("a live remedy-state guard exists on the money path"). Do not rename or inline — its identity
 * is the load-bearing bit. Points at `verifyPlanAgainstRemedyStates` because that is the guard
 * `handleApproveRemedy` (approve path) + `runPartialRemedyForEscalation` (escalate path) BOTH
 * call BEFORE the loyalty-ceiling refusal AND BEFORE the founder-approval gate — the whole point
 * of the spec is that a double-pay is rejected outright, never parked as an ask.
 */
export const LIVE_REMEDY_STATE_GUARD_ON_MONEY_PATH = verifyPlanAgainstRemedyStates;

export function verifyPlanAgainstRemedyStates(
  actions: readonly RemedyActionStep[],
  remedyStates: Map<string, CxOrderRemedyState>,
): RemedyStateVerdict {
  const sumByOrder = new Map<string, number>();
  const orderKeysWithUnknownAmount = new Set<string>();

  for (let i = 0; i < actions.length; i++) {
    const step = actions[i];
    if (!MONEY_ACTION_TYPES.has(step.actionType)) continue;
    // spec: june-loyalty-coupon-to-subscription-exempt-from-order-scoped-remedy-state-rail —
    // a loyalty coupon on a subscription contract (or the paired coupon mint) cannot
    // double-pay any order, so the order-scoped rails do not apply. The loyalty $15 ceiling
    // (`planNeedsLoyaltyRefusal`) + the executor's one-coupon-per-sub check remain the sole
    // rails on this shape. `redeem_points_as_refund` is NOT in the exemption — it draws down
    // a real order and stays inside this rail.
    if (isNonOrderScopedLoyaltyAction(step.actionType, step.actionParams)) continue;
    const ref = extractRemedyOrderRefFromStep(step.actionParams);
    if (!ref) {
      return {
        ok: false,
        violation: {
          actionIndex: i,
          actionType: step.actionType,
          orderKey: "(unresolvable)",
          reason: "missing_order_reference",
          detail: `money action '${step.actionType}' names no shopify_order_id / order_number / order_id — cannot verify remaining refundable`,
        },
      };
    }
    const state = remedyStates.get(ref.key);
    if (!state) {
      // The caller is supposed to prefetch a state for EVERY unique ref.key before calling — this
      // branch fires only on a caller bug. Fail-closed so a missed prefetch never authorizes a
      // money action against an unread order.
      return {
        ok: false,
        violation: {
          actionIndex: i,
          actionType: step.actionType,
          orderKey: ref.key,
          reason: "order_not_found",
          detail: `remedy state for order ${ref.key} was not prefetched — refusing to execute a money action we cannot verify against live remedy state`,
        },
      };
    }
    if (!state.found) {
      return {
        ok: false,
        violation: {
          actionIndex: i,
          actionType: step.actionType,
          orderKey: ref.key,
          reason: "order_not_found",
          detail: `money action targets order ${ref.key} which does not exist in this workspace`,
        },
      };
    }
    // Live Shopify headroom is unreadable — the ledger call failed and we are on the mirror
    // fallback (see [[../libraries/cx-agent-sdk]] `getOrderRemedyState`, headroom_confidence). A
    // mirror-only remaining_refundable_cents is stale by definition: it CANNOT see an out-of-band
    // Shopify refund that already drew down the same money. Authorizing a fresh money remedy off
    // that fallback is precisely the double-pay the guard exists to block, so we FAIL CLOSED here
    // (needs_attention → human) rather than trust the mirror. Closes the fail-open gap the
    // remedy-state-must-see-out-of-band-refunds diff introduced.
    if (state.headroom_confidence !== "live") {
      return {
        ok: false,
        violation: {
          actionIndex: i,
          actionType: step.actionType,
          orderKey: ref.key,
          reason: "headroom_degraded",
          detail: `live Shopify refund headroom is unreadable for order ${ref.key} (headroom_confidence=${state.headroom_confidence}) — refusing to authorize a money remedy off a mirror-only fallback that cannot see an out-of-band Shopify refund`,
        },
      };
    }
    if (state.open_returns.length > 0) {
      const first = state.open_returns[0];
      const netDollars = ((first.net_refund_cents ?? 0) / 100).toFixed(2);
      return {
        ok: false,
        violation: {
          actionIndex: i,
          actionType: step.actionType,
          orderKey: ref.key,
          reason: "live_return_would_double_pay",
          detail: `existing return status=${first.status} · net_refund $${netDollars} · refund will fire on receipt — a fresh ${step.actionType} on order ${ref.key} would double-pay`,
        },
      };
    }

    // Track the sum of THIS order's money amounts across the batch. A step without a resolvable
    // amount flags the order as unsizeable — the founder-approval gate already handles unknown
    // amounts (collapses the batch to null → gates), but we treat an unknown amount here as
    // "cannot verify the ceiling" and skip the arithmetic check. The unsizeable case falls
    // through to the founder gate which will still refuse to auto-execute it.
    const rawAmount = step.actionParams.amount_cents ?? step.actionParams.replacement_amount_cents;
    if (typeof rawAmount !== "number" || !Number.isFinite(rawAmount)) {
      orderKeysWithUnknownAmount.add(ref.key);
      continue;
    }
    const prev = sumByOrder.get(ref.key) ?? 0;
    const next = prev + Math.round(rawAmount);
    sumByOrder.set(ref.key, next);
  }

  for (const [key, sum] of sumByOrder) {
    if (orderKeysWithUnknownAmount.has(key)) continue;
    const state = remedyStates.get(key);
    if (!state?.found) continue;
    if (sum > state.remaining_refundable_cents) {
      const sumDollars = (sum / 100).toFixed(2);
      const remainingDollars = (state.remaining_refundable_cents / 100).toFixed(2);
      // Find the first money action targeting this key so the violation names a real actionIndex.
      let violatingIndex = -1;
      let violatingType = "";
      for (let i = 0; i < actions.length; i++) {
        const step = actions[i];
        if (!MONEY_ACTION_TYPES.has(step.actionType)) continue;
        if (isNonOrderScopedLoyaltyAction(step.actionType, step.actionParams)) continue;
        const ref = extractRemedyOrderRefFromStep(step.actionParams);
        if (ref?.key === key) {
          violatingIndex = i;
          violatingType = step.actionType;
          break;
        }
      }
      return {
        ok: false,
        violation: {
          actionIndex: violatingIndex,
          actionType: violatingType,
          orderKey: key,
          reason: "amount_exceeds_remaining_refundable",
          detail: `money remedy sums to $${sumDollars} on order ${key} but remaining refundable is $${remainingDollars} — refuses to double-pay`,
        },
      };
    }
  }

  return { ok: true };
}

/**
 * Prefetch the live remedy state for every UNIQUE money-action order reference in the plan.
 * Non-money actions are ignored; money actions with no resolvable order ref are skipped (the pure
 * guard flags them with `missing_order_reference`). Deduped by `RemedyOrderRef.key` so N actions
 * on the same order cost ONE state read, not N. Same shape the pure guard consumes.
 */
export async function loadRemedyStatesForPlan(
  admin: Admin,
  workspaceId: string,
  actions: readonly RemedyActionStep[],
): Promise<Map<string, CxOrderRemedyState>> {
  const refs = new Map<string, RemedyOrderRef>();
  for (const step of actions) {
    if (!MONEY_ACTION_TYPES.has(step.actionType)) continue;
    // Same exemption as `verifyPlanAgainstRemedyStates` — a subscription-scoped loyalty coupon
    // (or the paired mint) names no order to prefetch state for.
    if (isNonOrderScopedLoyaltyAction(step.actionType, step.actionParams)) continue;
    const ref = extractRemedyOrderRefFromStep(step.actionParams);
    if (ref && !refs.has(ref.key)) refs.set(ref.key, ref);
  }
  if (refs.size === 0) return new Map();
  const { getOrderRemedyState } = await import("@/lib/cx-agent-sdk");
  const entries = await Promise.all(
    [...refs.values()].map(async (ref) => {
      const state = await getOrderRemedyState(admin, workspaceId, remedyOrderRefToState(ref));
      return [ref.key, state] as const;
    }),
  );
  return new Map(entries);
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
  /**
   * Phase 1 of a-money-remedy-must-read-the-live-remedy-state-first — prefetch live remedy state
   * per unique target order for the § 3⁰ hard-reject guard. Injectable so tests can bypass the
   * Supabase read + seed states directly. Default resolves to `loadRemedyStatesForPlan`, which
   * does the real deduped `getOrderRemedyState` fan-out.
   */
  loadRemedyStates?: (
    admin: Admin,
    workspaceId: string,
    actions: readonly RemedyActionStep[],
  ) => Promise<Map<string, CxOrderRemedyState>>;
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
  loadRemedyStates: loadRemedyStatesForPlan,
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
    // Multi-action label (Phase 2 of multi-action-remedies): the whole batch, in June's authored
    // order, surfaced on the tag so logs + log_tail carry the full fix shape (not just actions[0]).
    const plannedActionTypes = planned.plan.actions.map((a) => a.actionType);
    const batchLabel =
      plannedActionTypes.length === 1
        ? `action=${plannedActionTypes[0]}`
        : `actions=[${plannedActionTypes.join(", ")}] (${plannedActionTypes.length})`;

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

    // 3⁰. LIVE REMEDY-STATE HARD-REJECT (spec:
    //     a-money-remedy-must-read-the-live-remedy-state-first Phase 1 § bullet 3). Reads
    //     [[../tables/returns]] + [[../tables/order_refunds]] + [[../tables/orders]] for every
    //     money action's target order via `loadRemedyStatesForPlan`, then runs the pure
    //     `verifyPlanAgainstRemedyStates` guard. A LIVE un-refunded return on the target order OR
    //     a summed money amount above remaining refundable value fails CLOSED (needs_attention →
    //     human) — NEVER parks for founder approval (parking a double-pay would ask the CEO to
    //     sign off on a spend the rails should block outright, which is the exact UX regression the
    //     Jan Bloom ticket exposed). Non-money-only batches are a no-op — the guard runs the empty
    //     verdict path. Ordering: BEFORE loyalty ceiling + BEFORE founder gate so a proposer
    //     targeting a double-pay is refused before either rail sees it.
    //
    //     The prefetched states are also THREADED into the founder-approval gate below (§ 3b) so
    //     the SMS/cockpit preview carries "existing return: label_created, refund on receipt" for
    //     any proposal that survives this rail — the "surface on the founder card" bullet.
    let remedyStatesForCard: import("@/lib/june-remedy-approval").RemedyStateForFounderCard[] = [];
    if (verdict.remedy) {
      const loadStates = deps.loadRemedyStates ?? loadRemedyStatesForPlan;
      const remedyStates = await loadStates(admin, workspaceId, planned.plan.actions);
      const guard = verifyPlanAgainstRemedyStates(planned.plan.actions, remedyStates);
      if (!guard.ok) {
        const error = `approve_remedy: remedy state guard rejected — ${guard.violation.reason} (${guard.violation.detail})`;
        console.warn(`${tag} ${error}`);
        return {
          ok: false,
          handler: "approve_remedy",
          needs_attention: true,
          reason: `remedy_state_${guard.violation.reason}`,
          error,
        };
      }
      const { remedyStatesForCardFromMap } = await import("@/lib/june-remedy-approval");
      remedyStatesForCard = remedyStatesForCardFromMap(remedyStates);
    }

    // 3a. LOYALTY-CEILING HARD-REFUSAL (spec:
    //     loyalty-remedy-hard-cap-15-no-cashout-makewhole-june-never-escalates Phase 3). A loyalty
    //     benefit ABOVE `LOYALTY_REMEDY_MAX_CENTS` (default $15) is the CEO's absolute rail — no
    //     cash-out, make-whole, or expiry-extension. Runs BEFORE the founder-approval gate so an
    //     over-cap loyalty make-whole is REFUSED (needs_attention → human), never parked as a
    //     "may I grant this?" ask to the founder (the pre-Phase-3 failure mode on ticket 2ba3b665
    //     where June computed a ~$150 make-whole and escalated the question). Refuses only on a
    //     KNOWN over-cap value — an unsized loyalty payload falls through to the founder gate's
    //     unknown-collapse-to-null rule (pre-existing conservative gating).
    if (verdict.remedy) {
      const { planNeedsLoyaltyRefusal } = await import("@/lib/june-remedy-approval");
      const loyaltyRefusal = planNeedsLoyaltyRefusal(planned.plan.actions);
      if (loyaltyRefusal.refused) {
        const error = `approve_remedy: ${loyaltyRefusal.reason}`;
        console.warn(`${tag} ${error}`);
        return {
          ok: false,
          handler: "approve_remedy",
          needs_attention: true,
          reason: "loyalty_ceiling_refused",
          error,
        };
      }
    }

    // 3b. FOUNDER-APPROVAL GATE (Cora/June dial-in). A refund/credit over the workspace threshold is
    //     NOT auto-executed — June parks it, raises a plain-language card into Eve's cockpit, and texts
    //     the founder for a yes/no/ask decision. The deferred sweep (executeApprovedJuneRemedies, box
    //     ~60s beat) fires it on approve. Everything else (date changes, coupons within limit,
    //     replacements, sub-threshold refunds) runs autonomously below. See [[june-remedy-approval]].
    if (verdict.remedy) {
      const { getRefundApprovalThresholdCents, planNeedsFounderApproval, raiseJuneRemedyApproval } =
        await import("@/lib/june-remedy-approval");
      const threshold = await getRefundApprovalThresholdCents(admin, workspaceId);
      // Gate on the NORMALIZED planned actions (the exact set the executor will fire), not on the
      // raw remedy. Reading `planned.plan.actions[].actionType` means the money-sum the gate asserts
      // is guaranteed to match what executes — no payload-side field can name a different action
      // type than the one gated.
      const gate = planNeedsFounderApproval(planned.plan.actions, threshold);
      if (gate.gated) {
        const raised = await raiseJuneRemedyApproval(admin, {
          workspaceId,
          ticketId,
          remedy: verdict.remedy,
          actionType: gate.actionType || actionType,
          amountCents: gate.amountCents,
          // Phase 3 (multi-action-remedies): thread the per-money-action lines through so the
          // preview lists each line + SUM, and the card's tool_input surfaces the split.
          moneyLines: gate.moneyLines,
          reasoning: verdict.reasoning,
          // Phase 1 of a-money-remedy-must-read-the-live-remedy-state-first § bullet 4 — the
          // live remedy state we already read for the § 3⁰ hard-reject, threaded onto the
          // founder card preview so any proposal that survives the rail is visibly grounded in
          // the order's real refunded_so_far + open-return state.
          remedyStates: remedyStatesForCard,
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
    // Capture the executor's per-action sysNote stream so a failed batch can surface WHICH action
    // failed + what DID land on the returned error string + a summary internal note (Phase 2 of
    // multi-action-remedies). The delegate still writes each raw line to ticket_messages so the
    // audit thread's per-line trail is unchanged — the events buffer is a parallel roll-up only.
    const batchEvents: BatchActionEvent[] = [];
    const sysNote = async (msg: string): Promise<void> => {
      const parsed = parseBatchEvent(msg);
      if (parsed) batchEvents.push(parsed);
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
      const errMsg = errText(e);
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

    // 7. Failure path: executor escalated (one or more actions in the batch failed run/verify). No
    //    customer message — the whole reason this executor exists is to NOT promise something we
    //    didn't do. Roll the captured per-action events into a partial-batch summary so the runner's
    //    log_tail names WHICH action failed + what DID land (Phase 2 of multi-action-remedies) —
    //    without that surface a human eyeballing the ticket has to reconstruct the state from N
    //    ticket_messages sysNote rows.
    if (executorResult.escalated) {
      const summary = summarizeRemedyBatchOutcome(plannedActionTypes, batchEvents);
      const error = `approve_remedy: ${batchLabel} escalated by executor (${summary.oneLine}) — no customer message sent`;
      // Also emit a rolled-up internal note so a human sees the partial-batch state in one place.
      await sysNote(`Batch escalated — ${summary.oneLine}. No customer message sent.`);
      console.warn(`${tag} ${error}`);
      // ── Phase 2 of create-subscription-internal-branch-cannot-create-a-subscription ──
      // When the escalated batch included a terminal assisted-purchase action (create_subscription
      // / create_order), escalate the ticket AND mint the CEO card via the shared helper. Susan
      // Bellamy's ticket sat `open` + `escalated_to = null` through this exact path on 2026-08-09
      // ("Batch escalated — ... No customer message sent" logged but the ticket was untouched);
      // the same "customer already consented to buy" surface must not fail quietly.
      const failedAssistedStep = planned.plan.actions.find(
        (a) =>
          (a.actionType === "create_subscription" || a.actionType === "create_order") &&
          batchEvents.some((ev) => ev.kind === "failed" && ev.label === a.actionType),
      );
      if (failedAssistedStep) {
        const { escalateAndCardOnAssistedPurchaseFailure } = await import(
          "@/lib/assisted-purchase-failure-escalate"
        );
        const failedEvent = batchEvents.find(
          (ev) => ev.kind === "failed" && ev.label === failedAssistedStep.actionType,
        );
        await escalateAndCardOnAssistedPurchaseFailure({
          admin,
          wsId: workspaceId,
          tid: ticketId,
          customer: { id: facts.customer_id },
          params: failedAssistedStep.actionParams,
          actionType: failedAssistedStep.actionType as "create_subscription" | "create_order",
          failureError: failedEvent?.error ?? summary.oneLine,
          origin: "director_remedy",
          jobId: null,
        });
      }
      return {
        ok: false,
        handler: "approve_remedy",
        needs_attention: true,
        reason: "remedy_action_escalated",
        error,
      };
    }

    // 8. Success path: EVERY action in the batch verified — deliver the customer message. If June
    //    did not include one (rare — the prompt strongly implies one on approve_remedy, but the
    //    shape is Record<string, unknown> so it can be missing), we still return ok — the actions
    //    fired, and the runner's per-verdict internal note + ticket transition close the loop.
    if (customerMessage) {
      try {
        // Substitute action-result placeholders ({{label_url}} → CTA button,
        // {{tracking_number}}, {{carrier}}, {{refund_amount}}, {{coupon_code}})
        // BEFORE delivery. The executor normally does this inside its own send
        // path, but we suppress that send (execute-then-message ordering), so we
        // must run it here against the batch results the executor stashed on
        // ctx — otherwise June's `{{label_url}}` ships literally to the customer
        // (ticket eca3f43b). substituteActionPlaceholders also strips any
        // still-unsubstituted token as a last resort, so a literal `{{…}}` can
        // never reach the customer even if an action produced no value.
        const { substituteActionPlaceholders } = await import("@/lib/action-executor");
        const filledMessage = substituteActionPlaceholders(customerMessage, ctx._lastActionResults ?? []);
        await deps.deliverMessage(admin, workspaceId, ticketId, ctx.channel, filledMessage, sandbox);
        console.log(`${tag} approve_remedy: ${batchLabel} ok · customer message delivered`);
        return { ok: true, handler: "approve_remedy", message_delivered: true };
      } catch (e) {
        const errMsg = errText(e);
        const error = `approve_remedy: ${batchLabel} succeeded but delivery threw (${errMsg})`;
        console.warn(`${tag} ${error}`);
        // The batch DID fire; the delivery race is a real failure (customer didn't hear back) so
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

    console.log(`${tag} approve_remedy: ${batchLabel} ok · no customer message on remedy (skipped delivery)`);
    return { ok: true, handler: "approve_remedy", message_delivered: false };
  } catch (e) {
    const errMsg = errText(e);
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
 *
 * june-authored-specs-carry-machine-runnable-checks Phase 1 — the phase carries a `checks[]` with an
 * unconditional `exec_kind:'tsc'` floor. The SDK's `assertEveryPhaseHasChecks` requires >=1 check
 * with an auto-testable `exec_kind` per phase (`MissingMachineCheckError` otherwise), and the seed
 * arrives with no proposed check, so a phase authored by this builder used to throw every time —
 * measured 3-for-3 on 2026-08-06 / 08-07 / 08-10, 0 specs ever authored via this path. The floor is
 * appended unconditionally — no seed-supplied check can reduce the phase back below one machine
 * check — so this can never regress. The prose `verification` still renders on the card; prose is
 * allowed as EXTRA alongside a machine check, only the sole-verification case is rejected.
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
        // Unconditional floor — same shape [[author-spec]] `buildStructuredSpecInputFromMarkdown`
        // uses. `exec_kind:'tsc'` is in `AUTO_TESTABLE_EXEC_KINDS`, satisfies
        // `assertEveryPhaseHasChecks`, and is universally valid regardless of the ticket topic.
        checks: [
          {
            position: 1,
            description: "Repo typechecks clean (`npx tsc --noEmit`) after this phase lands.",
            kind: "auto",
            exec_kind: "tsc",
            params: null,
          },
        ],
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

/**
 * Phase-2 stale-recheck threshold in hours (spec: a-founder-escalated-customer-never-waits-in-
 * silence Phase 2 — "a founder-escalated ticket with no founder action for two days, where the
 * customer has written again, comes back to June to re-check whether it is still genuinely a
 * founder call"). A founder-escalated ticket is considered "stale" once its `escalated_at` is at
 * least `STALE_FOUNDER_ESCALATION_HOURS` old — the [[../inngest/founder-escalation-stale-recheck]]
 * cron then re-enqueues a `cs-director-call` so June re-reads with fresh state.
 *
 * Declared HERE (in the file the escalate_founder path lives in) so the founder-escalation stale
 * contract is findable in one place — the cron mirrors it in
 * `src/lib/inngest/founder-escalation-stale-recheck.ts` under the local alias
 * `FOUNDER_STALE_RECHECK_HOURS` (same env override so both stay in sync). The 48h default is the
 * tightest cutoff that would have caught all three worst multi-day stalls the spec measured
 * (232h jleone@earthlink.net · 75h bellamyjs@msn.com · 46h jhb222@aol.com — 46h narrowly
 * qualifies) without waking June for routine same-day CEO reviews.
 */
export const STALE_FOUNDER_ESCALATION_HOURS = Number(
  process.env.FOUNDER_STALE_RECHECK_HOURS || 48,
);

/**
 * Read the `recheck_index` field the Phase-2 stale-recheck sweep stamps on
 * `agent_jobs.instructions` (see src/lib/inngest/founder-escalation-stale-recheck.ts
 * `buildFounderRecheckInstructions`). Returns 0 when the field is absent — the initial June
 * review — so `composeFounderEscalationAck` picks its first variant. Returns 0 on a resolve blip
 * too (the spec's fallback is "still acknowledge, just with the first-invocation text" — a
 * DB read failing must NEVER be why the customer hears nothing).
 */
async function resolveRecheckIndexFromJob(admin: Admin, jobId: string): Promise<number> {
  try {
    const { data: jobRow } = await admin
      .from("agent_jobs")
      .select("instructions")
      .eq("id", jobId)
      .maybeSingle();
    if (!jobRow) return 0;
    const inst = (jobRow as { instructions: string | null }).instructions;
    if (!inst) return 0;
    const parsed = JSON.parse(inst) as { recheck_index?: unknown };
    const raw = parsed && typeof parsed.recheck_index === "number" ? parsed.recheck_index : 0;
    if (!Number.isFinite(raw) || raw < 0) return 0;
    return Math.floor(raw);
  } catch {
    return 0;
  }
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
      const errMsg = errText(e);
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
    const errMsg = errText(e);
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
 * Compose a one-line human summary of a `PartialRemedyOutcome`. Pure — the runner (and the CEO
 * card builder) call this so a reader sees the same phrasing across the internal note + the
 * dashboard card + the log_tail.
 */
export function summarizePartialRemedyOutcome(outcome: PartialRemedyOutcome): string {
  const list = (arr: string[]) => (arr.length > 0 ? arr.join(", ") : "(none)");
  switch (outcome.status) {
    case "landed":
      return `June already fired the in-leash actions: [${list(outcome.landed_actions)}]${outcome.message_delivered ? " · customer notified" : ""}.`;
    case "failed":
      return `June attempted the in-leash actions [${list(outcome.planned_action_types)}] but the executor escalated — landed: [${list(outcome.landed_actions)}]; failed: [${outcome.failed_actions.map((f) => (f.error ? `${f.label} — ${f.error}` : f.label)).join("; ") || "(unspecified)"}]. No customer message sent.`;
    case "loyalty_refused":
      return `June's proposed in-leash actions [${list(outcome.planned_action_types)}] were REFUSED by the loyalty ceiling — the CEO decides the whole ticket.`;
    case "threshold_gated":
      return `June's proposed in-leash actions [${list(outcome.planned_action_types)}] are ABOVE the founder-approval money threshold — not auto-fired; the CEO decides the whole ticket.`;
    case "delivery_failed":
      return `June's in-leash actions [${list(outcome.landed_actions)}] LANDED but the customer message delivery failed — the CEO card and residue still stand.`;
    case "malformed":
    default:
      return `June proposed a partial remedy that could not be executed (${outcome.refusal_reason ?? "malformed"}) — the CEO decides the whole ticket.`;
  }
}

/**
 * Run June's `verdict.remedy` on the `escalate_founder` path as the IN-LEASH partial fix. Shares
 * the same primitives `handleApproveRemedy` uses (plan → resolve ticket → facts → sandbox →
 * loyalty ceiling → money-threshold gate → executor → deliver-after-success) so a partial remedy
 * never bypasses a rail the approve_remedy path enforces (loyalty ceiling, money threshold, the
 * execute-then-message ordering). The differences from approve_remedy:
 *
 *  - On loyalty-ceiling or money-threshold REJECT, we do NOT park via Eve's SMS — we're already
 *    escalating to the CEO, and parking the same remedy on the founder's phone would double-notify
 *    the same seat. We return `loyalty_refused` / `threshold_gated` so the founder card carries
 *    the whole picture (June proposed X, ceiling/threshold refused it, CEO now decides).
 *  - On executor failure, we don't park `needs_attention` — the whole ticket is already escalated,
 *    and the CEO card carries "attempted, failed" concretely. The founder is the human who eyeballs.
 *  - The result is a compact `PartialRemedyOutcome` (not a full ApplyBoxCsDirectorCallResult) that
 *    the runner passes to `buildEscalateFounderCard` verbatim to render the "already did / residue"
 *    body sections.
 *
 * Never throws — a thrown executor / delivery caller returns a `failed` / `delivery_failed`
 * outcome so the caller can proceed to mint the founder card.
 */
export async function runPartialRemedyForEscalation(
  admin: Admin,
  jobId: string,
  workspaceId: string,
  verdict: CsDirectorVerdictInput,
  deps: ApproveRemedyDeps = defaultApproveRemedyDeps,
  /**
   * Optional acknowledgement text to APPEND to the partial-remedy's customer message before
   * delivery (spec: a-founder-escalated-customer-never-waits-in-silence Phase 1 — "when a partial
   * remedy already sent its own customer_message, do NOT send a second one; append to that
   * instead"). When provided:
   *   • partial has a customerMessage → deliver `${customerMessage}\n\n${ack}` (one send).
   *   • partial has no customerMessage → deliver JUST the ack (one send).
   * The customer gets ONE message either way. `message_delivered:true` on the outcome tells
   * handleEscalateFounder the ack was consumed by the partial; it does NOT send a second copy.
   * Null / omitted keeps the pre-spec behavior — only the partial's own customerMessage is sent.
   */
  acknowledgementSuffix: string | null = null,
): Promise<PartialRemedyOutcome> {
  const tag = `[cs-director:${jobId.slice(0, 8)}]`;
  const planned = planRemedyExecution(verdict.remedy);
  if (!planned.ok) {
    console.warn(`${tag} escalate_founder partial-remedy: plan malformed (${planned.reason}) — no action fired`);
    return {
      status: "malformed",
      summary: `partial remedy plan malformed (${planned.reason})`,
      landed_actions: [],
      failed_actions: [],
      message_delivered: false,
      planned_action_types: [],
      refusal_reason: planned.reason,
    };
  }
  const plannedActionTypes = planned.plan.actions.map((a) => a.actionType);

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
      /* fall through */
    }
  }
  if (!ticketId) {
    console.warn(`${tag} escalate_founder partial-remedy: ticket_id not resolvable — nothing fired`);
    return {
      status: "malformed",
      summary: "partial remedy could not resolve ticket_id",
      landed_actions: [],
      failed_actions: [],
      message_delivered: false,
      planned_action_types: plannedActionTypes,
      refusal_reason: "ticket_id_unresolved",
    };
  }

  const facts = await deps.loadTicketFacts(admin, ticketId);
  if (!facts || !facts.customer_id) {
    console.warn(`${tag} escalate_founder partial-remedy: ticket ${ticketId.slice(0, 8)} has no customer_id — nothing fired`);
    return {
      status: "malformed",
      summary: "partial remedy could not resolve customer",
      landed_actions: [],
      failed_actions: [],
      message_delivered: false,
      planned_action_types: plannedActionTypes,
      refusal_reason: "ticket_missing_customer",
    };
  }
  const sandbox = await deps.loadWorkspaceSandbox(admin, workspaceId);

  // LIVE REMEDY-STATE HARD-REJECT (Phase 1 of a-money-remedy-must-read-the-live-remedy-state-first
  // § bullet 3, escalate-path). Same guard handleApproveRemedy runs — a partial remedy on the
  // escalate_founder path must not double-pay a live return either. Rejection surfaces as a
  // `failed` outcome with the specific reason so the CEO card body names why the partial did not
  // land, and no customer message is sent.
  const loadStates = deps.loadRemedyStates ?? loadRemedyStatesForPlan;
  const remedyStates = await loadStates(admin, workspaceId, planned.plan.actions);
  const remedyStateGuard = verifyPlanAgainstRemedyStates(planned.plan.actions, remedyStates);
  if (!remedyStateGuard.ok) {
    const v = remedyStateGuard.violation;
    const summary = `remedy state guard refused: ${v.reason} on order ${v.orderKey} (${v.detail})`;
    console.warn(`${tag} escalate_founder partial-remedy: ${summary}`);
    return {
      status: "failed",
      summary,
      landed_actions: [],
      failed_actions: [{ label: v.actionType || "(unknown)", error: v.reason }],
      message_delivered: false,
      planned_action_types: plannedActionTypes,
      refusal_reason: `remedy_state_${v.reason}`,
    };
  }

  // Loyalty ceiling — same hard-refusal as handleApproveRemedy. An over-cap loyalty benefit stays
  // out of scope on the escalate path too; we surface it as `loyalty_refused` so the founder card
  // names the refusal (never a silent skip).
  const { planNeedsLoyaltyRefusal, getRefundApprovalThresholdCents, planNeedsFounderApproval } =
    await import("@/lib/june-remedy-approval");
  const loyaltyRefusal = planNeedsLoyaltyRefusal(planned.plan.actions);
  if (loyaltyRefusal.refused) {
    console.warn(`${tag} escalate_founder partial-remedy: ${loyaltyRefusal.reason}`);
    return {
      status: "loyalty_refused",
      summary: loyaltyRefusal.reason ?? "loyalty ceiling refused the partial remedy",
      landed_actions: [],
      failed_actions: [],
      message_delivered: false,
      planned_action_types: plannedActionTypes,
      refusal_reason: "loyalty_ceiling_refused",
    };
  }

  // Money-threshold gate — same sum-across-batch semantics as approve_remedy. On the escalate
  // path we do NOT park via Eve's SMS: the CEO is already the target of the escalation, and
  // double-notifying the same seat would be noise. `threshold_gated` on the outcome carries the
  // whole picture into the founder card body.
  const threshold = await getRefundApprovalThresholdCents(admin, workspaceId);
  const gate = planNeedsFounderApproval(planned.plan.actions, threshold);
  if (gate.gated) {
    console.warn(`${tag} escalate_founder partial-remedy: money-threshold gate refused (amount=${gate.amountCents ?? "unknown"} threshold=${threshold})`);
    return {
      status: "threshold_gated",
      summary: `partial remedy exceeds the $${(threshold / 100).toFixed(2)} founder-approval threshold${gate.amountCents != null ? ` (sum $${(gate.amountCents / 100).toFixed(2)})` : " (unknown amount)"} — not auto-fired`,
      landed_actions: [],
      failed_actions: [],
      message_delivered: false,
      planned_action_types: plannedActionTypes,
      refusal_reason: "threshold_gated",
    };
  }

  const decision = buildRemedySonnetDecision(planned.plan, verdict.reasoning);
  const suppressedSend = async (_msg: string, _sb: boolean): Promise<void> => {
    /* no-op — customer message is delivered by deliverTicketMessage below, only after success */
  };
  const batchEvents: BatchActionEvent[] = [];
  const sysNote = async (msg: string): Promise<void> => {
    const parsed = parseBatchEvent(msg);
    if (parsed) batchEvents.push(parsed);
    try {
      await admin.from("ticket_messages").insert({
        ticket_id: ticketId,
        direction: "outbound",
        visibility: "internal",
        author_type: "system",
        body: `[cs-director/escalate_founder/partial] ${msg}`,
      });
    } catch {
      /* best-effort */
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

  let executorResult: { messageSent: boolean; escalated: boolean; closed: boolean; statusManaged: boolean };
  try {
    executorResult = await deps.runExecutor(ctx, decision, suppressedSend, sysNote);
  } catch (e) {
    const errMsg = errText(e);
    console.warn(`${tag} escalate_founder partial-remedy: executor threw (${errMsg})`);
    return {
      status: "failed",
      summary: `partial remedy executor threw: ${errMsg}`,
      landed_actions: [],
      failed_actions: [{ label: plannedActionTypes[0] ?? "(unknown)", error: errMsg }],
      message_delivered: false,
      planned_action_types: plannedActionTypes,
      refusal_reason: "executor_threw",
    };
  }

  const rollup = summarizeRemedyBatchOutcome(plannedActionTypes, batchEvents);
  if (executorResult.escalated) {
    console.warn(`${tag} escalate_founder partial-remedy: executor escalated (${rollup.oneLine}) — no customer message sent`);
    await sysNote(`Partial remedy batch escalated — ${rollup.oneLine}. No customer message sent (CEO card carries the residue).`);
    return {
      status: "failed",
      summary: `executor escalated — ${rollup.oneLine}`,
      landed_actions: rollup.landed,
      failed_actions: rollup.failed,
      message_delivered: false,
      planned_action_types: plannedActionTypes,
      refusal_reason: "remedy_action_escalated",
    };
  }

  const customerMessage = planned.plan.customerMessage;
  const ackSuffix = acknowledgementSuffix && acknowledgementSuffix.trim().length > 0 ? acknowledgementSuffix : null;
  if (customerMessage || ackSuffix) {
    try {
      let bodyToDeliver: string;
      if (customerMessage) {
        const { substituteActionPlaceholders } = await import("@/lib/action-executor");
        const filledMessage = substituteActionPlaceholders(customerMessage, ctx._lastActionResults ?? []);
        bodyToDeliver = ackSuffix ? `${filledMessage}\n\n${ackSuffix}` : filledMessage;
      } else {
        bodyToDeliver = ackSuffix!;
      }
      await deps.deliverMessage(admin, workspaceId, ticketId, ctx.channel, bodyToDeliver, sandbox);
      console.log(`${tag} escalate_founder partial-remedy landed · customer message delivered (residue → CEO)${ackSuffix ? " · ack appended" : ""}`);
      return {
        status: "landed",
        summary: `landed: [${rollup.landed.join(", ") || plannedActionTypes.join(", ")}]${customerMessage ? "" : " (ack-only)"}`,
        landed_actions: rollup.landed.length > 0 ? rollup.landed : plannedActionTypes,
        failed_actions: [],
        message_delivered: true,
        planned_action_types: plannedActionTypes,
        refusal_reason: null,
      };
    } catch (e) {
      const errMsg = errText(e);
      console.warn(`${tag} escalate_founder partial-remedy: actions verified but delivery threw (${errMsg})`);
      return {
        status: "delivery_failed",
        summary: `actions landed but customer message delivery threw: ${errMsg}`,
        landed_actions: rollup.landed.length > 0 ? rollup.landed : plannedActionTypes,
        failed_actions: [],
        message_delivered: false,
        planned_action_types: plannedActionTypes,
        refusal_reason: "delivery_threw_after_success",
      };
    }
  }

  console.log(`${tag} escalate_founder partial-remedy landed · no customer message on remedy`);
  return {
    status: "landed",
    summary: `landed: [${rollup.landed.join(", ") || plannedActionTypes.join(", ")}] (no customer message)`,
    landed_actions: rollup.landed.length > 0 ? rollup.landed : plannedActionTypes,
    failed_actions: [],
    message_delivered: false,
    planned_action_types: plannedActionTypes,
    refusal_reason: null,
  };
}

// ── escalate_founder acknowledgement (spec: a-founder-escalated-customer-never-waits-in-silence) ─

/**
 * Internal-note marker prefix used to idempotency-guard the escalate_founder acknowledgement.
 * Written to `ticket_messages` as an internal outbound note AFTER the ack is successfully
 * delivered. A subsequent handleEscalateFounder invocation for the SAME `job_id` checks for this
 * marker and skips resending — a retry of the same job must not send a second ack to the customer.
 * Namespaced by job_id so a Phase-2 re-check enqueues a distinct director-call job that can send
 * its own (different) acknowledgement without tripping this guard.
 */
const ESCALATE_FOUNDER_ACK_MARKER_PREFIX = "[cs-director/escalate_founder/ack]";

/**
 * Compose the honest, no-handoff-language acknowledgement the customer sees when their ticket
 * has just been escalated to the founder (spec: a-founder-escalated-customer-never-waits-in-
 * silence Phase 1 — "acknowledge, in Suzie's voice, with no handoff language" · Phase 2 — "send
 * the customer a second, different acknowledgement — never the same text twice").
 *
 * Voice invariants — enforced verbatim by Phase 3's pin test but ALSO the reason this function
 * is pure/exported (so a future edit can be caught by the pin instead of shipping):
 *  - NEVER says the ticket has been escalated / passed to a manager / sent to another team / a
 *    human will follow up. The customer should feel Suzie is still on it — internal routing is
 *    invisible to them (see [[../customer-voice]] § "internal routing is invisible").
 *  - NO timeframe. The honest answer on the founder lane is often days; any number we quote here
 *    will be wrong. No "shortly", "24 hours", "as soon as possible".
 *  - Names the SPECIFIC THING being looked at (the ticket subject when we have it, else a
 *    non-generic fallback) so the message reads as a person who read their note, not as an
 *    autoresponder.
 *  - Suzie's voice — first person, continuing to own it. Per [[../customer-voice]]: plain text,
 *    at most two sentences per paragraph, signed "Suzie". No re-greet (this is always turn N>1
 *    on a ticket already in an escalation cycle).
 *  - Deterministic for a given `(subject, recheckIndex)`, so the pin test can assert the exact
 *    output shape.
 *
 * `recheckIndex` (default 0) selects among distinct phrasings so a stale re-check (Phase 2)
 * never re-sends the SAME text — the spec measured 232h / 75h / 46h waits where Susan Bellamy
 * sent four more messages into silence. `0` is the initial escalation. `1` is the first stale
 * re-check (48h later, customer wrote again). `2` is the second re-check (the cap). Beyond the
 * cap the cron does not enqueue a new job, so we never need a fourth variant.
 */
export function composeFounderEscalationAck(opts: { subject: string | null; recheckIndex?: number }): string {
  const topic = normalizeAckTopic(opts.subject);
  const idx = Math.max(0, Math.min(2, Math.floor(opts.recheckIndex ?? 0)));
  const lines = FOUNDER_ACK_VARIANTS[idx];
  return `${lines.body.replace("{topic}", topic)}\n\nSuzie`;
}

/**
 * Three distinct acknowledgement bodies, one per recheckIndex position. The wording changes
 * substantially between variants (opening verb, framing) so no two consecutive acks read as the
 * same text — that's the Phase-2 "never the same text twice" rule. Every variant is written as
 * Suzie continuing to own it, contains no handoff / manager / team / timeframe language, and
 * names the specific topic. The Phase-3 pin test asserts these invariants across ALL three.
 */
const FOUNDER_ACK_VARIANTS: ReadonlyArray<{ body: string }> = [
  { body: "I want to make sure I get this right for you, so I'm taking a proper look at {topic} before I come back to you." },
  { body: "I haven't forgotten about you — I'm still working through {topic} carefully so my answer is the right one, and I'll write again as soon as I have it." },
  { body: "I know you've been waiting on me, and I owe you an honest update: {topic} needs a call I want to get exactly right, and I'm still on it. I'll be back with you as soon as I can say something worth saying." },
];

const GENERIC_ACK_TOPIC = "what you've written in";

/**
 * The variants splice this into "taking a proper look at {topic} before I come back to
 * you", so it has to read as a thing, not a paragraph.
 *
 * The failing case (ticket d17c7b1c, Kimberly): her subject WAS the whole request —
 * "Recent order - though I ordered k-cups can I send this back and reorder the k-cups".
 * At 82 chars the old code trimmed it to 80 and sent her:
 *
 *   "…taking a proper look at Recent order - though I ordered k-cups can I send this
 *    back and reorder the… before I come back to you."
 *
 * Truncation was the bug. A subject too long to splice cannot be repaired by cutting it
 * mid-clause, so it falls back to the generic phrase. Subjects that fit are still named
 * specifically — that's the spec's subject-scoped invariant and it stays.
 */
function normalizeAckTopic(subject: string | null | undefined): string {
  if (!subject) return GENERIC_ACK_TOPIC;
  let s = String(subject).trim();
  // Strip common thread-reply prefixes so the sentence reads naturally ("looking at Your order"
  // is fine; "looking at Re: Your order" is not). Repeated Re:/Fwd: chains are collapsed.
  for (let i = 0; i < 4; i += 1) {
    const stripped = s.replace(/^(re|fw|fwd)\s*:\s*/i, "");
    if (stripped === s) break;
    s = stripped.trim();
  }
  if (!s) return GENERIC_ACK_TOPIC;
  // Too long to splice → generic. Never truncate: a half-sentence read back to the
  // customer is worse than not naming the topic at all.
  if (s.length > 80) return GENERIC_ACK_TOPIC;
  return s;
}

/**
 * Idempotency guard for the escalate_founder acknowledgement (spec: a-founder-escalated-customer-
 * never-waits-in-silence Phase 1 — "re-running the handler must not send a second acknowledgement").
 * Checks for an internal note with the ack marker referencing THIS job_id. A retry of the same
 * job sees the marker and short-circuits; a Phase-2 re-check runs as a distinct job_id and can
 * send its own (different) acknowledgement.
 */
async function ackAlreadyDeliveredForJob(admin: Admin, ticketId: string, jobId: string): Promise<boolean> {
  try {
    const marker = `${ESCALATE_FOUNDER_ACK_MARKER_PREFIX} job=${jobId}`;
    const { data } = await admin
      .from("ticket_messages")
      .select("id")
      .eq("ticket_id", ticketId)
      .eq("visibility", "internal")
      .like("body", `${marker}%`)
      .limit(1);
    return Array.isArray(data) && data.length > 0;
  } catch {
    // Fail-open on a DB blip — losing an ack retry is worse than a rare double-send. The marker
    // insert below is best-effort too; both surfaces log on failure.
    return false;
  }
}

async function recordAckDeliveredMarker(
  admin: Admin,
  ticketId: string,
  jobId: string,
  channel: string,
  via: "partial_appended" | "standalone_send",
): Promise<void> {
  try {
    await admin.from("ticket_messages").insert({
      ticket_id: ticketId,
      direction: "outbound",
      visibility: "internal",
      author_type: "system",
      body: `${ESCALATE_FOUNDER_ACK_MARKER_PREFIX} job=${jobId} via=${via} channel=${channel}`,
    });
  } catch {
    /* best-effort — an insert blip is not worth failing the whole escalation over */
  }
}

/**
 * Fetch the shape handleEscalateFounder needs to (a) compose the ack (subject) and (b) deliver
 * it (customer_id + channel + sandbox). Returns null on any resolution miss so the caller can
 * skip ack sending cleanly instead of throwing — matches the tolerance the existing linkage
 * resolution already uses (a synthetic dispatch without a ticket_id logs a warning + returns).
 */
async function loadAckFacts(
  admin: Admin,
  workspaceId: string,
  ticketId: string,
): Promise<{ subject: string | null; customerId: string; channel: string; sandbox: boolean } | null> {
  const { data: t } = await admin
    .from("tickets")
    .select("subject, customer_id, channel")
    .eq("id", ticketId)
    .maybeSingle();
  if (!t) return null;
  const row = t as { subject: string | null; customer_id: string | null; channel: string | null };
  if (!row.customer_id) return null;
  const channel = row.channel || "email";
  const { data: ws } = await admin
    .from("workspaces")
    .select("sandbox_mode")
    .eq("id", workspaceId)
    .maybeSingle();
  const sandbox = (ws as { sandbox_mode?: boolean } | null)?.sandbox_mode === true;
  return { subject: row.subject ?? null, customerId: row.customer_id, channel, sandbox };
}

/**
 * Phase 3 executor for `escalate_founder` (docs/brain/specs/cs-director-call-phase-2-executor-fires-
 * june-verdicts.md § Phase 3 · extended by june-does-the-in-leash-part-before-escalating-the-residue
 * Phase 1 · a-founder-escalated-customer-never-waits-in-silence Phase 1). FORMALIZES THE LINKAGE-BACK
 * CONTRACT — the runner is the SOLE WRITER of the CEO `dashboard_notifications` card per
 * [[../../docs/brain/specs/escalate-founder-reliably-creates-the-ceo-inbox-card-with-diagnosis-and-
 * recommendation]] (minted after this executor returns), and this handler NEVER mints a second card
 * (a duplicate would page the CEO twice).
 *
 * What the executor DOES on Phase 3:
 *  - Resolves the ticket_id + triage_run_id from `job.instructions` — the same values the runner
 *    reads to stamp the card's metadata (`metadata.ticket_id` / `metadata.triage_run_id`), so the
 *    two writers agree on the linkage.
 *  - When `verdict.remedy` is present (the june-does-the-in-leash-part contract): fires the
 *    in-leash actions FIRST via `runPartialRemedyForEscalation` — same plan → executor → deliver
 *    primitives approve_remedy uses, same loyalty + money-threshold rails. The compact
 *    `PartialRemedyOutcome` returns on the result so the runner threads it into the CEO card body
 *    ("June already did X; the CEO owns Y") instead of presenting settled work as an open item.
 *  - Returns linkage as `linkage_ticket_id` + `linkage_triage_run_id` so the runner's `log_tail`
 *    names the linkage in a machine-readable form. This IS the "record the linkage back to the
 *    originating ticket / triage_run" verification bullet — a bounce-back handler / audit join can
 *    pull the linkage off the result without re-reading the CEO card's JSON metadata blob.
 *
 * A missing ticket_id here is NOT a needs_attention — it's the same shape drift class the runner's
 * Phase-1 guard already caught at enqueue time, so we log a warning and return `ok:true` with a
 * `null` linkage. The runner's audit row on `director_activity` is the primary trail regardless.
 */
async function handleEscalateFounder(
  admin: Admin,
  jobId: string,
  workspaceId: string,
  verdict: CsDirectorVerdictInput,
  deps: ApproveRemedyDeps = defaultApproveRemedyDeps,
): Promise<ApplyBoxCsDirectorCallResult> {
  const tag = `[cs-director:${jobId.slice(0, 8)}]`;
  try {
    // ── Phase 1 (a-founder-escalated-customer-never-waits-in-silence): compose the customer
    // acknowledgement BEFORE running the partial so it can be appended to the partial's own
    // customer_message on the delivery path (spec: "the customer gets one message and not two").
    // A resolve miss on the ticket / customer / channel drops the ack silently — the escalation
    // itself still succeeds; a synthetic dispatch without a ticket_id is the same shape drift
    // the linkage resolver already tolerates below.
    //
    // Phase 2: read `instructions.recheck_index` (stamped by the stale-founder-escalation-recheck
    // sweep — src/lib/inngest/founder-escalation-stale-recheck.ts) and thread it into the ack
    // composer so a second/third invocation on the same ticket sends a DIFFERENT text rather
    // than the same greeting twice. Zero / null means this is the initial escalation.
    const linkageEarly = await resolveLinkageFromJob(admin, jobId);
    const recheckIndex = await resolveRecheckIndexFromJob(admin, jobId);
    let ackText: string | null = null;
    let ackFacts: Awaited<ReturnType<typeof loadAckFacts>> = null;
    let ackAlreadySent = false;
    if (linkageEarly.ticketId) {
      ackAlreadySent = await ackAlreadyDeliveredForJob(admin, linkageEarly.ticketId, jobId);
      if (!ackAlreadySent) {
        ackFacts = await loadAckFacts(admin, workspaceId, linkageEarly.ticketId);
        if (ackFacts) {
          ackText = composeFounderEscalationAck({ subject: ackFacts.subject, recheckIndex });
        } else {
          console.warn(`${tag} escalate_founder: cannot resolve ack facts for ticket ${linkageEarly.ticketId.slice(0, 8)} — skipping acknowledgement`);
        }
      } else {
        console.log(`${tag} escalate_founder: ack marker present for ticket ${linkageEarly.ticketId.slice(0, 8)} · skipping duplicate send`);
      }
    }

    // Fire the in-leash partial remedy FIRST when the verdict carried one — the residue described
    // on the CEO card must reflect what June already did, not the whole ticket. Same rails as
    // approve_remedy (loyalty ceiling, money-threshold gate, execute-then-deliver); a refusal on
    // either rail surfaces as `loyalty_refused` / `threshold_gated` on the outcome so the CEO card
    // still names both June's proposal and why nothing fired. Threads `ackText` into the partial
    // so a landed partial with a customer_message delivers ONE combined send (partial body + ack).
    let partialOutcome: PartialRemedyOutcome | null = null;
    if (verdict.remedy && typeof verdict.remedy === "object" && !Array.isArray(verdict.remedy)) {
      partialOutcome = await runPartialRemedyForEscalation(admin, jobId, workspaceId, verdict, deps, ackText);
      console.log(`${tag} escalate_founder partial-remedy status=${partialOutcome.status}`);
    }

    // Standalone ack send: no partial ran (verdict carried no remedy) OR the partial did not
    // deliver a customer message (refused / gated / failed / delivery threw). Either way, the
    // customer must hear from Suzie — the spec's whole point.
    let ackDeliveredVia: "partial_appended" | "standalone_send" | null = null;
    if (ackText && ackFacts && !ackAlreadySent) {
      if (partialOutcome?.message_delivered) {
        ackDeliveredVia = "partial_appended";
      } else {
        try {
          await deps.deliverMessage(
            admin,
            workspaceId,
            linkageEarly.ticketId!,
            ackFacts.channel,
            ackText,
            ackFacts.sandbox,
          );
          ackDeliveredVia = "standalone_send";
          console.log(`${tag} escalate_founder: ack delivered standalone (no partial customer message)`);
        } catch (e) {
          console.warn(`${tag} escalate_founder: ack delivery threw (non-fatal):`, e instanceof Error ? e.message : e);
        }
      }
      if (ackDeliveredVia && linkageEarly.ticketId) {
        await recordAckDeliveredMarker(admin, linkageEarly.ticketId, jobId, ackFacts.channel, ackDeliveredVia);
      }
    }

    const linkage = linkageEarly;
    if (!linkage.ticketId) {
      console.warn(`${tag} escalate_founder: no ticket_id in job.instructions — linkage payload will be null`);
    } else {
      console.log(
        `${tag} escalate_founder: linkage ticket=${linkage.ticketId.slice(0, 8)}${linkage.triageRunId ? ` triage_run=${linkage.triageRunId.slice(0, 8)}` : ""} — CEO card minted by runner (single writer)`,
      );
      // Founder directive: "anything June seeks from me should be a straight-up approval." When the
      // escalation carries a recommended remedy, ALSO raise an Eve SMS approval so the founder taps
      // Approve/Decline on their phone (executeApprovedJuneRemedies runs it on Approve) — not just a
      // silent CEO dashboard card. The runner still mints the dashboard card as the durable record.
      const recommended = verdict.recommended_remedy;
      if (recommended && typeof recommended === "object" && !Array.isArray(recommended)) {
        try {
          const { raiseFounderApproval, remedyStatesForCardFromMap } = await import("@/lib/june-remedy-approval");
          // Phase 1 of a-money-remedy-must-read-the-live-remedy-state-first § bullet 4 — read
          // the live remedy state for the recommended remedy's target orders so the founder-card
          // preview surfaces "existing return: label_created, refund on receipt" (or the clean
          // remaining refundable) at approval time. Best-effort — a state-read failure leaves the
          // card intact.
          let recommendedRemedyStates: import("@/lib/june-remedy-approval").RemedyStateForFounderCard[] = [];
          try {
            const recommendedPlanned = planRemedyExecution(recommended as Record<string, unknown>);
            if (recommendedPlanned.ok) {
              const states = await loadRemedyStatesForPlan(admin, workspaceId, recommendedPlanned.plan.actions);
              recommendedRemedyStates = remedyStatesForCardFromMap(states);
            }
          } catch {
            /* best-effort — the founder card renders without the state block on failure */
          }
          const raised = await raiseFounderApproval(admin, {
            workspaceId,
            ticketId: linkage.ticketId,
            remedy: recommended as Record<string, unknown>,
            reasoning: verdict.reasoning || "June escalated this to you for a call.",
            remedyStates: recommendedRemedyStates,
          });
          console.log(`${tag} escalate_founder: founder SMS approval ${raised.via} (${raised.approvalId ? raised.approvalId.slice(0, 8) : "no-card"})`);
        } catch (e) {
          console.warn(`${tag} escalate_founder: raiseFounderApproval failed (non-fatal):`, e instanceof Error ? e.message : e);
        }
      }
    }
    return {
      ok: true,
      handler: "escalate_founder",
      linkage_ticket_id: linkage.ticketId,
      linkage_triage_run_id: linkage.triageRunId,
      partial_remedy_outcome: partialOutcome,
      message_delivered: partialOutcome?.message_delivered ?? false,
    };
  } catch (e) {
    const errMsg = errText(e);
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

// ── Phase 3 of cs-director-call-loop-guard-and-message-only-remedy ─────────────────────────────

/**
 * Detect the ONE class of misuse the message_only verb refuses: a remedy that ALSO carries
 * mutation-shaped fields (`action_type` / `actions[]`). The whole safety of `message_only` is that
 * it CANNOT touch money or accounts — a mutation smuggled in via a mis-typed verdict would silently
 * turn a "just tell the customer" outcome into an executed refund/cancel/etc. Pure so the guard
 * can be exercised in a unit test without booting the executor.
 */
export function messageOnlyRemedyHasMutation(remedy: Record<string, unknown> | null | undefined): boolean {
  if (!remedy) return false;
  if (typeof remedy.action_type === "string" && remedy.action_type.trim().length > 0) return true;
  if (Array.isArray(remedy.actions) && remedy.actions.length > 0) return true;
  return false;
}

/**
 * Phase 3 executor for `message_only`
 * ([[../../docs/brain/specs/cs-director-call-loop-guard-and-message-only-remedy]] § Phase 3).
 * Sends the customer-facing explanation from `verdict.remedy.customer_message` via the SAME
 * `deliverTicketMessage` primitive `approve_remedy` uses (which wraps [[tickets-reply]]
 * `sendThreadedReply`), then RESOLVES the ticket via the runner's transition patch
 * ([[cs-director-ticket-transition]] `close_and_deescalate`). NO account or money mutation — the
 * whole point is that a settled-money ticket needs only a message; running the executor would
 * open the door back to a double-pay (the derived-from ticket 86043da0 failure mode).
 *
 * Guards (all park `needs_attention` — never silently upgrade to a mutation, never promise a
 * fix we couldn't ship):
 *  - `verdict.remedy` missing a customer_message → `message_only_missing_message`.
 *  - `verdict.remedy` carries an `action_type` / `actions[]` → `message_only_mutation_attempt`
 *    (the mis-use class the verb's safety depends on rejecting).
 *  - `ticket_id` unresolvable from `job.instructions` → `ticket_id_unresolved` (no addressee).
 *  - `tickets` row missing customer_id / channel → `ticket_missing_customer`.
 *  - `deliverMessage` threw → `delivery_threw` (a real failure — the customer didn't hear back).
 *
 * Never throws — every failure returns a structured result so the runner logs it on `log_tail`
 * and parks the job. The message is delivered EXACTLY ONCE per verdict (no executor to loop).
 */
async function handleMessageOnly(
  admin: Admin,
  jobId: string,
  workspaceId: string,
  verdict: CsDirectorVerdictInput,
  deps: ApproveRemedyDeps = defaultApproveRemedyDeps,
): Promise<ApplyBoxCsDirectorCallResult> {
  const tag = `[cs-director:${jobId.slice(0, 8)}]`;
  try {
    // 1. Guard: a message_only remedy MUST NOT carry a mutation. This is the safety of the verb
    //    ("no money or account mutation is involved"): a mis-typed verdict that names an action
    //    is refused, never silently upgraded to approve_remedy.
    if (messageOnlyRemedyHasMutation(verdict.remedy)) {
      const error = `message_only: remedy carries mutation-shaped fields (action_type / actions[]) — refused, no delivery`;
      console.warn(`${tag} ${error}`);
      return {
        ok: false,
        handler: "message_only",
        needs_attention: true,
        reason: "message_only_mutation_attempt",
        error,
      };
    }

    // 2. Extract the customer message. Reuses the same field-name heuristic approve_remedy uses
    //    (`customer_message` canonical + `response_message` / `message` / `customer_reply` fallbacks)
    //    so the verdict shape is consistent across verbs.
    const message = verdict.remedy ? extractRemedyCustomerMessage(verdict.remedy) : null;
    if (!message || !message.trim()) {
      const error = `message_only: no customer_message on verdict.remedy — nothing to send, no resolution`;
      console.warn(`${tag} ${error}`);
      return {
        ok: false,
        handler: "message_only",
        needs_attention: true,
        reason: "message_only_missing_message",
        error,
      };
    }

    // 3. Resolve the ticket_id from job.instructions (same shape approve_remedy + author_spec read).
    const linkage = await resolveLinkageFromJob(admin, jobId);
    if (!linkage.ticketId) {
      const error = `message_only: ticket_id not resolvable from job.instructions — no addressee, no delivery`;
      console.warn(`${tag} ${error}`);
      return {
        ok: false,
        handler: "message_only",
        needs_attention: true,
        reason: "ticket_id_unresolved",
        error,
      };
    }

    // 4. Resolve customer + channel + sandbox for delivery.
    const facts = await deps.loadTicketFacts(admin, linkage.ticketId);
    if (!facts || !facts.customer_id) {
      const error = `message_only: ticket ${linkage.ticketId.slice(0, 8)} has no customer_id — no delivery`;
      console.warn(`${tag} ${error}`);
      return {
        ok: false,
        handler: "message_only",
        needs_attention: true,
        reason: "ticket_missing_customer",
        error,
      };
    }
    const sandbox = await deps.loadWorkspaceSandbox(admin, workspaceId);
    const channel = facts.channel || "email";

    // 5. Deliver via the SAME primitive approve_remedy uses (deliverTicketMessage → sendThreadedReply
    //    under the hood). No placeholder substitution: message_only NEVER runs an executor, so there
    //    are no action results to substitute against — an authored `{{label_url}}` would be a bug
    //    (June should not reference an action result in a no-mutation reply), and we ship the message
    //    verbatim rather than run substituteActionPlaceholders with an empty result set.
    try {
      await deps.deliverMessage(admin, workspaceId, linkage.ticketId, channel, message, sandbox);
      console.log(`${tag} message_only: customer message delivered (ticket=${linkage.ticketId.slice(0, 8)})`);
      return { ok: true, handler: "message_only", message_delivered: true };
    } catch (e) {
      const errMsg = errText(e);
      const error = `message_only: delivery threw (${errMsg}) — customer did not hear back`;
      console.warn(`${tag} ${error}`);
      return {
        ok: false,
        handler: "message_only",
        needs_attention: true,
        reason: "delivery_threw",
        error,
      };
    }
  } catch (e) {
    const errMsg = errText(e);
    console.error(`${tag} handleMessageOnly threw:`, errMsg);
    return {
      ok: false,
      handler: "message_only",
      needs_attention: true,
      reason: "handler_threw",
      error: `message_only: handler threw (${errMsg})`,
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
    if (verdict.decision === "escalate_founder") {
      return handleEscalateFounder(admin, jobId, job.workspace_id, verdict, approveRemedyDeps);
    }
    // Phase 3 of cs-director-call-loop-guard-and-message-only-remedy — the new no-mutation verb.
    // Reuses the ApproveRemedyDeps bag so tests share the same dep injection shape; the handler
    // itself only exercises loadTicketFacts / loadWorkspaceSandbox / deliverMessage (never
    // runExecutor — the whole point of the verb is no account/money mutation).
    if (verdict.decision === "message_only") {
      return handleMessageOnly(admin, jobId, job.workspace_id, verdict, approveRemedyDeps);
    }

    // close_no_action — nothing to execute here. The runner's `decideCsDirectorTicketTransition`
    // closes + de-escalates the ticket; June already reasoned it's a correctly-handled no-op with no
    // in-leash remedy and no founder call. No CEO card, no remedy fire — just a clean handler tag so
    // the audit/log_tail reads `handler=close_no_action` instead of the generic drift no-op.
    if (verdict.decision === "close_no_action") {
      console.log(`[cs-director:${jobId.slice(0, 8)}] close_no_action — no execution; runner closes + de-escalates.`);
      return { ok: true, handler: "close_no_action" };
    }

    console.log(`[cs-director:${jobId.slice(0, 8)}] no actionable decision ('${String(verdict.decision)}') — clean no-op`);
    return { ok: true, handler: "noop" };
  } catch (e) {
    console.error(`[cs-director] applyBoxCsDirectorCall threw:`, e instanceof Error ? e.message : e);
    return { ok: false, reason: errText(e) };
  }
}

/* ------------------------------------------------------------------------------------------------
 * Phase 2 of a-policies-chokepoint-so-published-and-internal-rules-cannot-contradict —
 * June's brief consumes the SAME policy package Sol reads.
 *
 * Before this wiring, `src/lib/cs-director.ts` carried ZERO policy references while
 * `sonnet-orchestrator-v2.ts` carried 21 — the more-authoritative agent (June overrules Sol
 * and rules on money) was reasoning from ticket text alone. It showed on 2026-07-28 when
 * June escalated a plain post-renewal cancellation to the founder TWICE, when the Refund
 * Policy answers it outright (renewals are not refundable once charged, path is a labelled
 * return). A director holding the policy would have closed it.
 *
 * `loadDirectorPolicyBrief` returns the plain-text CURRENT POLICIES block the CS-director-call
 * brief loader (`scripts/builder-worker.ts` `loadCsDirectorCallBrief`) embeds. The rules are
 * loaded via `getAgentPolicyPackage` (INTERNAL half only + machine-readable `rules[]` — never
 * `customer_summary`) and rendered via `formatAgentPolicyPackage` — the SAME assembly Sol's
 * `buildPoliciesSection` uses. Best-effort: a load failure returns an empty string so the
 * base brief still renders (June is instructed in the prompt to escalate rather than guess
 * when the policy block is missing, mirroring how Sol treats an empty catalog).
 * --------------------------------------------------------------------------------------------- */

/**
 * Returns the CURRENT POLICIES block June's brief embeds — the same shared package Sol reads
 * via the policies SDK. INTERNAL half only (`internal_summary` + `rules`); never
 * `customer_summary`. Empty string on empty rules or on load failure.
 */
export async function loadDirectorPolicyBrief(admin: Admin, workspaceId: string): Promise<string> {
  try {
    const entries = await getAgentPolicyPackage(admin, workspaceId);
    if (!entries.length) return "";
    const block = formatAgentPolicyPackage(entries);
    return [
      "--- CURRENT POLICIES (the rulebook — your verdict MUST reflect these; NEVER approve a remedy or escalate that talks past an active rule) ---",
      block,
    ].join("\n\n");
  } catch (e) {
    return `CURRENT POLICIES: read failed — ${errText(e)}`;
  }
}
