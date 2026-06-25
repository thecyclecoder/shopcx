/**
 * spec-audit — the per-spec drift-cleanup audit.
 *
 * Implements [[../../docs/brain/specs/director-trust-phase-pr-provenance]] Phase 2. Triggered by a
 * director's `request-audit` action (auto-applies → queues an `audit-spec-shipped-state` agent_jobs row
 * scoped to one slug → the worker runs `auditSpecShippedState`). The audit walks `spec_status_history` +
 * the squash-merge subjects on origin/main, emits a verdict per phase, and re-stamps `phase_states` via
 * `markSpecCardStatus` with PROPER `{pr, merge_sha}` provenance — the same `phase_states[i].pr` truth a
 * real merge would have written. A phase whose `shipped` flip has no `merge:*` actor on record
 * (director hand-flip / pre-provenance reconciler) is REGRESSED to `planned` so the board reflects
 * "we cannot prove this phase shipped" rather than "✅ ungrounded".
 *
 * Deterministic — no LLM. The merge hook is the only authoritative writer of `pr`/`merge_sha`, so the
 * audit's only sources of truth are (1) `spec_status_history` rows actor=`merge:<sha>`, and (2) the
 * squash-merge subject in git log on origin/main (where the PR # is `(#NNN)`).
 */
import { createAdminClient } from "@/lib/supabase/admin";
import {
  getSpecCardStates,
  markSpecCardStatus,
  rollupPhaseStatus,
  type SpecCardPhaseState,
} from "@/lib/spec-card-state";
import { getSpec } from "@/lib/brain-roadmap";
import type { Phase } from "@/lib/brain-roadmap";

export interface AuditPhaseVerdict {
  index: number;
  title: string;
  prior_status: Phase;
  prior_pr: number | null;
  new_status: Phase;
  new_pr: number | null;
  new_merge_sha: string | null;
  changed: boolean;
  evidence: string;
}

export interface AuditVerdict {
  slug: string;
  workspace_id: string;
  rollup_status: Phase;
  prior_rollup: Phase | null;
  phases: AuditPhaseVerdict[];
  notes: string;
}

/** Map of merge-commit SHA → PR number, derived from the squash-merge subjects on origin/main. */
export type ShaToPr = Map<string, number>;

/**
 * Run the per-slug audit + write the restamped phase_states back to spec_card_state. Returns the
 * verdict so the caller (worker / director_activity writer) can surface it to the activity feed.
 *
 * `lookupPrForSha` is injected so the worker can supply a git-log-backed lookup (the deployed runtime
 * has no checkout to grep). When omitted, the audit still runs but every phase's PR # is left null;
 * the rollup status / merge_sha re-stamp still lands, and the next audit (with the lookup) fills the PR.
 */
export async function auditSpecShippedState(
  workspaceId: string,
  slug: string,
  opts: { lookupPrForSha?: (sha: string) => number | null } = {},
): Promise<AuditVerdict> {
  const admin = createAdminClient();
  const states = await getSpecCardStates(workspaceId);
  const prior = states[slug];

  // Resolve the phase titles from the live spec markdown so we can name phases without provenance.
  const spec = await getSpec(slug).catch(() => null);
  const mdPhases = spec?.card.phases ?? [];

  // Read every status-history row for this spec, most recent first. We walk it once per phase to find
  // the most recent merge:<sha> flip to `shipped` — that's the audit's evidence.
  const { data: history } = await admin
    .from("spec_status_history")
    .select("field, phase_index, from_value, to_value, actor, reason, at")
    .eq("workspace_id", workspaceId)
    .eq("spec_slug", slug)
    .order("at", { ascending: false });
  const rows = (history ?? []) as Array<{
    field: string;
    phase_index: number | null;
    from_value: string | null;
    to_value: string;
    actor: string;
    reason: string | null;
    at: string;
  }>;

  // Phase index → most-recent merge:<sha> row that flipped it to shipped.
  const mergeByPhase = new Map<number, { sha: string; at: string }>();
  for (const r of rows) {
    if (r.field !== "phase") continue;
    if (r.phase_index === null) continue;
    if (mergeByPhase.has(r.phase_index)) continue; // newest wins (ordered desc)
    if (r.to_value !== '"shipped"') continue;
    if (!r.actor?.startsWith("merge:")) continue;
    const sha = r.actor.slice("merge:".length).trim();
    if (!sha) continue;
    mergeByPhase.set(r.phase_index, { sha, at: r.at });
  }

  // Derive the phase set: take the markdown's phase count + titles as the canonical roster, fall back
  // to whatever the DB last stored (a markdown move/delete shouldn't lose audit coverage of stale phases).
  const phaseCount = Math.max(mdPhases.length, (prior?.phase_states?.length ?? 0));
  const phases: AuditPhaseVerdict[] = [];
  const restampedStates: SpecCardPhaseState[] = [];

  for (let i = 0; i < phaseCount; i++) {
    const priorPhase = prior?.phase_states?.find((p) => p.index === i);
    const title = mdPhases[i]?.title ?? priorPhase?.title ?? `Phase ${i + 1}`;
    const priorStatus = (priorPhase?.status ?? "planned") as Phase;
    const priorPr = priorPhase?.pr ?? null;
    const evidence = mergeByPhase.get(i);

    let newStatus: Phase = priorStatus;
    let newPr: number | null = priorPr;
    let newSha: string | null = priorPhase?.merge_sha ?? null;
    let evidenceLine = "";

    if (evidence) {
      // Confirmed: the most recent shipped-flip for this phase carried a real merge SHA. Re-stamp the
      // provenance from that record (overwriting any stale director-only flip). The PR # is best-effort.
      newStatus = "shipped";
      newSha = evidence.sha;
      newPr = priorPr ?? (opts.lookupPrForSha?.(evidence.sha) ?? null);
      evidenceLine = `merge:${evidence.sha.slice(0, 7)} flipped P${i + 1} → shipped at ${evidence.at}`;
    } else if (priorStatus === "shipped" && priorPr === null) {
      // Drift suspect: prior says shipped but we have NO merge:<sha> row on record — a director hand-flip
      // or an old pre-provenance reconciler pass. Regress to `planned`: the audit cannot prove this phase
      // shipped, and "✅ ungrounded" is the exact bug the request-audit lane exists to remove.
      newStatus = "planned";
      newPr = null;
      newSha = null;
      evidenceLine = `no merge:<sha> evidence for prior ✅ — regressed to planned (audit cannot confirm)`;
    } else if (priorStatus === "shipped" && priorPr !== null) {
      // Already has real provenance — leave it, just carry forward.
      evidenceLine = `prior #${priorPr} retained (provenance already on record)`;
    } else {
      evidenceLine = `no shipped-flip on record — kept ${priorStatus}`;
    }

    phases.push({
      index: i,
      title,
      prior_status: priorStatus,
      prior_pr: priorPr,
      new_status: newStatus,
      new_pr: newPr,
      new_merge_sha: newSha,
      changed: newStatus !== priorStatus || newPr !== priorPr || newSha !== (priorPhase?.merge_sha ?? null),
      evidence: evidenceLine,
    });
    restampedStates.push({
      index: i,
      title,
      status: newStatus,
      pr: newPr,
      merge_sha: newSha,
    });
  }

  const rollup = restampedStates.length ? rollupPhaseStatus(restampedStates) : (prior?.status as Phase | undefined) ?? "planned";
  const priorRollup = (prior?.status as Phase | undefined) ?? null;

  const changedPhaseCount = phases.filter((p) => p.changed).length;
  const stampedProvenance = phases.filter((p) => p.new_pr !== null && p.new_pr !== p.prior_pr).length;
  const regressed = phases.filter((p) => p.prior_status === "shipped" && p.new_status === "planned").length;
  const notes =
    `${changedPhaseCount}/${phases.length} phase(s) changed · ${stampedProvenance} provenance stamp(s) · ` +
    `${regressed} regressed (no merge evidence)`;

  if (restampedStates.length) {
    await markSpecCardStatus(workspaceId, slug, rollup, restampedStates, {
      actor: "audit:request-audit",
      reason: `request-audit: ${notes}`,
    });
  }

  return {
    slug,
    workspace_id: workspaceId,
    rollup_status: rollup,
    prior_rollup: priorRollup,
    phases,
    notes,
  };
}
