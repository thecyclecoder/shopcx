/**
 * director-activity — the tiny writer behind the `director_activity` table ([[docs/brain/tables/director_activity.md]]).
 *
 * Every director (and every worker a director supervises) writes ONE timestamped row here on each
 * action it takes — the single log that is the substrate for (1) the autonomous-approval audit
 * history, (2) the gamified #directors board posts, and (3) the EOD recap (a read over today's rows).
 * See [[docs/brain/goals/devops-director.md]].
 *
 * The FIRST concrete writer is the Regression Agent ([[docs/brain/specs/regression-agent.md]]) — it
 * records every detect / dismiss / author / escalate action so the operator (and, once live, the
 * Platform/DevOps Director that supervises it) can audit what the worker did and why.
 *
 * Best-effort + never throws: an audit write that crashes the action it records is worse than the gap
 * (mirrors `enqueueRepairJob`). If the table isn't present yet, this no-ops with a warning.
 */
import type { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

/** The action kinds the Regression Agent emits (open vocabulary — the live directors add more). */
export type DirectorActionKind =
  | "detected_regression" // a regression entered the queue (the detector enqueued a review).
  | "dismissed_regression" // reviewed → transient/foreign/false/already-fixed, recorded reasoning, no spec.
  | "authored_fix" // reviewed → real regression, authored the fix spec directly + routed to the inbox.
  | "escalated" // loop-guard: a regression fix that didn't hold after N attempts → escalated to CEO.
  // regression-backlog-reconciliation Phase 1 — the standing re-verification sweep (close the coverage gap).
  | "reconciled_coverage" // a shipped spec not re-verified within the freshness window → queued a spec-test re-run.
  // regression-backlog-reconciliation Phase 2 — drive every detected regression to a terminal state.
  | "reconciled_regression" // an unresolved spec-test fail with no live regression job → enqueued Remi (or escalated a stuck fix).
  // deploy-health-rollback-guardian Phase 1 — the Deploy Guardian (Reva) stamps one per evaluated deploy-watch.
  | "deploy_healthy" // a deploy's canary window closed clean — no new deploy-correlated regression.
  | "deploy_regressed" // a deploy introduced a clear deploy-correlated regression (a spike / a loop went red).
  | "deploy_unsure" // a deploy's post-deploy signal was ambiguous → escalate, never auto-act.
  // deploy-health-rollback-guardian Phase 2 — Reva acts on `regressed`.
  | "deploy_rolled_back" // a regressed deploy was auto-reverted to the prior good build (+ escalated to the CEO).
  // spec-review-agent Phase 2 — Vale stamps one per in_review spec it processes (LEGACY Phase-2 vocabulary
  // kept for ledger continuity — `spec_review_approved`/`spec_review_deferred` are no longer emitted by
  // the live writer; the Phase 3 narrow-to-quality replaces them with `spec_review_passed`).
  | "spec_review_approved" // (legacy) sound + needed now → spec flipped from in_review to planned.
  | "spec_review_deferred" // (legacy) sound but parked per the spec's own directive → flipped to deferred + flags.deferred set.
  | "spec_review_needs_fix" // checklist failed (mangled phases / missing owner / parent / verification / blockers / db-companion) — diagnosis recorded; spec stays in_review.
  // spec-review-agent Phase 3 — Vale narrowed to QUALITY ONLY; one verdict per in_review spec.
  | "spec_review_passed" // well-formed (CHECKLIST cleared) → flags.vale_pass=true; spec stays in_review for Ada's disposition lane.
  // spec-review-pass-always-stamps-review-passed-flag Phase 2 — the passed-but-unstamped reconciler
  // ([[../libraries/agents-spec-review]] `runValeReviewPassReconciler`) healed a legacy spec that had a
  // `spec_review_passed` activity row from a prior pass but a NULL `specs.vale_review_passed_at` (dropped by
  // the pre-Phase-1 best-effort mirror path). One row per spec healed; metadata:
  // { actor:'reconciler:vale-review-passed-flag', stamped_at, source_activity_id?, autonomous:true }.
  | "healed_review_passed_flag"
  // spec-review-agent Phase 3 — Ada's director-disposition lane (autonomous, with asymmetric check vs the
  // author's `flags.intended_status`). One row per Vale-passed spec she disposes.
  | "spec_dispose_same" // suggestion == decision (planned→planned OR deferred→deferred) — autonomous flip, applied silently.
  | "spec_dispose_downgrade" // author suggested `planned`, Ada deferred — autonomous flip + a CEO notification (one-click override to planned).
  | "spec_dispose_upgrade_proposed" // author suggested `deferred`, Ada wants `planned` — GATED, parks a CEO approval card (Planned / Deferred + reason).
  // spec-review-agent Phase 4 — any agent (Vale on re-check, Bo, Ada, repair/regression, the CEO via the
  // board control) that flips a malformed/off spec BACK to `in_review` so it returns to Vale's queue.
  // The `actor` on the row records WHO sent it back; the `reason` records WHAT was off.
  | "spec_sent_back_to_review" // a malformed/off spec was returned to the in_review column; the build pipeline refuses to dispatch it until Vale clears it again.
  // goal-greenlight-button-and-author-writes-db Phase 1 — the CEO's one-click DB-flag actions on a goal
  // card. `greenlit_goal` activates a proposed goal (proposed → greenlit); `ungreenlit_goal` reverts
  // (greenlit → proposed, only while no milestone has rolled past planned); `declined_goal` flips a
  // proposed goal to folded (the row stays for audit; the mirror-md lane reflects the new status).
  | "greenlit_goal"
  | "ungreenlit_goal"
  | "declined_goal"
  // repurpose-spec-drift-reconciler Phase 1 — the spec-drift reconciler (supervising Bo) stamps phase(s)
  // shipped after the box no-op'd a build as "already merged via #N" (work on main, phase left planned by
  // a backfill). One row per healed spec; metadata carries { actor:'reconciler:spec-drift', pr, phases }.
  | "healed_built_unstamped"
  // folded-spec-must-stay-folded — the SYMMETRIC spec-drift heal: a slug whose markdown is in
  // docs/brain/archive.d/ (shipped + folded) but whose DB row drifted to a non-folded status (a fold-race /
  // re-author cleared the `folded` override → the rollup re-derived `planned` → phantom on the active board
  // + builds auto-cancelled as "spec archived"). The reconciler re-persists `folded`. One row per re-folded
  // spec; metadata carries { actor:'reconciler:spec-drift', signal:'archived-not-folded', previous }.
  | "reconciled_archived_not_folded"
  // repurpose-spec-drift-reconciler Phase 2 — the reconciler's read-only sweep over `spec_phases` for
  // genuine anomalies it can't auto-heal: orphan rows (FK parent missing), duplicate (spec_id, position)
  // clusters (unique index missing/dropped), or shipped phases with no pr + no merge_sha (provenance
  // gap). One row per spec/kind; metadata carries { kind:'orphan'|'duplicate_position'|'provenance_gap',
  // actor:'reconciler:spec-drift', … }.
  | "spec_phases_anomaly"
  // re-author-re-opens-dismissed — `clearDirectorSpecDismissals` writes one row when a RE-AUTHORED spec's
  // standing init/groom `*_dismissed` ledger rows are cleared (the corrected content must be re-investigated,
  // not carried under the stale verdict). metadata: { cleared_dismissals, cleared_keys, autonomous:true }.
  | "spec_reopened_after_reauthor"
  // no-silent-spec-defer invariant — EVERY programmatic (non-human) flip of a spec to `deferred` writes one
  // of these via `auditedProgrammaticDefer` ([[spec-defer-audit]]). The row records WHO parked it (`actor`)
  // and a CONCRETE reason (for a loop-repair defer: which loop/signature + WHY — resolved/superseded/
  // pending-deploy), and the same helper emits a CEO "Spec deferred — <why>" notification with one-click
  // un-defer. No silent parks: a programmatic defer with no audit row + no surface is the gap this closes.
  | "spec_deferred_programmatic"
  // growth-adopt-meta-iteration-engine Phase 1 — the Growth Director (or a human via this same surface)
  // authored + activated a new `iteration_policies` version, ending Meta's dormant mode for the workspace
  // (or re-tuning an already-live one). One row per successful activation, emitted by the worker after
  // `activateIterationPolicy` returns. metadata: { policy_id, version, rationale, superseded_policy_id }.
  | "activated_iteration_policy"
  // growth-adopt-meta-iteration-engine Phase 3 — the spend-rail guard REFUSED to activate a policy whose
  // expected daily budget motion would breach the active `ad_spend_budgets` ceiling. Written by
  // `authorIterationPolicyWithSpendGuard` BEFORE activation runs; the Director then routes the diagnosis
  // to the CEO via `escalateDiagnosisToCeo` (escalationKind='ad_spend_ceiling'). One row per refusal;
  // metadata: { policy_id?, draft_step_pct, projected_delta_cents, ceiling_cents, meta_ad_account_id }.
  | "refused_iteration_policy"
  // human-only-promote advisory (spec-test-human-only-promote-gate sub-task 1b; CEO: "ideally Ada looks at
  // it"). A ZERO-machine-coverage spec (its `## Verification` is entirely `needs_human` checks, auto_pass=0)
  // just promoted to main on 0 auto-fails alone — human checks are FULLY ADVISORY so this NEVER gated the
  // promotion, but Ada (the Platform/DevOps Director) should eyeball the human checks. A LIGHTWEIGHT,
  // NON-BLOCKING surfacing row — it builds no approval card and blocks nothing. One per spec (idempotent).
  // metadata: { autonomous:true, advisory:true, zero_machine_coverage:true }.
  | "human_only_promote_advisory"
  // ada-standing-pass-reasoning-gate Phase 1 — Ada's spec-drift supervision lane
  // (`scripts/builder-worker.ts` `runSpecDriftSupervision`) stamps one row per terminal verdict on a
  // `spec_drift` row (whether reached by the deterministic pre-filter or a Max session), so the ledger
  // dedup (`alreadyDriftSupervised`, keyed on `metadata.drift_row_id`) can skip it next pass instead of
  // re-spawning a Max session forever on an unresolved open row. metadata:
  // { actor:'drift-supervise:pre-filter'|'drift-supervise:session', drift_row_id, verdict, source,
  //   symbols_found?, paths_missing? }.
  | "drift_supervised"
  // completed-goal-self-archive — the standing reconciler (`reconcileCompletedGoalsToFolded`) folds a
  // COMPLETE non-parent goal into the Archive on its own. A goal whose rollup reached 100% but that shipped
  // one-off (no goal branch → the atomic goal→main path never retired it) used to linger forever as
  // greenlit/complete on the active board awaiting a manual backfill (the 8 goals Dylan hand-folded). The
  // reconciler runs the sanctioned retire path (finalizePromotedGoal → complete + goal-fold enqueue). PARENT
  // goals are NEVER folded (is_parent OR has child goals — incl. folded children — OR no buildable specs).
  // One row per goal folded; metadata: { actor:'reconciler:completed-goal-self-archive', linked_spec_count,
  // milestones, completed, fold_queued }.
  | "reconciled_completed_goal_folded"
  // ceo-authorized-out-of-leash-actions Phase 1 — a founder-prompted origination: the CEO asked Ada in the
  // director-coach (Ask-Ada) chat to do something outside her leash; she INVESTIGATED read-only + INDEPENDENTLY
  // AGREED it's sound + the right call, and RAISED a CEO-routed Approval Request carrying her reasoning + a
  // concrete executable pending-action. The leash still blocks UNSUPERVISED out-of-leash action; a CEO-in-the-
  // loop action is supervised by definition (north-star: "hitting a rail = escalate to the objective-owner").
  // She never widens her own leash; the CEO approves this ONE action, one-time, logged. metadata:
  // { thread_id, target_job_id, action_type, reversibility, autonomous:false }.
  | "raised_out_of_leash_request"
  // ceo-authorized-out-of-leash-actions Phase 2 — the CEO-approved out-of-leash action was EXECUTED through
  // the standard executor (`runCeoAuthorizedOutOfLeashJob` in `scripts/builder-worker.ts`). One row per action
  // executed, whether the shell succeeded or failed. The leash was NOT widened — this is a scoped, one-time
  // authorization tied to THIS action instance (`authorized_by='ceo'` on the pending action + this row); the
  // next out-of-leash ask needs its OWN CEO approval. `function_autonomy` is UNCHANGED after execution.
  // metadata: { thread_id, target_job_id, action_type, action_id, cmd, reversibility, irreversible,
  // authorized_by:'ceo', outcome:'ok'|'failed', result_tail, autonomous:false }.
  | "executed_ceo_authorized_out_of_leash"
  // ceo-authorized-out-of-leash-actions Phase 2 — the CEO DECLINED the out-of-leash request; no execution
  // happened. One row per declined action so the audit history is symmetric with the approve path. metadata:
  // { thread_id, target_job_id, action_type, action_id, cmd, reversibility, irreversible,
  // authorized_by:'ceo', autonomous:false }.
  | "ceo_declined_out_of_leash_request"
  // playbook-compiler-loop § Phase 2 — existing-playbook audit surface. Written by
  // POST /api/workspaces/[id]/playbooks/retire when the Retire button on
  // /dashboard/settings/playbooks/audit flips `playbooks.is_active=false`.
  // Owned by the CS director (director_function='cs'), metadata: { playbook_id,
  // playbook_name, retired_by, source }.
  | "playbook_retired"
  // playbook-compiler-becomes-box-agent-mining-full-history Phase 1 — the CS
  // director's compiler-agent (supervised box session, kind='playbook-compile')
  // extracted recurring problem-to-resolution trees from the FULL history
  // (tickets + ticket_analyses) and persisted them to `compiled_trees`. One row
  // per box-agent run, written by applyBoxPlaybookCompile
  // ([[../libraries/playbook-compiler]]) under director_function='cs'. metadata:
  // { job_id, trees_upserted, trees_proposed, skipped_reasons,
  // proposed_playbooks_upserted, proposed_steps_inserted, autonomous:true,
  // phase:2 } — Phase 2 folds the seed proposal counts + carries phase=2.
  | "compiled_trees_extracted"
  // playbook-compiler-becomes-box-agent-mining-full-history Phase 2 — a human
  // approver flipped one COMPILER-SEEDED playbook from proposed (is_active=false,
  // proposed_by='playbook_compiler') to active. Written by
  // `approvePlaybookProposal` ([[../libraries/playbook-compiler]]) under
  // director_function='cs', spec_slug=null. metadata: { playbook_id,
  // source_tree_key, approver_user_id?, autonomous:false, phase:2 }.
  | "playbook_seed_approved"
  // media-buyer-test-winner-loop Phase 2 — the Media Buyer's Test→Measure→Promote→Kill
  // cadence lane in scripts/builder-worker.ts. Owned by Growth (director_function='growth').
  // Each row cites the source meta_ad_id + realized ROAS + policy version so the audit
  // trail names the concrete creative, not the wrapper object.
  //   • media_buyer_promoted_winner — scale_up on a winner's parent adset (persisted via iteration_actions).
  //   • media_buyer_paused_loser — pause a scorecard adset below the policy's roas_floor.
  //   • media_buyer_replenished_test_cohort — published a ready-to-test campaign into the
  //     test ad set via origin='media-buyer-test' (Phase 1 gate).
  //   • media_buyer_replenish_missing_config — cohort is missing default_meta_account_id /
  //     default_meta_page_id — replenish deferred until the operator completes the row.
  //   • media_buyer_no_active_policy — the pass ran with no active iteration_policies row;
  //     the loop is dormant until one is authored + activated (never silent).
  //   • media_buyer_pass_completed — pass heartbeat, one row per cadence pass, always emitted.
  | "media_buyer_promoted_winner"
  | "media_buyer_paused_loser"
  | "media_buyer_replenished_test_cohort"
  | "media_buyer_replenish_missing_config"
  | "media_buyer_no_active_policy"
  | "media_buyer_pass_completed"
  // media-buyer-test-winner-loop Phase 3 — the Media Buyer's fatigue-triggered variant
  // spawn. When a WINNING ad's parent adset crosses the fatigue threshold
  // (`iteration_scorecards_daily.fatigue_score >= 0.5` — same signal decision-engine
  // reads), the runner calls `amplifyWinner` to spawn N fresh variants of the winning
  // angle at `status='ready'`; the standard replenish path then publishes them live
  // into the test cohort. Metadata carries source_meta_ad_id + roas + fatigue_score
  // + new_ad_campaign_ids so the audit trail cites the concrete winner in decline.
  | "media_buyer_fatigue_replenish_triggered"
  // ticket-analyzer-becomes-box-agent-under-june Phase 2 — the CS Director (💬 June) supervision
  // ledger for the per-ticket QC grader. One row per box-session verdict (applyAnalyzerVerdict
  // completed on the box lane, kind='ticket-analyze'), so June's activity feed / EOD recap /
  // rollup surfaces every analyze decision + its reasoning. Owned by CS (director_function='cs').
  // metadata: { job_id, ticket_id, analysis_id, score, issues_types, ai_message_count,
  // trigger, autonomous:true }.
  | "ticket_analyzed";

export interface DirectorActivityInput {
  workspaceId: string;
  /** the function slug whose objective owns the action; a WORKER action carries its SUPERVISING director. */
  directorFunction: string;
  actionKind: DirectorActionKind | string;
  /** the spec the action touched (null for a non-spec action). */
  specSlug?: string | null;
  /** the plain-text "why" — the reasoning the recap/audit reads back. */
  reason: string;
  /** structured per-action context: { job_id?, signature?, failing?, attempt?, verdict?, ... }. */
  metadata?: Record<string, unknown>;
}

/** The function slug whose init/groom lanes own the dismissal ledger (mirrors `PLATFORM` in platform-director). */
const PLATFORM_FUNCTION = "platform";

/**
 * re-author-re-opens-dismissed invariant — clear a spec's STANDING init/groom dismissal ledger rows so a
 * corrected-after-rejection spec re-enters the build pipeline instead of sitting dead under the stale verdict.
 *
 * Ada's `dismiss_candidate` (and the groom-lane equivalent) is PERSISTED as a `director_activity` row whose
 * `metadata.init_key` / `metadata.groom_key` the dedup readers (`alreadyInitiated` / `alreadyGroomed` in
 * [[platform-director]]) scan for to SKIP the spec on the next pass — the row IS the dedup, there is no
 * separate skip-flag. So once a spec is dismissed it is silently excluded forever. When the spec is
 * RE-AUTHORED with changed content the prior dismissal applied to the OLD (premise-wrong) content and is
 * stale; this DELETES those consumed dedup rows for the slug so the init/groom lanes re-investigate the new
 * content, and writes ONE `spec_reopened_after_reauthor` audit row recording the re-open + the keys cleared.
 *
 * Scope: only the `*_dismissed` dedup rows (`init_dismissed` / `groomed_dismissed`). We deliberately do NOT
 * touch `escalated` / `*_authored_spec` rows — those are not "this spec was rejected" dispositions and their
 * audit value outweighs the dedup cost. `director_activity` is NOT a PM table (specs/spec_phases/goals/
 * goal_milestones), so this delete is OUTSIDE the PM-SDK guard — it's ledger hygiene, not a spec mutation.
 *
 * Best-effort + never throws (mirrors `recordDirectorActivity`). Returns the count of dismissal rows cleared.
 */
export async function clearDirectorSpecDismissals(
  admin: Admin,
  workspaceId: string,
  slug: string,
  reason: string,
): Promise<{ cleared: number }> {
  try {
    const { data, error: readErr } = await admin
      .from("director_activity")
      .select("id, action_kind, metadata")
      .eq("workspace_id", workspaceId)
      .eq("spec_slug", slug)
      .in("action_kind", ["init_dismissed", "groomed_dismissed"]);
    if (readErr) {
      console.warn(`[director-activity] clearDirectorSpecDismissals read failed (${slug}):`, readErr.message);
      return { cleared: 0 };
    }
    const rows = (data ?? []) as { id: string; action_kind: string; metadata: Record<string, unknown> | null }[];
    if (!rows.length) return { cleared: 0 };

    const ids = rows.map((r) => r.id);
    const clearedKeys = rows
      .map((r) => (r.metadata?.["init_key"] ?? r.metadata?.["groom_key"]) as string | undefined)
      .filter((k): k is string => !!k);

    const { error: delErr } = await admin.from("director_activity").delete().in("id", ids);
    if (delErr) {
      console.warn(`[director-activity] clearDirectorSpecDismissals delete failed (${slug}):`, delErr.message);
      return { cleared: 0 };
    }

    // One audit row records the re-open + which dedup keys it superseded (the deleted rows are gone, this row
    // is now the trail). It carries NO init_key/groom_key of its own, so it never re-triggers a dedup skip.
    await recordDirectorActivity(admin, {
      workspaceId,
      directorFunction: PLATFORM_FUNCTION,
      actionKind: "spec_reopened_after_reauthor",
      specSlug: slug,
      reason,
      metadata: { cleared_dismissals: rows.length, cleared_keys: clearedKeys, autonomous: true },
    });
    return { cleared: rows.length };
  } catch (err) {
    console.warn("[director-activity] clearDirectorSpecDismissals threw:", err instanceof Error ? err.message : err);
    return { cleared: 0 };
  }
}

/**
 * Insert one `director_activity` row. Best-effort + idempotent-safe to call from any action path.
 * Returns `{ recorded }` so a caller can log it, but NEVER throws.
 */
export async function recordDirectorActivity(admin: Admin, input: DirectorActivityInput): Promise<{ recorded: boolean; reason?: string }> {
  try {
    const { error } = await admin.from("director_activity").insert({
      workspace_id: input.workspaceId,
      director_function: input.directorFunction,
      action_kind: input.actionKind,
      spec_slug: input.specSlug ?? null,
      reason: (input.reason || "").slice(0, 4000),
      metadata: input.metadata ?? {},
    });
    if (error) {
      console.warn(`[director-activity] insert failed (${input.actionKind}):`, error.message);
      return { recorded: false, reason: error.message };
    }
    return { recorded: true };
  } catch (err) {
    console.warn("[director-activity] recordDirectorActivity threw:", err instanceof Error ? err.message : err);
    return { recorded: false, reason: "threw" };
  }
}

/**
 * spec-test-human-only-promote-gate sub-task 1b — surface a LIGHTWEIGHT, NON-BLOCKING advisory to the
 * Platform/DevOps Director (Ada) when a ZERO-machine-coverage spec promotes (CEO: "ideally Ada looks at it").
 *
 * A human-only spec — its `## Verification` is entirely `needs_human` checks, so the spec-test run has
 * auto_pass=0 — now promotes on 0 auto-`fail`s alone (human checks are FULLY ADVISORY; the promote gate no
 * longer requires `auto_pass >= 1`, see [[spec-test-runs]] `isCleanMachinePassRun`). That is correct + by
 * design, but the CEO wants Ada to EYEBALL the human checks when it happens. This records ONE
 * `human_only_promote_advisory` `director_activity` row so it shows up in Ada's activity feed / EOD recap.
 *
 * It is FULLY ADVISORY: it NEVER gates the promotion, builds NO approval card, and blocks nothing — it is a
 * surfacing row only, reusing the EXISTING director-activity feed (no new lane). Call it AT the promote point
 * (after the merge lands), guarded on `summary.auto_pass === 0`.
 *
 * Idempotent: at most ONE advisory per (workspace, spec) — a pre-existing row short-circuits the insert, so a
 * re-run of the promote path doesn't fan out duplicates. Best-effort + never throws (mirrors
 * recordDirectorActivity); an advisory write that crashed the merge it follows would be strictly worse.
 */
export async function recordHumanOnlyPromoteAdvisory(
  admin: Admin,
  workspaceId: string,
  slug: string,
): Promise<{ recorded: boolean }> {
  if (!workspaceId || !slug) return { recorded: false };
  try {
    const { data: existing } = await admin
      .from("director_activity")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("spec_slug", slug)
      .eq("action_kind", "human_only_promote_advisory")
      .limit(1);
    if (Array.isArray(existing) && existing.length > 0) return { recorded: false }; // already surfaced — idempotent
    const r = await recordDirectorActivity(admin, {
      workspaceId,
      directorFunction: PLATFORM_FUNCTION,
      actionKind: "human_only_promote_advisory",
      specSlug: slug,
      reason:
        `${slug} shipped with no machine coverage — eyeball the human checks. Its \`## Verification\` is ` +
        `entirely human-only (auto_pass=0); it promoted on 0 auto-fails alone (human checks are advisory, ` +
        `non-blocking).`,
      metadata: { autonomous: true, advisory: true, zero_machine_coverage: true },
    });
    return { recorded: r.recorded };
  } catch (err) {
    console.warn("[director-activity] recordHumanOnlyPromoteAdvisory threw:", err instanceof Error ? err.message : err);
    return { recorded: false };
  }
}
