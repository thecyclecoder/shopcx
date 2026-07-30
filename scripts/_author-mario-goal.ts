import { loadEnv } from "./_bootstrap";
loadEnv();
import { upsertGoal } from "../src/lib/goals-table";

const WORKSPACE_ID = "fdc11e10-b89f-4989-8b73-ed6526c4d906"; // Superfoods Company

// Mario = Ada's reactive pipeline-plumbing agent + the spec-timecard substrate he reasons over.
// This authors ONLY the goal + its 5 sequenced milestones. Dylan greenlights the goal and hits
// "plan"; Pia (the goal planner) decomposes each milestone into properly-authored specs. We do NOT
// author specs here.
async function main() {
  const res = await upsertGoal(
    WORKSPACE_ID,
    {
      slug: "mario-pipeline-plumbing",
      title: "Mario — reactive pipeline-plumbing agent + spec timecards",
      owner: "platform", // Ada / Platform-DevOps owns pipeline reliability
      why:
        "Founder time is being burned diagnosing why the build pipeline silently stalls — a phase " +
        "finishes but the next never starts, a queued job never gets claimed, a build parks waiting on " +
        "an approval nobody sees. Today durations aren't tracked ANYWHERE (specs.status isn't even " +
        "stored — it's derived from the phase rollup), so a stall is invisible until a human notices. " +
        "We need the pipeline to time itself and a reactive agent to plumb the blockages autonomously.",
      outcome:
        "No spec silently stalls. Every spec carries a timecard that times each lifecycle step and the " +
        "gap between steps; a deterministic cron detects outliers within each step's SLA and, unless the " +
        "spec is legitimately waiting (uncleared blocker / blocked_on_usage / needs_input / " +
        "needs_approval), triggers Mario — a reactive box agent who investigates read-only, applies a " +
        "non-destructive live fix to get the pipeline moving (up to and including queuing a box restart), " +
        "then auto-authors a critical fix-spec so the same stall can't recur. Mario checks whether his own " +
        "trigger was accurate and self-tunes his thresholds. The timer + step log is visible on the spec " +
        "detail page. Mario answers to Ada (bounded proxy + supervising role agent — the north star).",
      success_metric:
        "Median stall (step-done → next-step-started beyond SLA) detected in < 1 SLA window; > 90% of " +
        "Mario triggers self-graded trigger-accurate; every recurring stall closed by a merged critical " +
        "fix-spec; zero false triggers on legitimately-blocked or waiting specs.",
      body:
        "Reactive-agent pattern copied from Reva (deploy guardian): a cheap Inngest detector cron finds " +
        "the outlier and INSERTs an `agent_jobs` row → the box worker dispatches by `kind` → a headless " +
        "skill returns ONE typed JSON verdict (conservative default on ambiguity) → a single `applyBox…` " +
        "mutator with an atomic claim-guard + a `director_activity` audit row is the ONLY writer. Legit-wait " +
        "vs true-stall is cleanly separable: an uncleared `blocked_by` slug means no job is ever enqueued; " +
        "statuses blocked_on_dependency / blocked_on_usage / needs_input / needs_approval are legit waits; " +
        "only a live claimed/building job with a stale updated_at, OR a queued job never claimed past SLA, " +
        "is a genuine stall. Grounding: scripts/builder-worker.ts (dispatch, claim_agent_job, " +
        "worker_controls drain-for-update at :2928), src/lib/deploy-guardian.ts (Reva template), " +
        "src/lib/specs-table.ts + src/lib/brain-roadmap.ts (getSpecBlockers / card.blockedBy `cleared`), " +
        "src/app/dashboard/roadmap/[slug]/page.tsx (LifecycleTimeline sidebar).",
    },
    [
      {
        position: 1,
        title: "M1 — Spec timecard ledger + SDK",
        why:
          "There is no per-step timing anywhere today; the raw material is scattered across " +
          "spec_status_history (best-effort, under-covers phase transitions), director_activity, " +
          "spec_test_runs and agent_jobs timestamps. Everything downstream (detection, Mario, the UI) " +
          "needs one clean, purpose-built source of truth for spec timing.",
        what:
          "A new append-only `spec_timecard_events` table + a `spec-timecards` SDK that writes events " +
          "through one chokepoint and computes a spec's timecard (per-step durations, inter-step gaps, " +
          "open wait spans, total elapsed), plus a best-effort backfill of existing specs.",
        body:
          "Add `spec_timecard_events` (append-only): id, workspace_id, spec_slug, phase_index (nullable), " +
          "event_kind (created | review_started | review_passed | review_failed | build_started | " +
          "build_done | phase_shipped | spec_test_started | spec_test_verdict | security_started | " +
          "security_verdict | fold_started | folded | wait_entered | wait_exited | job_queued | " +
          "job_claimed), actor, wait_kind (needs_input | needs_approval | blocked_on_dependency | " +
          "blocked_on_usage | null), waiting_on (who), at timestamptz, metadata jsonb; index " +
          "(workspace_id, spec_slug, at). Add a `spec-timecards` SDK: recordTimecardEvent() as the single " +
          "sanctioned writer, and getTimecard(slug) returning ordered steps with duration_ms + gap_ms + " +
          "open wait spans + total elapsed, plus a listStalledCandidates(...) reader the M3 cron consumes. " +
          "Add a best-effort backfill script seeding the ledger for existing specs from spec_status_history " +
          "/ director_activity / spec_test_runs / agent_jobs timestamps. New table + new library ⇒ both get " +
          "a docs/brain/ page in the same PR (CLAUDE.md hard rule).",
      },
      {
        position: 2,
        title: "M2 — Chokepoint instrumentation + wait tracking",
        why:
          "An empty ledger is useless — the pipeline has to actually emit an event at each real transition, " +
          "and the biggest source of founder-visible stalls is a build parking on an approval/input nobody " +
          "is watching, so we must capture WHO we're waiting on and HOW LONG.",
        what:
          "recordTimecardEvent calls wired into every existing pipeline chokepoint, plus first-class " +
          "wait-span tracking that names the party we're blocked on and times the wait end to end.",
        body:
          "Emit exactly one event at each existing chokepoint: Vale pass/fail (runSpecReviewJob), phase " +
          "build start/done (stampPhaseBuilt), phase ship (stampPhaseShipped), spec-test start/verdict " +
          "(runSpecTestJob / spec_test_runs insert), security verdict (note spec-test + security often run " +
          "fused in one session — don't double-count), fold start/done (runFoldJob), and job_queued / " +
          "job_claimed for worker-liveness timing. Wait-span tracking: on an agent_jobs transition into " +
          "needs_input / needs_approval / blocked_on_dependency / blocked_on_usage, emit wait_entered with " +
          "wait_kind + waiting_on (owner / CEO / dependency slug); on queued_resume emit wait_exited. The " +
          "timecard then shows each wait span with the party named and its duration. Reference " +
          "scripts/builder-worker.ts job runners + src/lib/specs-table.ts stamp helpers.",
      },
      {
        position: 3,
        title: "M3 — Outlier detector cron + self-owned thresholds",
        why:
          "Detection must be deterministic and cheap (an Inngest cron, no token burn), it must NOT fire on " +
          "legitimately-waiting specs, and it must also catch the worker-liveness failure mode — a queued " +
          "job that never gets claimed when it should be — not just inter-phase gaps.",
        what:
          "A `mario_thresholds` self-owned tuning table (per event_kind SLA + min-count) and a deterministic " +
          "evaluateStalledSpecs(admin) that flags true stalls and enqueues a `mario` agent_jobs row, wired " +
          "to an Inngest cron.",
        body:
          "Add `mario_thresholds` (per-step expected-gap SLA + min-count, seeded with defaults; Mario owns " +
          "and self-tunes these rows in M4). Add src/lib/mario.ts evaluateStalledSpecs(admin): read " +
          "timecards (listStalledCandidates) + getSpecBlockers + live agent_jobs status; flag a spec where " +
          "step N is done but N+1 hasn't started past the SLA, OR a job sat status='queued' unclaimed past " +
          "the claim SLA (worker-liveness). EXCLUDE legit waits: any uncleared blocked_by, or job status in " +
          "{blocked_on_dependency, blocked_on_usage, needs_input, needs_approval}. Enqueue helper INSERTs " +
          "agent_jobs {kind:'mario', status:'queued', spec_slug, instructions:JSON} with dedupe-SELECT " +
          "idempotency (no double-enqueue for an already-active mario job on that slug). Register a " +
          "marioStallCron in src/lib/inngest/registered-functions.ts. New table + new cron ⇒ brain pages " +
          "in the same PR.",
      },
      {
        position: 4,
        title: "M4 — Mario box agent (live fix + durable fix-spec + self-tuning)",
        why:
          "The judgment layer: a deterministic cron can misfire, so an LLM agent must confirm the stall is " +
          "real, plumb it with a non-destructive live fix, prevent recurrence with a durable spec, and " +
          "learn from its own false triggers — the same reason Reva exists (a dumb auto-reverter caused " +
          "four false reverts; the fix was inserting a causal-review agent).",
        what:
          "The full Mario box agent: kind wiring + runMarioJob runner + a `.claude/skills/mario/SKILL.md` " +
          "persona with a broad-autonomy live-fix vocabulary (including queuing a box restart) + an " +
          "applyBoxMario mutator that executes the fix, auto-authors a critical fix-spec, and self-tunes " +
          "thresholds — plus Mario's org identity under Ada.",
        body:
          "Wire kind 'mario' into scripts/builder-worker.ts (Job['kind'] union, KNOWN_JOB_KINDS, " +
          "RERUNNABLE_KINDS, dispatch line) and runMarioJob (mirror runDeployReviewJob: parse instructions " +
          "→ brief → prompt 'Use the mario skill…' → runBoxSession {kind:'mario', sandbox:'max'} → " +
          "extractJson → normalizeMarioVerdict with a conservative default → same-session repair → " +
          "applyBoxMario → fail-safe). Author .claude/skills/mario/SKILL.md: read-only investigation, the " +
          "broad-autonomy live-fix vocabulary { redrive_dropped_job, unstick_stale_status, " +
          "release_cleared_blocker, requeue_unclaimed_job, queue_box_restart, … } (broad autonomy per " +
          "Dylan — execute any non-destructive fix, escalate ONLY clearly destructive/irreversible actions), " +
          "and a `## Final output` mandating ONE typed JSON verdict { trigger_accurate, live_fix, " +
          "durable_fix_spec, threshold_adjustment, escalate, reasoning }. queue_box_restart = set " +
          "worker_controls.drain_for_update=true for the box (the same drain-for-update flag behind the " +
          "build-box restart button / POST /api/roadmap/box/drain; scripts/builder-worker.ts:2928) so the " +
          "box restarts at idle — for when Mario's OWN change touches box code and only a restart moves the " +
          "pipeline. applyBoxMario (src/lib/mario.ts, the ONLY mutator): atomic claim-guard; execute the " +
          "live fix with a kill-switch + loop-guard (a la Reva) so a misfire can't oscillate; when " +
          "durable_fix_spec is present, auto-author a critical fix-spec via authorSpecRowStructured with " +
          "auto_build so it flows through review/build/test gates autonomously; write a director_activity " +
          "audit row. Self-tuning + trigger-accuracy: when trigger_accurate=false, widen the matching " +
          "mario_thresholds row and log it; record fired→was-it-real so the false-trigger rate is queryable " +
          "and Ada can supervise. Finally, register Mario's identity via the new-agent convention (persona " +
          "+ avatar + org placement as a worker under Ada / platform).",
      },
      {
        position: 5,
        title: "M5 — Spec-detail timecard timeline (timer + step log)",
        why:
          "The founder needs to SEE the timecard where he already looks — the spec detail page — including " +
          "a live timer, each step's duration and the gaps between them, and any open wait span with who " +
          "we're waiting on and for how long.",
        what:
          "A timer + step-by-step timecard timeline component on the roadmap/[slug] sidebar, reading the " +
          "getTimecard SDK.",
        body:
          "Add a timecard timeline to src/app/dashboard/roadmap/[slug]/page.tsx (sidebar, near the existing " +
          "LifecycleTimeline at page.tsx:229 — extend/reuse it per the reusable-components rule, don't fork " +
          "a parallel timeline). Render, from getTimecard(slug): a live elapsed timer, each lifecycle step " +
          "with its duration_ms, the inter-step gap_ms, and any open wait span with the party named " +
          "(waiting_on) and its running duration. Follow the existing Tailwind dark-mode + " +
          "zinc/amber/emerald/rose/sky conventions; server-renderable like LifecycleTimeline. Can build in " +
          "parallel with M3/M4 (depends only on M1/M2).",
      },
    ],
  );
  console.log("goal upserted:", res.goal_id);
  console.log("milestone ids:", JSON.stringify(res.milestone_ids, null, 2));
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
