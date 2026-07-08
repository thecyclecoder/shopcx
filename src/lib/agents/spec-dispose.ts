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
 * The disposition function (`adaDispositionFor`) is the policy seam. Phase 3 shipped a TRUST-THE-AUTHOR
 * stub — Ada always agreed with `intended_status`. [[../specs/vale-reasons-the-disposition]] Phase 2
 * RETIRES that stub: Vale's PASS now emits a reasoned planned/deferred recommendation (`specs.vale_disposition`
 * + `specs.vale_disposition_reason`), and `adaDispositionFor` COMPARES Vale's rec vs the author's
 * intended to route through the asymmetric branches above — carrying VALE'S plain-text reason to the CEO
 * on a non-`same` row. Ada still OWNS the outcome via the CEO gate (an UPGRADE remains gated); Vale only
 * PROPOSES. A candidate with NO stored Vale rec (pre-migration legacy) falls back to `intended` so
 * nothing regresses mid-migration.
 *
 * The disposition writer is the ONLY component that flips a Vale-passed `in_review` spec; the sweep is
 * idempotent (a card already carrying `flags.ada_disposition` is skipped) so a cron re-fire never
 * double-applies.
 */
import type { createAdminClient } from "@/lib/supabase/admin";
import {
  applyAdaDisposition,
  markSpecCardPendingUpgrade,
} from "@/lib/spec-card-state";
import { recordDirectorActivity } from "@/lib/director-activity";
import { APPROVAL_REQUEST_TYPE } from "@/lib/agents/inbox";
import { emitDeferNotification } from "@/lib/agents/spec-defer-audit";
import { listSpecs } from "@/lib/specs-table";

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
 * directly off `public.specs` (the CANONICAL source post-db-driven-specs — the legacy `spec_card_state`
 * mirror isn't reliably populated with `in_review` for newly-authored specs, and Vale's pass dual-writes
 * `specs.vale_pass=true` while only ever creating a status-less mirror row). A row whose `ada_disposition`
 * is already set is skipped (idempotent re-fire); a row whose `intended_status` is missing falls back to
 * `planned` (the safe historical default — every in_review row is a NEW spec, where the author's bias is
 * to build).
 */
export interface DispositionCandidate {
  slug: string;
  intended: "planned" | "deferred";
  /**
   * vale-reasons-the-disposition Phase 2 — Vale's reasoned planned/deferred recommendation carried off
   * the SpecRow (stored on `specs.vale_disposition` by the spec-review lane on a PASS). When present,
   * `adaDispositionFor` USES this instead of the trust-the-author default; when absent (a pre-migration
   * legacy pass), the sweep falls back to `intended` — nothing regresses mid-migration.
   */
  vale_disposition: "planned" | "deferred" | null;
  /** Plain-text WHY paired with `vale_disposition`; surfaced verbatim on Ada's DOWNGRADE notification /
   *  UPGRADE Approval Request so the CEO reads the reason Vale wrote. */
  vale_disposition_reason: string | null;
}

export async function selectDispositionCandidates(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _admin: Admin,
  workspaceId: string,
): Promise<DispositionCandidate[]> {
  // specs-status-overrides-only: `status='in_review'` is no longer STORED, so Ada's cohort is selected by
  // the disposition signals directly — `vale_pass === true` (Vale passed, awaiting disposition) is the real
  // gate; it can only be set while the spec was in review and is CONSUMED once she disposes, so it precisely
  // identifies the pending cohort without a status filter. `folded` is skipped defensively. SDK read
  // (pm-db-agent-toolkit); the JS filters (vale_pass / ada_disposition / deferred / intended_status) all live on SpecRow.
  const rows = await listSpecs(workspaceId);
  const out: DispositionCandidate[] = [];
  for (const r of rows) {
    if (r.status === "folded") continue; // archived — never Ada's turn.
    if (!r.vale_pass) continue; // Vale hasn't passed it yet (null/false) — not Ada's turn.
    if (r.ada_disposition) continue; // already disposed (autonomous flip landed) or parked (pending_upgrade) — skip.
    if (r.deferred) continue; // an out-of-band defer already happened — leave it for the operator.
    const intended: "planned" | "deferred" = r.intended_status === "deferred" ? "deferred" : "planned";
    out.push({
      slug: r.slug,
      intended,
      // vale-reasons-the-disposition Phase 2 — carry Vale's stored recommendation (may be null on a
      // pre-migration legacy pass; adaDispositionFor falls back to `intended` in that case).
      vale_disposition: r.vale_disposition,
      vale_disposition_reason: r.vale_disposition_reason,
    });
  }
  return out;
}

/**
 * Ada's per-spec disposition decision — the POLICY seam. [[../specs/vale-reasons-the-disposition]]
 * Phase 2 retires the Phase-3 trust-the-author stub: Vale (who already read the entire spec for quality)
 * emits a REASONED planned/deferred recommendation on her PASS — stored on `specs.vale_disposition` +
 * `specs.vale_disposition_reason`. `selectDispositionCandidates` reads both off the SpecRow onto the
 * candidate; this function now DECIDES using Vale's rec and returns the asymmetric branch:
 *
 *   - Vale rec == author intended  → `same`      (autonomous, silent — as today)
 *   - Vale rec = deferred, author = planned  → `downgrade` (autonomous + CEO notify, carrying VALE's reason)
 *   - Vale rec = planned,  author = deferred → `upgrade`   (CEO Approval Request, carrying VALE's reason)
 *
 * Back-compat fallback: a candidate with NO stored `vale_disposition` (a pre-migration legacy pass, or a
 * Vale pass that didn't emit a rec) FALLS BACK to the author's `intended` — kind='same', reason names the
 * fallback so the audit ledger reflects it. Nothing regresses mid-migration.
 *
 * The director still OWNS the disposition via the ASYMMETRIC CEO gate downstream (an UPGRADE remains
 * gated) — Vale only PROPOSES. This is the same north-star principle as the rest of the pipeline:
 * spending MORE than the author proposed confirms with the CEO; spending LESS is autonomous + a
 * one-click override.
 */
export function adaDispositionFor(candidate: DispositionCandidate): AdaDecision {
  const intended = candidate.intended;
  const valeRec = candidate.vale_disposition;
  // Back-compat: no stored Vale rec → fall back to the author's intended (today's trust-the-author
  // behavior). A pre-migration legacy pass whose vale_pass was set BEFORE the vale_disposition columns
  // existed lands here; the sweep still flips the card silently, matching prior behavior.
  //
  // spec-review-pass-always-stamps-review-passed-flag Phase 1 — durable-stamp invariant survives this
  // fallback by construction: `applyAdaDisposition` (spec-card-state.ts:678) clears `vale_pass` /
  // `intended_status` / `ada_disposition` but NEVER touches `vale_review_passed` (see the flag doc at
  // spec-card-state.ts:79-85). So a legacy pass whose durable stamp was set on the pass path survives
  // disposition into `planned` and the claim-time build gate sees the flag; a legacy pass whose stamp
  // was NEVER set (pre-Phase-1) is the exact case the Phase-2 reconciler will heal.
  if (valeRec !== "planned" && valeRec !== "deferred") {
    return {
      kind: "same",
      decision: intended,
      intended,
      reason: `No Vale disposition on this pass (legacy) — falling back to the author's intent (${intended}).`,
    };
  }
  const valeReason = (candidate.vale_disposition_reason || "").trim();
  // Same → autonomous. Vale + author agree; the CEO sees this on the audit row only (no notification /
  // no Approval Request — the pipeline stays quiet on a match).
  if (valeRec === intended) {
    return {
      kind: "same",
      decision: intended,
      intended,
      reason: valeReason || `Vale agreed with the author's intent (${intended}).`,
    };
  }
  // Vale rec differs from author intent → asymmetric routing. Preserve VALE'S reason so the CEO
  // reads what Vale wrote (the whole point of retiring the stub).
  if (valeRec === "deferred" && intended === "planned") {
    return {
      kind: "downgrade",
      decision: "deferred",
      intended,
      reason: valeReason || "Vale recommended deferring this spec (no reason provided).",
    };
  }
  // valeRec === 'planned' && intended === 'deferred' → UPGRADE (CEO-gated).
  return {
    kind: "upgrade",
    decision: "planned",
    intended,
    reason: valeReason || "Vale recommended building this spec now (no reason provided).",
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
        metadata: {
          intended: candidate.intended,
          decision: decision.decision,
          autonomous: true,
          vale_disposition: candidate.vale_disposition,
          source: candidate.vale_disposition ? "vale-rec" : "author-intent-fallback",
        },
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
        metadata: {
          intended: candidate.intended,
          decision: "deferred",
          notification: notifResult.ok,
          autonomous: true,
          vale_disposition: candidate.vale_disposition,
          source: "vale-rec",
        },
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
      metadata: {
        intended: candidate.intended,
        proposed: "planned",
        autonomous: false,
        gated: true,
        vale_disposition: candidate.vale_disposition,
        source: "vale-rec",
      },
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
 * Delegates to the shared `emitDeferNotification` ([[spec-defer-audit]]) — the SAME CEO-notification
 * surface every programmatic defer reuses (the no-silent-spec-defer invariant) — passing Ada's own
 * `ada-downgrade:{slug}` dedupe key + her director voice so this lane's surface stays distinct.
 */
async function emitDowngradeNotification(
  admin: Admin,
  workspaceId: string,
  slug: string,
  reason: string,
): Promise<{ ok: boolean; reason?: string }> {
  return emitDeferNotification(admin, workspaceId, slug, `director:${PLATFORM}`, reason, {
    dedupeKey: `ada-downgrade:${slug}`,
    escalationKind: "spec_dispose_downgrade",
    bodyPrefix: "🛠️ Ada (Platform/DevOps Director): I moved this to deferred for now — want it built now? Override on the spec card.",
  });
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
