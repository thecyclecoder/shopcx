/**
 * Follow-up spec (founder-directed 2026-07-16, do NOT touch the in-flight pipeline-resilience specs):
 * the goal build serializer deadlocks because the ENQUEUE admission gate and the CLAIM-time dispatcher
 * disagree on what "in-flight" means, and the box claims many build jobs in one poll tick (parallel),
 * racing two same-priority goal-mates into a mutual block. Fix = (1) any unblocked member always
 * enqueues (queued is NOT in-flight), serialization lives at ONE decision point (claim-time dispatch);
 * (2) the worker claims + decides ONE queue item at a time, then moves to the next (build EXECUTION
 * stays parallel across lanes). Owner=platform, critical.
 */
import { loadEnv } from "./_bootstrap";
loadEnv();
import { upsertSpec } from "../src/lib/specs-table";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const SLUG = "goal-serializer-one-decision-point-and-serial-claim-no-queued-deadlock";

const PARENT =
  '[[../functions/platform]] — "Autonomous build platform" mandate: two goals with milestones entered at night must be fully built by morning — the goal serializer must never deadlock a ready goal. Follow-up to the in-flight [[parallel-build-serialized-merge-and-deadlock-autobreak]] (do not modify it). See [[../libraries/agent-jobs]] and [[../recipes/pm-flow-data-sources]].';

async function main() {
  const res = await upsertSpec(
    WS,
    {
      slug: SLUG,
      title:
        "Goal serializer: one serialization point + serial claim (any unblocked member queues; kill the queued-vs-in-flight deadlock)",
      summary:
        "**Brain refs:** [[../libraries/agent-jobs]] (`decideGoalMemberEnqueueAdmission` · `evaluateGoalMemberBuildDispatch` · `enqueueBuildIfDue` · `autoQueueUnblockedByGoal`) · [[../recipes/pm-flow-data-sources]] · `scripts/builder-worker.ts` (the poll/claim loop, `claim_agent_job` RPC, `MAX_CONCURRENT`)\n\nLIVE DEADLOCK observed 2026-07-16 on goal `dahlia-imitate-then-innovate-copy-engine`: Bo claimed `dahlia-deeper-competitor-selection` then ejected it every ~2s for hours, nothing built. Root cause — the two goal gates disagree on whether a **queued** job counts as \"in-flight\":\n- `decideGoalMemberEnqueueAdmission` counts a `queued` goal-mate as in-flight → REFUSED to enqueue the earliest-ready head.\n- `evaluateGoalMemberBuildDispatch` does NOT count `queued` → HELD the queued later member behind the head.\n\nSo the head had no job (admission refused it because the later member was queued) and the later member was held (dispatcher wanted the head first) → mutual deadlock, zero in-flight, goal frozen. Made worse because the box claims many build jobs in a single poll tick (parallel per-kind `claim_agent_job` RPCs filling all free lanes at once), which races two same-priority goal-mates into exactly this mutual block. This spec makes the queue permissive (any unblocked member is always queued) with serialization at ONE decision point (claim-time dispatch), and serializes the worker's claim-and-decide step so two goal-mates can't be claimed in the same tick. Build EXECUTION stays parallel across the MAX_CONCURRENT lanes — only the claim/decision is serialized.",
      owner: "platform",
      parent: PARENT,
      parent_kind: "mandate",
      parent_ref: "platform#build",
      blocked_by: [],
      priority: "critical",
      deferred: false,
      intended_status: "planned",
      intended_status_set_by: "ceo:dylan",
      auto_build: true,
      milestone_id: null,
      why:
        "A goal with ready members froze for hours with zero in-flight builds because enqueue-admission and claim-dispatch use two different definitions of 'in-flight' (admission counts `queued`; dispatch does not). The founder's design: any UNBLOCKED spec belongs in the queue — the queue gate is too strict — and serialization must be a single decision made when the worker decides whether to actually work on a claimed item. The box amplifies the race by claiming many build jobs per poll tick in parallel; two same-priority goal-mates claimed in the same tick mutually block. There is no throughput benefit to parallel-claiming many queue items — build execution parallelism is the MAX_CONCURRENT lanes, not the claim step. Serial claim-and-decide (one item at a time, a couple seconds max per decision) removes the race while keeping full build concurrency.",
      what:
        "(1) ONE serialization point. Relax `decideGoalMemberEnqueueAdmission` so a `queued` goal-mate does NOT block enqueuing another unblocked member — any unblocked member always reaches `queued`. Serialization moves entirely to `evaluateGoalMemberBuildDispatch` (claim time): among a goal's queued+ready members, exactly one (the earliest-ready) is admitted to build; the rest stay `queued` (not cancelled, not lost) and are re-evaluated each claim. Both gates share ONE `inFlightStatuses` constant (claimed/building/needs_input/needs_approval/queued_resume/blocked_on_usage — `queued` excluded) so they can never diverge again. (2) SERIAL claim-and-decide in `scripts/builder-worker.ts`: the build/plan pool claims ONE queue item, runs the dispatch decision (build it, or release it back to `queued` if a goal-mate is genuinely in-flight), then advances to the next item — never claiming two build jobs in the same poll tick. A small inter-decision delay (≤ a couple seconds) is fine; build EXECUTION remains parallel across MAX_CONCURRENT lanes. (3) Deadlock/starvation invariant + auto-break: a ready goal (≥1 unblocked member, 0 genuinely in-flight) must always get exactly one member dispatched — assert it and add a regression that replays today's dahlia scenario (head with no job + later member queued) and proves the head builds, the later member stays queued, and nothing is cancelled.",
    },
    [
      {
        position: 1,
        title: "Phase 1 — one shared in-flight definition; any unblocked member always enqueues",
        status: "planned",
        body:
          "Make the queue permissive and put serialization at a single decision point. `queued` is not 'in-flight' anywhere. Admission stops refusing an unblocked member just because a goal-mate is queued; the earliest-ready selection happens only at claim-time dispatch.",
        why:
          "The deadlock is exactly the divergence: admission (`decideGoalMemberEnqueueAdmission`, agent-jobs.ts ~1750) treats a `queued` goal-mate as in-flight and refuses to enqueue the head, while dispatch (`evaluateGoalMemberBuildDispatch`, agent-jobs.ts 1669) excludes `queued` and holds the queued member behind the head. One shared constant + a permissive queue makes the two structurally unable to disagree.",
        what:
          "Extract a single `GOAL_INFLIGHT_STATUSES` constant (claimed/building/needs_input/needs_approval/queued_resume/blocked_on_usage — NO `queued`) and use it in BOTH `decideGoalMemberEnqueueAdmission` and `evaluateGoalMemberBuildDispatch`. `decideGoalMemberEnqueueAdmission` no longer blocks on a queued goal-mate — an unblocked member always enqueues; it only defers when a goal-mate is genuinely in-flight AND this member isn't the earliest-ready. Selection of the single buildable member stays in the dispatcher. Brain: agent-jobs.md updates both gates + documents the shared constant and the 'queue is permissive, dispatch serializes' contract.",
        verification:
          "vitest: two unblocked goal-mates BOTH reach `queued` (admission no longer refuses on a queued sibling); given several queued+ready members with zero in-flight, the dispatcher admits exactly the earliest-ready and returns ok=false for the rest; a direct replay of the 2026-07-16 dahlia state (head enqueuable, later member queued) resolves to the head building. `npx tsc --noEmit` clean.",
      },
      {
        position: 2,
        title: "Phase 2 — serial claim-and-decide in the box (no two build jobs claimed per tick)",
        status: "planned",
        body:
          "The worker claims ONE build/plan queue item, decides (build or release back to queued), then moves to the next — instead of firing parallel per-kind claim RPCs that fill all free lanes in one tick and race two goal-mates into a mutual block.",
        why:
          "scripts/builder-worker.ts fills free build lanes by claiming multiple jobs per poll tick (parallel `claim_agent_job` calls up to MAX_CONCURRENT). When two same-priority goal-mates are both queued, they get claimed in the same tick and mutually block. The founder's directive: pull one item at a time, decide, then the next — no throughput is lost because build EXECUTION is still the MAX_CONCURRENT parallel lanes; only the claim/decision is serialized.",
        what:
          "In the build/plan pool claim path, serialize claim-and-decide: claim a single queue item, run `evaluateGoalMemberBuildDispatch`; if admitted, hand it to a free lane (execution parallel as today); if not admitted, release it back to `queued` (clear the claim so the next tick re-evaluates it) and continue to the next item. Never claim a second build job before the first's decision resolves. Keep a small bounded per-decision delay so a full sweep of the queue is a couple seconds, not instant parallelism. Non-goal kinds (ticket-handle, director, etc.) keep their own lanes/behavior — this serialization is scoped to the goal-serialized build/plan pool. Brain: builder-worker note on serial claim + the parallel-execution/serial-claim distinction.",
        verification:
          "vitest / harness test: given two queued goal-mates of the same goal, a single poll pass claims+dispatches exactly one and leaves the other `queued` (never both claimed simultaneously); a released (not-admitted) claim returns to `queued` with a null/near claim so it's re-claimable next pass; build execution across independent goals still runs up to MAX_CONCURRENT in parallel. `npx tsc --noEmit` clean.",
      },
      {
        position: 3,
        title: "Phase 3 — ready-goal-never-frozen invariant + dahlia deadlock regression",
        status: "planned",
        body:
          "Belt-and-suspenders: assert that a ready goal always has exactly one member dispatched, and add an auto-break so a transient wedge self-heals instead of needing a manual unwedge.",
        why:
          "Even with Phases 1-2, a future change could re-introduce a wedge; a standing invariant + regression makes the deadlock class permanently caught. Today's incident needed a hand-run unwedge (cancel the mis-prioritized queued job, re-enqueue the head) — that recovery should be automatic.",
        what:
          "Add an assertion/guard (surfaced via the existing stall/serializer diagnostics, e.g. `whyIsSpecNotBuilding` / Mario's wedge detectors) that flags a goal with ≥1 unblocked member and 0 genuinely-in-flight members as a deadlock and auto-breaks it by dispatching the earliest-ready member (the automated form of today's manual fix). Add a regression test that constructs the exact 2026-07-16 dahlia deadlock (head with no job, later member `queued`) and proves the system self-recovers to the head building with nothing cancelled/lost.",
        verification:
          "vitest: the invariant returns 'deadlock' for a ready goal with zero in-flight and 'ok' otherwise; the auto-break dispatches exactly the earliest-ready member; the dahlia-deadlock regression replays and self-heals (head builds, later member stays queued, no job cancelled). `npx vitest run` green.",
      },
    ],
  );
  console.log("spec authored:", res.spec_id, "phases:", JSON.stringify(res.phase_ids));
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
