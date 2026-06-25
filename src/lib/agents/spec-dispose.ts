/**
 * spec-dispose — Ada's director-disposition lane ([[../specs/spec-review-agent]] Phase 3).
 *
 * The pipeline shape (CEO design):
 *
 *   author creates spec → Spec Review (Vale, quality) → DIRECTOR (Ada) decides Planned vs Deferred → Build
 *
 * An author only PROPOSES; a director DISPOSES. Phase 3 narrows Vale to QUALITY ONLY (pass/needs_fix) and
 * introduces this DISPOSITION lane: Vale-passed `in_review` specs (the ones carrying `flags.vale_pass=true`
 * and `flags.intended_status`) are routed by Ada with an **asymmetric** check vs the author's suggestion:
 *
 *   - **same** (planned→planned, deferred→deferred): AUTONOMOUS, applied silently.
 *   - **UPGRADE** (suggested `deferred`, Ada wants `planned`): GATED — a one-click CEO Approval Request
 *     (Planned / Deferred) + Ada's reason WHY. She'd be spending more than the author proposed; the CEO
 *     confirms before the spec joins the build queue.
 *   - **DOWNGRADE** (suggested `planned`, Ada wants `deferred`): AUTONOMOUS, applied silently — BUT a
 *     CEO notification ("I moved this to deferred — want it built now? [Build now → planned]") with the
 *     short note WHY surfaces. One-click override returns the spec to `planned`.
 *
 * The disposition function (`adaDispositionFor`) is the policy seam. Phase 3 ships a TRUST-THE-AUTHOR
 * default — Ada agrees with `intended_status` unless a future heuristic upgrades or downgrades; the
 * UPGRADE / DOWNGRADE plumbing is fully wired, so a richer evaluator can drop in without ceremony.
 *
 * The disposition writer is the ONLY component that flips a Vale-passed `in_review` spec; the sweep is
 * idempotent (a card already carrying `flags.ada_disposition` is skipped) so a cron re-fire never
 * double-applies.
 */
import type { createAdminClient } from "@/lib/supabase/admin";
import {
  applyAdaDisposition,
  markSpecCardPendingUpgrade,
  type SpecCardFlags,
} from "@/lib/spec-card-state";
import { recordDirectorActivity } from "@/lib/director-activity";
import { APPROVAL_REQUEST_TYPE } from "@/lib/agents/inbox";

type Admin = ReturnType<typeof createAdminClient>;

/** The Platform/DevOps director's function slug — Ada disposes; activity rows + escalations route to her. */
const PLATFORM = "platform";
/** The CEO routes UPGRADE approvals + DOWNGRADE notifications via the standard agent inbox. */
const CEO = "ceo";

/** The asymmetric branches a disposition can land on (mirrors the spec language). */
export type AdaDispositionKind = "same" | "upgrade" | "downgrade";

export interface AdaDecision {
  kind: AdaDispositionKind;
  decision: "planned" | "deferred";
  intended: "planned" | "deferred";
  /** Plain-text WHY — Ada's reasoning, recorded on every disposition (audit + CEO surfaces). */
  reason: string;
}

/**
 * One row per Vale-passed `in_review` spec — the cohort Ada's disposition lane operates on. Selected
 * directly off `spec_card_state` (no markdown parse — the DB is the spec). A row whose
 * `flags.ada_disposition` is already set is skipped (idempotent re-fire); a row whose
 * `flags.intended_status` is missing falls back to `planned` (the safe historical default — every
 * in_review row is a NEW spec, where the author's bias is to build).
 */
export interface DispositionCandidate {
  slug: string;
  intended: "planned" | "deferred";
}

export async function selectDispositionCandidates(
  admin: Admin,
  workspaceId: string,
): Promise<DispositionCandidate[]> {
  const { data, error } = await admin
    .from("spec_card_state")
    .select("spec_slug, status, flags")
    .eq("workspace_id", workspaceId)
    .eq("status", "in_review");
  if (error || !data) return [];
  const out: DispositionCandidate[] = [];
  for (const r of data as Array<{ spec_slug: string; status: string; flags: SpecCardFlags | null }>) {
    const flags = r.flags ?? {};
    if (!flags.vale_pass) continue; // Vale hasn't passed it yet — not Ada's turn.
    if (flags.ada_disposition) continue; // already disposed (autonomous flip already landed) or parked (pending_upgrade) — skip.
    if (flags.deferred) continue; // an out-of-band defer already happened — leave it for the operator.
    const intended: "planned" | "deferred" = flags.intended_status === "deferred" ? "deferred" : "planned";
    out.push({ slug: r.spec_slug, intended });
  }
  return out;
}

/**
 * Ada's per-spec disposition decision — the POLICY seam. Phase 3 ships a TRUST-THE-AUTHOR default:
 * she agrees with `intended_status`, so the asymmetric check always lands on `kind="same"` and the
 * sweep flips the card silently. The UPGRADE / DOWNGRADE plumbing is wired (writers + CEO inbox card +
 * notification) so a future heuristic (build capacity, criticality, blocker pressure) can drop in here
 * and the rest of the lane keeps working — no policy change needed downstream.
 *
 * The reason string is the human-readable WHY the CEO sees on a non-`same` row + the audit trail on
 * a `same` row; keep it short and specific.
 */
export function adaDispositionFor(candidate: DispositionCandidate): AdaDecision {
  // Phase 3 baseline — trust the author. A real evaluator (criticality / capacity / blocker pressure)
  // can later upgrade or downgrade here and the rest of the lane handles the asymmetric routing.
  return {
    kind: "same",
    decision: candidate.intended,
    intended: candidate.intended,
    reason: `Author's intended destination matches my read of build priority — flipping to ${candidate.intended}.`,
  };
}

/**
 * Apply ONE Ada disposition end-to-end:
 *   - same → flip the card via `applyAdaDisposition` (autonomous, silent).
 *   - downgrade → flip to deferred via `applyAdaDisposition` + emit a CEO notification (one-click override).
 *   - upgrade → DO NOT flip; park `flags.ada_disposition='pending_upgrade'` + emit a CEO Approval Request
 *               carrying the asymmetric Planned/Deferred choice. The CEO's pick resolves it via the standard
 *               status writers (the existing `/api/roadmap/status` route handles the un-defer / build flip).
 *
 * Idempotent + best-effort: a notification failure logs a warning but never blocks the card flip on
 * downgrade (the CEO's deep-link surface still has the row); an Approval Request insert failure on
 * upgrade leaves the card un-flipped so the next sweep retries. Records one `director_activity` row per
 * dispose action so the audit ledger reflects the full Phase-3 vocabulary.
 */
export async function applyAdaDispositionDecision(
  admin: Admin,
  workspaceId: string,
  candidate: DispositionCandidate,
  decision: AdaDecision,
): Promise<{ applied: "same" | "downgrade" | "upgrade_proposed"; ok: boolean; reason?: string }> {
  const actor = "director:platform";
  const reason = decision.reason.slice(0, 1000);

  try {
    if (decision.kind === "same") {
      await applyAdaDisposition(workspaceId, candidate.slug, decision.decision, "autonomous_same", {
        actor,
        reason,
      });
      await recordDirectorActivity(admin, {
        workspaceId,
        directorFunction: PLATFORM,
        actionKind: "spec_dispose_same",
        specSlug: candidate.slug,
        reason,
        metadata: { intended: candidate.intended, decision: decision.decision, autonomous: true },
      });
      return { applied: "same", ok: true };
    }

    if (decision.kind === "downgrade") {
      // Author suggested planned; Ada defers — AUTONOMOUS flip + CEO notification (override → planned).
      await applyAdaDisposition(workspaceId, candidate.slug, "deferred", "autonomous_downgrade", { actor, reason });
      const notifResult = await emitDowngradeNotification(admin, workspaceId, candidate.slug, reason);
      await recordDirectorActivity(admin, {
        workspaceId,
        directorFunction: PLATFORM,
        actionKind: "spec_dispose_downgrade",
        specSlug: candidate.slug,
        reason,
        metadata: { intended: candidate.intended, decision: "deferred", notification: notifResult.ok, autonomous: true },
      });
      return { applied: "downgrade", ok: true };
    }

    // UPGRADE — author suggested deferred, Ada wants planned. GATED: park + Approval Request.
    const proposalResult = await emitUpgradeApprovalRequest(admin, workspaceId, candidate.slug, reason);
    if (!proposalResult.ok) {
      // Don't park if the surface failed — the next sweep retries the proposal.
      return { applied: "upgrade_proposed", ok: false, reason: proposalResult.reason };
    }
    await markSpecCardPendingUpgrade(workspaceId, candidate.slug, { actor, reason });
    await recordDirectorActivity(admin, {
      workspaceId,
      directorFunction: PLATFORM,
      actionKind: "spec_dispose_upgrade_proposed",
      specSlug: candidate.slug,
      reason,
      metadata: { intended: candidate.intended, proposed: "planned", autonomous: false, gated: true },
    });
    return { applied: "upgrade_proposed", ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[spec-dispose] applyAdaDispositionDecision failed for ${candidate.slug}:`, msg);
    return { applied: decision.kind === "upgrade" ? "upgrade_proposed" : decision.kind, ok: false, reason: msg };
  }
}

/**
 * Emit ONE CEO notification on a downgrade: "I moved {slug} to deferred — want it built now?"
 * Reuses the agent inbox `agent_approval_request` envelope so the CEO sees it in the standard Approval
 * Requests tab; the deep-link routes them to the spec card where the existing un-defer / Build affordances
 * live (no inline approve needed — the autonomous flip already landed). Deduped on
 * `metadata.dedupe_key=ada-downgrade:{slug}`.
 */
async function emitDowngradeNotification(
  admin: Admin,
  workspaceId: string,
  slug: string,
  reason: string,
): Promise<{ ok: boolean; reason?: string }> {
  const dedupeKey = `ada-downgrade:${slug}`;
  const { data: prior } = await admin
    .from("dashboard_notifications")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("type", APPROVAL_REQUEST_TYPE)
    .eq("metadata->>dedupe_key", dedupeKey)
    .limit(1);
  if ((prior ?? []).length > 0) return { ok: true, reason: "deduped" };

  const body = `🛠️ Ada (Platform/DevOps Director): I moved this to deferred for now — want it built now? Override on the spec card.\n${reason}`.slice(0, 4000);
  const { error } = await admin.from("dashboard_notifications").insert({
    workspace_id: workspaceId,
    type: APPROVAL_REQUEST_TYPE,
    title: `Deferred ${slug} — override?`,
    body,
    link: `/dashboard/roadmap/${slug}`,
    metadata: {
      routed_to_function: CEO,
      escalated_by_director: PLATFORM,
      escalation_kind: "spec_dispose_downgrade",
      escalation_reason: reason.slice(0, 2000),
      dedupe_key: dedupeKey,
      spec_slug: slug,
      deep_link: `/dashboard/roadmap/${slug}`,
      approve_action_id: null,
    },
    read: false,
    dismissed: false,
  });
  if (error) {
    console.warn(`[spec-dispose] downgrade notification insert failed for ${slug}:`, error.message);
    return { ok: false, reason: error.message };
  }
  return { ok: true };
}

/**
 * Emit ONE CEO Approval Request on an UPGRADE proposal: a 2-button card (Planned / Deferred) + Ada's
 * reason. The Approval Request is the standard agent-inbox shape (`agent_approval_request`), routed to
 * the CEO; the inline-approve action id is null because the choice is binary (planned vs deferred) and
 * not the standard build-gate approve/decline — the CEO clicks through to the spec card and uses the
 * existing un-defer / Build affordances to resolve. Deduped on `metadata.dedupe_key=ada-upgrade:{slug}`.
 */
async function emitUpgradeApprovalRequest(
  admin: Admin,
  workspaceId: string,
  slug: string,
  reason: string,
): Promise<{ ok: boolean; reason?: string }> {
  const dedupeKey = `ada-upgrade:${slug}`;
  const { data: prior } = await admin
    .from("dashboard_notifications")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("type", APPROVAL_REQUEST_TYPE)
    .eq("metadata->>dedupe_key", dedupeKey)
    .limit(1);
  if ((prior ?? []).length > 0) return { ok: true, reason: "deduped" };

  const body = `🛠️ Ada (Platform/DevOps Director): The author suggested deferred, but I think this should be built now. Approve to flip to Planned, or keep Deferred.\n${reason}`.slice(0, 4000);
  const { error } = await admin.from("dashboard_notifications").insert({
    workspace_id: workspaceId,
    type: APPROVAL_REQUEST_TYPE,
    title: `Build ${slug} now? (UPGRADE proposal)`,
    body,
    link: `/dashboard/roadmap/${slug}`,
    metadata: {
      routed_to_function: CEO,
      escalated_by_director: PLATFORM,
      escalation_kind: "spec_dispose_upgrade_proposed",
      escalation_reason: reason.slice(0, 2000),
      dedupe_key: dedupeKey,
      spec_slug: slug,
      deep_link: `/dashboard/roadmap/${slug}`,
      approve_action_id: null,
    },
    read: false,
    dismissed: false,
  });
  if (error) {
    console.warn(`[spec-dispose] upgrade Approval Request insert failed for ${slug}:`, error.message);
    return { ok: false, reason: error.message };
  }
  return { ok: true };
}

/**
 * Full disposition sweep — find every Vale-passed `in_review` spec the lane hasn't touched and apply
 * Ada's decision to each. Intended to run from a director pass (Ada's standing cron) or the
 * spec-review-cron tail. Returns per-branch counts for the pass log.
 */
export async function runAdaDispositionSweep(
  admin: Admin,
  workspaceId: string,
): Promise<{ scanned: number; same: number; downgraded: number; upgrade_proposed: number; failed: number }> {
  const candidates = await selectDispositionCandidates(admin, workspaceId);
  let same = 0;
  let downgraded = 0;
  let upgrade_proposed = 0;
  let failed = 0;
  for (const c of candidates) {
    const decision = adaDispositionFor(c);
    const r = await applyAdaDispositionDecision(admin, workspaceId, c, decision);
    if (!r.ok) failed++;
    else if (r.applied === "same") same++;
    else if (r.applied === "downgrade") downgraded++;
    else if (r.applied === "upgrade_proposed") upgrade_proposed++;
  }
  return { scanned: candidates.length, same, downgraded, upgrade_proposed, failed };
}
