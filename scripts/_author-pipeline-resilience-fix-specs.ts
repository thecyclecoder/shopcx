/**
 * Authors the three CRITICAL platform fix-specs from the overnight-stall + Mario investigation:
 *   1. mario-detects-job-and-pr-wedges — give Mario eyes on job/PR wedges (not just spec-lifecycle)
 *   2. pr-resolve-retry-cap-and-fold-closes-orphan-pr — kill the infinite re-enqueue at the source
 *   3. parallel-build-serialized-merge-and-deadlock-autobreak — use the 12 lanes + auto-break deadlocks
 * Owner=platform, mandate platform#build, priority critical. Founder-directed 2026-07-16.
 */
import { loadEnv } from "./_bootstrap"; loadEnv();
import { upsertSpec } from "../src/lib/specs-table";

const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const P = (tail:string)=>`[[../functions/platform]] — "Autonomous build platform" mandate: ${tail} See [[../libraries/mario]], [[../libraries/agent-jobs]], [[../libraries/github-pr-resolve]].`;

async function main(){
  // ── Spec 1 — Mario gets eyes ────────────────────────────────────────────────
  const s1 = await upsertSpec(WS, {
    slug:"mario-detects-job-and-pr-wedges-not-just-spec-lifecycle",
    title:"Mario detects job/PR wedges (storms, unclaimed & never-enqueued builds), not just spec-lifecycle stalls",
    summary:"**Brain refs:** [[../libraries/mario]] (`evaluateStalledSpecs` · `applyBoxMario` · the `!specRow` drop) · [[../libraries/agent-jobs]] · [[../libraries/github-pr-resolve]]\n\nMario's authority is broad but his EYES are narrow: all five detectors key on a spec's lifecycle (timecard SLA, failed build, promote-gate, vale-fail). The overnight wedges — a pr-resolve retry storm, a build queued 7.9h, and an eligible keystone never enqueued — emit none of those signals, so Mario never saw them. Worse, `mario.ts:667` (`if(!specRow) continue`) structurally forbids him from acting on any job/PR wedge that lacks a specs row. Add 4 detectors + relax that drop + 2 verbs so Mario actually prevents the wedges that actually happen.",
    owner:"platform", parent:P('Mario is the pipeline-plumber whose whole job is to keep the pipeline un-wedged; last night it wedged for ~8h and he never saw it because his eyes are spec-lifecycle-only.'),
    parent_kind:"mandate", parent_ref:"platform#build", blocked_by:[], priority:"critical", deferred:false,
    intended_status:"planned", intended_status_set_by:"ceo:dylan", auto_build:true, milestone_id:null,
    why:"Mario has broad fix-authority (redrive/requeue/reclaim/close-dup-PR/author-fix-spec/box-restart) but all 5 detectors in evaluateStalledSpecs (mario.ts:507) key on a spec's lifecycle. The 3 overnight wedges were a job-kind storm (kind='pr-resolve'), an unclaimed/deadlocked build (status='queued'), and an eligible-but-never-enqueued spec — none emit a lifecycle signal, and the phantom-drop at mario.ts:667 would discard a job/PR candidate anyway. The gap is DETECTION, not authority.",
    what:"Add 4 sources to evaluateStalledSpecs + relax the mario.ts:667 !specRow drop for job/PR candidates + 2 new verbs in applyBoxMario's switch (mario.ts:1700): (a) eligible-never-enqueued → reuse the existing reclaim_and_redrive verb; (b) stuck-queued-build; (c) pr-resolve storm → new cancel_pr_resolve_storm verb; (d) orphaned folded/shipped PR → new close_orphaned_pr verb. Mario's cron (mario-stall-cron.ts, */5) needs no change — new sources flow through automatically.",
  },[
    {position:1, title:"Phase 1 — eligible-never-enqueued detector (auto-start stranded keystones)", status:"planned",
     body:"The highest-value detector: a spec that is planned + auto_build + all blockers cleared but has NO build job is invisible today and can freeze a whole downstream chain (last night: the rubric keystone froze 8 specs).",
     why:"No Mario source scans specs for 'auto_build && unblocked && no build job'. Such a spec emits no timecard/failed-build/vale signal, so it is completely invisible — yet it is the most damaging wedge (it strands every downstream dependent).",
     what:"Add a source in evaluateStalledSpecs (mario.ts) scanning specs for status='planned' && auto_build && all blockers shipped && no active/terminal build job, aged past a grace. Map it to the existing reclaim_and_redrive verb (mario.ts:1254 → queueRoadmapBuild) which already performs the enqueue. Pin with a test that a stranded eligible spec is surfaced and reclaim_and_redrive enqueues it.",
     verification:"vitest: evaluateStalledSpecs surfaces a fixture spec (planned+auto_build+blockers-shipped+no-build-job aged past grace) as a candidate, and applyBoxMario's reclaim_and_redrive enqueues a build for it; a spec WITH an active build job is not surfaced. `npx vitest run` green."},
    {position:2, title:"Phase 2 — stuck-queued-build + pr-resolve-storm detectors (relax the !specRow drop)", status:"planned",
     body:"Two job-centric detectors + the structural change that lets Mario act on jobs that have no specs row (pr-resolve carries a synthetic slug).",
     why:"readFailedBuildStalls (mario.ts:230) only catches kind='build' status='failed' — never a build stuck 'queued' for hours, and never kind='pr-resolve'. And the !specRow drop (mario.ts:667) discards any pr-resolve candidate. So a 7.9h-queued build and a 61-job pr-resolve storm are both invisible.",
     what:"(a) Extend the job scan to surface a build stuck status='queued' past a grace with no claim (reuse requeue_unclaimed_job + add a lane/deadlock escalation when the requeue is a no-op). (b) Add a pr-resolve-storm source: ≥N needs_attention/failed pr-resolve rows for one pr_number in a window → a new cancel_pr_resolve_storm verb (cancels the parked storm jobs). (c) Relax the mario.ts:667 !specRow drop so job/PR candidates survive to applyBoxMario.",
     verification:"vitest: a build queued past grace with no claim is surfaced; a pr_number with ≥N parked pr-resolve rows is surfaced and cancel_pr_resolve_storm cancels them; a job/PR candidate with no specs row is NOT dropped by the phantom-guard. `npx vitest run` green."},
    {position:3, title:"Phase 3 — orphaned folded/shipped-PR auto-close", status:"planned",
     body:"Close the loop on the exact #1893 case: an open claude/* PR whose spec already folded/shipped is a superseded orphan and should be closed, not churned.",
     why:"No detector catches an open PR whose spec is terminal (folded/shipped) on main. #1893 sat open+conflicting for 7h because its spec had folded and nobody closed it — the storm's ultimate cause.",
     what:"Add a source: an open claude/* PR whose spec status IN ('folded','shipped') → a new close_orphaned_pr verb in applyBoxMario reusing closeDuplicatePr from github-pr-resolve.ts. Pin with a test that a folded-spec open PR is surfaced and closed while a live-spec PR is untouched.",
     verification:"vitest: a fixture open PR whose spec is folded is surfaced and close_orphaned_pr closes it; a PR whose spec is planned/in_progress is not surfaced. `npx vitest run` green."},
  ]);
  console.log("spec1:", s1.spec_id);

  // ── Spec 2 — kill the pr-resolve infinite loop at the source ─────────────────
  const s2 = await upsertSpec(WS, {
    slug:"pr-resolve-retry-cap-and-fold-closes-orphan-pr",
    title:"pr-resolve retry cap (park-once) + folding a spec closes its orphan PR",
    summary:"**Brain refs:** [[../libraries/github-pr-resolve]] (`enqueuePrResolveJob` cap logic) · [[../libraries/agent-jobs]] (`cancelJobsForArchivedSpecs`) · [[../libraries/builder-worker]] (dirty-PR backstop)\n\nRoot cause of the #1893 firehose: the advisory-supersede path parks a pr-resolve job to needs_attention, but the retry-cap counter EXCLUDES needs_attention rows (github-pr-resolve.ts:304) and only dedups on active jobs (:281), so the standing-pass dirty-PR backstop re-enqueues a fresh attempt every pass → the cap never trips → infinite loop (61 jobs / 7h). Plus a folded/shipped spec's open PR is never closed. Fix both: cap the retry (park once) and close the PR when the spec folds. Mario (sibling spec) is the backstop; this removes the need for a backstop.",
    owner:"platform", parent:P('A single conflicting PR spawned a 7-hour, 61-job retry storm because the retry cap never counted the parked attempts — the pipeline plumbing must terminate, not firehose.'),
    parent_kind:"mandate", parent_ref:"platform#build", blocked_by:[], priority:"critical", deferred:false,
    intended_status:"planned", intended_status_set_by:"ceo:dylan", auto_build:true, milestone_id:null,
    why:"advisory-supersede parks pr-resolve to needs_attention (builder-worker.ts:18061), but enqueuePrResolveJob's genuine-attempts count excludes needs_attention (github-pr-resolve.ts:304) and dedups only on active jobs (:281). So the dirty-PR standing-pass backstop re-enqueues forever — the cap is structurally unreachable. And findAlreadyMergedDuplicate keys on a merged sibling branch, not a folded spec, so an orphan PR whose spec folded is never closed.",
    what:"(1) Count needs_attention/advisory-supersede attempts toward the pr-resolve retry cap so it PARKS ONCE (or backs off) instead of re-enqueuing every pass. (2) When a spec transitions to folded/shipped, close its still-open claude/* PR + cancel its pr-resolve jobs — extend cancelJobsForArchivedSpecs (which already reaps archived-spec build jobs, incl. the needs_attention broadening from reap-needs-attention-jobs-for-archived-specs) to also close the PR + reap pr-resolve.",
  },[
    {position:1, title:"Phase 1 — retry cap counts parked attempts → park-once, no re-enqueue storm", status:"planned",
     body:"The core loop-breaker. A pr-resolve that hit advisory-supersede and parked must count toward the cap so the dirty-PR backstop stops re-spawning it.",
     why:"github-pr-resolve.ts:304 excludes needs_attention from the genuine-attempts count and :281 dedups only on active jobs, so a parked advisory-supersede attempt is invisible to the cap → the backstop re-enqueues every pass → infinite storm.",
     what:"Include needs_attention (advisory-supersede) attempts in enqueuePrResolveJob's cap count so after N attempts the PR parks ONCE with a single escalation and no further pr-resolve is enqueued until a human/Mario acts. Pin with a test that N parked attempts suppress the N+1th enqueue.",
     verification:"vitest: given N needs_attention pr-resolve rows for one PR, enqueuePrResolveJob refuses the N+1th enqueue (cap reached); below N it still enqueues. `npx vitest run` green."},
    {position:2, title:"Phase 2 — folding/shipping a spec closes its open PR + reaps its pr-resolve jobs", status:"planned",
     body:"Proactively close the orphan so it never enters the storm path — the fold path, not just Mario, owns cleanup.",
     why:"A folded/shipped spec's open PR is superseded but nothing closes it (#1893). cancelJobsForArchivedSpecs reaps build/spec-test jobs but not the PR or pr-resolve jobs, so the orphan lingers and churns.",
     what:"Extend the archived-spec cleanup so that when a spec is folded/shipped, its still-open claude/* PR is closed (reuse closeDuplicatePr) and its pr-resolve jobs are cancelled. Idempotent + safe (only acts on terminal-spec PRs). Pin with a test that a folded spec's open PR + pr-resolve jobs are cleaned.",
     verification:"vitest: on fold of a spec with an open PR + parked pr-resolve jobs, the PR is closed and the pr-resolve jobs cancelled; a live spec's PR is untouched. `npx vitest run` green, `npx tsc --noEmit` clean."},
  ]);
  console.log("spec2:", s2.spec_id);

  // ── Spec 3 — parallel build + serialized merge + deadlock auto-break ──────────
  const s3 = await upsertSpec(WS, {
    slug:"parallel-build-serialized-merge-and-deadlock-autobreak",
    title:"Goal builds parallelize across lanes (serialized rebase-merge) + serializer deadlock auto-break",
    summary:"**Brain refs:** [[../libraries/agent-jobs]] (`decideGoalMemberEnqueueAdmission` · `evaluateGoalMemberBuildDispatch`) · [[../libraries/specs-table]] (`goalBranchState`)\n\nThe goal serializer is BLANKET: any goal-mate in-flight blocks the next (agent-jobs.ts:1756), regardless of whether the two specs actually depend on each other — so a goal uses 1 of the 12 lanes no matter how independent its specs are. And it DEADLOCKS: when the 'earliest-ready' head has no in-flight build, every sibling behind it is claimed→ejected forever (last night: cohort-and-ceiling was 'next' but never enqueued). The merge-conflict hazard the serializer guards against lives at MERGE time, not build time — so decouple them: parallelize builds for dependency-independent specs, serialize+rebase the merges, and auto-break the deadlock.",
    owner:"platform", parent:P('Goal builds single-file one spec at a time, wasting 11 of 12 lanes, and the serializer deadlocks when the head-of-line never starts — both throttle the whole roadmap.'),
    parent_kind:"mandate", parent_ref:"platform#build", blocked_by:[], priority:"critical", deferred:false,
    intended_status:"planned", intended_status_set_by:"ceo:dylan", auto_build:true, milestone_id:null,
    why:"decideGoalMemberEnqueueAdmission (agent-jobs.ts:1756) refuses to enqueue a goal-mate whenever ANY sibling is in-flight — it is not DAG-aware, so dependency-independent specs (a goal often has 4+ with zero mutual blockers) single-file through one lane. And evaluateGoalMemberBuildDispatch (:1669) ejects any member that isn't the 'earliest ready' head — if that head has no in-flight build (never enqueued / next phase not chained), the whole goal deadlocks (observed on bianca-cold-scaler-cohort-and-daily-ceiling). blocked_by captures logical/code deps; the merge-collision hazard (two specs touching one file) lives at merge time, not build time.",
    what:"(1) Deadlock auto-break: when the dispatch 'earliest-ready' head has no active build job past a grace, auto-enqueue it (advance) instead of ejecting siblings forever. (2) DAG-aware parallel admission: admit a goal-mate build if it has no UNSHIPPED blocker relationship to any in-flight sibling, up to the lane cap — replacing the blanket 'any sibling in-flight' refusal. (3) Serialized rebase-merge: merges onto the goal branch stay one-at-a-time and rebase, so parallel builds can't collide (handles the file-overlap hazard blocked_by can't see).",
  },[
    {position:1, title:"Phase 1 — serializer deadlock auto-break (advance the stalled head)", status:"planned",
     body:"Smallest, highest-urgency: stop the goal from deadlocking when the designated head-of-line spec has no in-flight build. This is exactly last night's Bianca stall.",
     why:"evaluateGoalMemberBuildDispatch names an 'earliest ready' head and ejects everyone else; if that head has no queued/building job (never enqueued or its next phase wasn't chained), the goal deadlocks permanently — siblings claim→eject every tick and the head never starts.",
     what:"When dispatch resolves an 'earliest ready' head that has NO active build job past a grace window, auto-enqueue that head (enqueueBuildIfDue / queueNextChainedPhase) instead of only ejecting the claimant. Emit a director_activity audit row. Pin with a test reproducing the head-with-no-job deadlock and asserting the head gets enqueued.",
     verification:"vitest: given a goal whose 'earliest ready' head has no build job and a sibling repeatedly ejected, the auto-break enqueues the head; when the head has an active job, no auto-enqueue fires. `npx vitest run` green."},
    {position:2, title:"Phase 2 — DAG-aware parallel admission (use the 12 lanes)", status:"planned",
     body:"Replace the blanket 'any sibling in-flight blocks' rule with one that only blocks on a real dependency relationship, so independent specs build concurrently.",
     why:"decideGoalMemberEnqueueAdmission (agent-jobs.ts:1756) blocks a goal-mate whenever any sibling is in-flight, ignoring blocked_by. A goal's dependency-independent specs (often 4+) are forced single-file, wasting 11 of 12 lanes.",
     what:"Admit a goal-mate build if it has no UNSHIPPED blocker relationship (transitively) to any currently in-flight sibling, capped at the global lane budget. Keep the claim-time dispatch as a defense-in-depth. Pin with a test: two specs with no mutual blocker both admit; a spec that blocks-on an in-flight sibling is held.",
     verification:"vitest: decideGoalMemberEnqueueAdmission admits two mutually-independent goal-mates concurrently and holds a spec whose blocker is in-flight; the lane cap bounds concurrency. `npx vitest run` green."},
    {position:3, title:"Phase 3 — serialized rebase-merge guard (parallel builds can't collide)", status:"planned",
     body:"The safety mechanism that makes Phase 2 safe: builds run in parallel, but each finished branch rebase-merges onto the goal branch one at a time, so two specs touching the same file can't produce a #1893-style collision.",
     why:"blocked_by captures logical/code deps but not file overlap; two independent-by-DAG specs can still touch the same file and collide at merge. Parallelizing builds without serializing the merge would multiply the #1893 conflict storms.",
     what:"Ensure goal-branch merges are serialized and each branch rebases onto the latest goal branch before merge (abort+re-resolve on true conflict, escalate on irreducible). Confirm/extend the existing goal-branch merge path to guarantee one-at-a-time rebase-merge under parallel builds. Pin with a test that two parallel builds touching one file merge cleanly via serialized rebase.",
     verification:"vitest/integration: two goal-mate branches touching the same file, built in parallel, merge one-at-a-time with a rebase and no duplicate-symbol collision; an irreducible conflict escalates rather than force-merging. `npx vitest run` green."},
  ]);
  console.log("spec3:", s3.spec_id);
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1)});
