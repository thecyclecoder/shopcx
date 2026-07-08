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
 * PHASE 1 (this file): SCAFFOLD wired after the runner's `recordDirectorActivity` write.
 *   - The routing is real: `approve_remedy` / `author_spec` / `escalate_founder` land at their own
 *     handlers. Any other decision value (a shape drift or a defensive fallback out of
 *     `normalizeCsDirectorVerdict`) is a logged no-op — still audited by the Phase-1 record, still
 *     returned as `{ ok: true, handler: 'noop' }` so the runner treats it as a clean pass-through.
 *   - The three per-decision handlers currently STUB their execution — they log the routing so the
 *     audit ledger + `log_tail` show WHAT would have fired, but they do NOT mutate anything yet. That
 *     lands in Phase 2 (`approve_remedy` → `executeSonnetDecision` + `deliverTicketMessage`) and
 *     Phase 3 (`author_spec` → `authorSpecRowStructured` / `escalate_founder` → CEO-inbox card).
 *   - Never throws — returns a structured `ApplyBoxCsDirectorCallResult` so the runner can log it on
 *     the agent_jobs row, mirroring the deploy-review contract.
 *
 * Read-only guarantee for Phase 1: this file does NOT touch `tickets` / `ticket_messages` /
 * `dashboard_notifications` / `specs`. Every one of those writes is a stub logging its intent so a
 * Phase-1 misfire never mutates prod. Phase 2/3 turn each stub into a real call inside the same
 * function boundary — the runner keeps calling `applyBoxCsDirectorCall` unchanged.
 *
 * See [[../../docs/brain/libraries/cs-director]] · [[deploy-guardian]] ·
 * [[../../docs/brain/tables/director_activity]].
 */
import type { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

export type CsDirectorDecision = "approve_remedy" | "author_spec" | "escalate_founder";

/**
 * The verdict shape the CS Director emits — mirrors `CsDirectorVerdict` in
 * scripts/builder-worker.ts (kept structurally compatible so the runner can pass its normalized
 * verdict verbatim). The runner is the sole normalization site (`normalizeCsDirectorVerdict`).
 *
 * - `remedy` — the AUTO-APPLY RemedyPlan on `approve_remedy` (Phase 2 fires it through
 *   `executeSonnetDecision`).
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
 * - `reason` — populated when `ok:false` (a job lookup miss / a thrown catch). Follows the same
 *   opaque-string shape as deploy-guardian's result reasons.
 */
export interface ApplyBoxCsDirectorCallResult {
  ok: boolean;
  handler?: "approve_remedy" | "author_spec" | "escalate_founder" | "noop";
  reason?: string;
}

/**
 * Phase 2 executor stub for `approve_remedy`. Phase 2 (docs/brain/specs/cs-director-call-phase-2-
 * executor-fires-june-verdicts.md) will:
 *   1. Fire the typed remedy via `executeSonnetDecision` (or the matching commerce SDK action for
 *      `action_type` — e.g. `change_next_date` → `subscriptionUpdateNextBillingDate`).
 *   2. On success → deliver the remedy's customer message via `deliverTicketMessage` and de-
 *      escalate + close the ticket.
 *   3. On failure → surface `needs_attention` and send NO customer message (never promise an action
 *      that didn't happen).
 * Phase 1 is a logged no-op so the routing contract exists but the action layer stays untouched.
 */
async function handleApproveRemedy(
  _admin: Admin,
  jobId: string,
  _verdict: CsDirectorVerdictInput,
): Promise<ApplyBoxCsDirectorCallResult> {
  console.log(`[cs-director:${jobId.slice(0, 8)}] approve_remedy routed (Phase 1 scaffold — executor stub, no action fired)`);
  return { ok: true, handler: "approve_remedy" };
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
  console.log(`[cs-director:${jobId.slice(0, 8)}] author_spec routed (Phase 1 scaffold — specs SDK stub, no spec authored)`);
  return { ok: true, handler: "author_spec" };
}

/**
 * Phase 3 executor stub for `escalate_founder`. The runner (`runCsDirectorCallJob`) already mints the
 * CEO `dashboard_notifications` card on every `escalate_founder` verdict per
 * [[../../docs/brain/specs/escalate-founder-reliably-creates-the-ceo-inbox-card-with-diagnosis-and-recommendation]] —
 * so Phase 1 of this executor is a logged no-op that acknowledges the routing without a second
 * insert. Phase 3 of this spec formalizes the card contract inside the executor (single writer, one
 * consistent shape) and adds the linkage back to the originating ticket / triage_run.
 */
async function handleEscalateFounder(
  _admin: Admin,
  jobId: string,
  _verdict: CsDirectorVerdictInput,
): Promise<ApplyBoxCsDirectorCallResult> {
  console.log(`[cs-director:${jobId.slice(0, 8)}] escalate_founder routed (Phase 1 scaffold — CEO card minted by runner; executor stub, no second write)`);
  return { ok: true, handler: "escalate_founder" };
}

/**
 * Apply June's typed verdict to the artifact behind ONE `kind='cs-director-call'` agent_jobs row
 * (docs/brain/specs/cs-director-call-phase-2-executor-fires-june-verdicts.md Phase 1 — the SCAFFOLD;
 * Phase 2/3 build the actual handlers).
 *
 * The runner (`runCsDirectorCallJob` in scripts/builder-worker.ts) calls this ONCE per job,
 * immediately after `recordDirectorActivity` writes the Phase-1 audit row — so the mutator sees the
 * SAME normalized verdict the audit trail carries. Decision routing:
 *
 *  - `approve_remedy`   → `handleApproveRemedy` (Phase 2 fires via `executeSonnetDecision` + then
 *                         messages via `deliverTicketMessage`; Phase 1 is a logged stub).
 *  - `author_spec`      → `handleAuthorSpec` (Phase 3 authors via the specs SDK; Phase 1 stub).
 *  - `escalate_founder` → `handleEscalateFounder` (Phase 3 formalizes; the runner already mints the
 *                         CEO card, so Phase 1 stub logs the routing and returns clean).
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

    if (verdict.decision === "approve_remedy") return handleApproveRemedy(admin, jobId, verdict);
    if (verdict.decision === "author_spec") return handleAuthorSpec(admin, jobId, verdict);
    if (verdict.decision === "escalate_founder") return handleEscalateFounder(admin, jobId, verdict);

    console.log(`[cs-director:${jobId.slice(0, 8)}] no actionable decision ('${String(verdict.decision)}') — clean no-op`);
    return { ok: true, handler: "noop" };
  } catch (e) {
    console.error(`[cs-director] applyBoxCsDirectorCall threw:`, e instanceof Error ? e.message : e);
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}
