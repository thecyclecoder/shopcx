/**
 * Author the cold-scaler arming-feeds spec into public.specs via the SDK chokepoint.
 *
 * CEO 2026-08-25 (option A). The graduate is now reachable (#2587) but the arming gate denies
 * because all three of its evidence feeds are empty. Two have producers nobody triggers; the third
 * asks for shadow-mode reviews that cannot exist for an already-armed agent. This spec builds the
 * feeds so the gate decides on real evidence rather than on absence.
 *
 * IDEMPOTENT — upsertSpec is keyed on slug. Pass --apply to write.
 */
import { createAdminClient } from "./_bootstrap";
import { upsertSpec } from "../src/lib/specs-table";

const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const APPLY = process.argv.includes("--apply");
const SLUG = "cold-scaler-arming-decides-on-evidence-not-absence";

const PARENT =
  '[[../functions/growth]] — "Static-ad optimization" mandate: the arming gate is the supervision half of ' +
  "the test→scale loop this mandate measures. A gate that can only ever deny is not supervising the loop, " +
  "it is blocking it, and the CEO seeded the one live scaler by hand because of it.";

async function main() {
  const admin = createAdminClient();

  const row = {
    slug: SLUG,
    title:
      "The cold-scaler arming gate decides on real evidence — wire the two dead sensors, and judge Bianca on graded outcomes instead of shadow reviews she can never produce",
    summary:
      "Build the three evidence feeds the cold-scaler arming gate reads, so it can return a reasoned ALLOW or DENY instead of denying by default for lack of any input.",
    owner: "growth",
    parent: PARENT,
    parent_kind: "mandate" as const,
    parent_ref: "growth#static-ad-optimization",
    blocked_by: [] as string[],
    priority: null,
    deferred: false,
    intended_status: "planned" as const,
    auto_build: true,
    why:
      "A crowned winner cannot reach the cold scaler. The graduate's Gate 3 refuses without a " +
      "media_buyer_cold_scaler_arming_authorization row, and that row is written only after the arming gate " +
      "evaluates three evidence feeds — all of which are empty. Two feeds have working producers that nothing " +
      "ever triggers: runSensorTrustProbe has a box lane and zero jobs enqueued, and runColdScalerCacLtvSensor " +
      "is referenced only inside a comment. The third asks for at least twenty reviewed shadow-mode decisions, " +
      "which an already-armed agent cannot produce — Bianca stopped running in shadow weeks ago. So the gate " +
      "denies for lack of any input rather than on the merits, and the founder ended up seeding the one live " +
      "scaler campaign by hand. This is the same shape as the gate itself having had no caller: a safety " +
      "control that never runs is indistinguishable from a wall, and it fails silently because nothing errors.",
    what:
      "The two dormant sensors get scheduled the same way the working grade cron is scheduled: a daily cron " +
      "fans out one per-workspace event, which enqueues one job the box runs. Each arrives with the full node " +
      "trio the codebase requires — a named owner, a kill switch, and an end-of-run heartbeat — so a dead " +
      "sensor shows up as a stale tile instead of quietly starving the gate again. The shadow-review " +
      "precondition is replaced by one the system already produces: Bianca's live actions are graded against " +
      "realized attribution, and 288 such grades exist today. The gate will then judge her on outcomes that " +
      "actually happened rather than on agreement with hypotheses. Scoped deliberately to her PROMOTE and " +
      "SCALE actions, because that is the judgement the gate authorizes — she grades 97% sound on killing " +
      "losers and 36% on promoting winners, and blending those would let her strongest skill vouch for her " +
      "weakest. On today's data the rebuilt gate returns DENY with named reasons, which is the correct answer " +
      "and the point: a reasoned refusal the founder can read, instead of silence.",
  };

  const phases = [
    {
      position: 1,
      title: "Phase 1 — schedule the sensor-trust probe",
      status: "planned" as const,
      why:
        "runSensorTrustProbe already exists and already has a lane on the box, but no job has ever been " +
        "enqueued for it, so media_buyer_sensor_trust has zero rows and the arming gate's trust precondition " +
        "can never be satisfied. Nothing is broken in the probe itself — it has simply never been asked to run.",
      what:
        "A daily cron fans out one event per workspace, and the event handler enqueues a single job for the " +
        "existing box lane. The cron reports its own heartbeat when it finishes, and the probe answers to a " +
        "kill switch, so if it stops running that becomes visible on the Control Tower instead of silently " +
        "starving the gate.",
      body:
        "Mirror the working `media-buyer-grade` cron: daily cron → `growth/...-sweep` event per workspace → one " +
        "`agent_jobs` row for the existing `sensor-trust-probe` lane. Reuse `mediaBuyerGradeSpecSlug`'s stable " +
        "per-workspace slug pattern (the column is NOT NULL). Register the cron in the control-tower registry " +
        "with owner `growth` and a cadence ≥ 5 min with a liveness window ≥ 1.2× cadence (a daily cron needs a " +
        "30h window). `sensor-trust-probe` is already in the node registry under `growth`.",
      verification:
        "- `npx tsc --noEmit` on the branch → clean.\n" +
        "- A new Inngest function file exports a daily cron that emits one event per workspace with ≥1 active media-buyer cohort.\n" +
        "- The event handler inserts an `agent_jobs` row with `kind='sensor-trust-probe'` and a non-null `spec_slug`.\n" +
        "- The cron calls `emitCronHeartbeat` at the end of its run.\n" +
        "- `src/lib/control-tower/registry.ts` contains a MONITORED_LOOPS row for the new cron with owner `growth`.\n" +
        "- `npm run check:node-registry-drift` → passes.\n" +
        "- `npm run check:monitor-cadence` or the registry's own import-time `assertRegistryInvariants` → no throw (daily cron ⇒ 30h liveness window).\n" +
        "- A unit test pins that the dispatcher enqueues exactly one job per workspace and is idempotent within a day.",
    },
    {
      position: 2,
      title: "Phase 2 — schedule the cold-scaler CAC:LTV sensor",
      status: "planned" as const,
      why:
        "runColdScalerCacLtvSensor is fully written but appears nowhere outside a comment, so " +
        "media_buyer_cold_scaler_cac_ltv_snapshots is empty and the gate has no CAC:LTV ratio to compare " +
        "against its target. Like the trust probe, the code is sound and simply unreachable.",
      what:
        "The same scheduling shape as Phase 1 gives the sensor a weekly run, since its snapshot is keyed by " +
        "ISO week. It also arrives with an owner, a kill switch and a heartbeat, so a silent stall is visible.",
      body:
        "New job kind `cold-scaler-cac-ltv` with a box lane calling `runColdScalerCacLtvSensor`, plus a weekly " +
        "cron + per-workspace event enqueuing it. The snapshot upsert is ISO-week keyed, so a re-run inside the " +
        "week updates in place. Add the job kind to the node registry (`KIND_OWNER_FALLBACK` or the " +
        "builder-worker kind union) with owner `growth`, and a `kill_switches` ancestry. Weekly cron ⇒ 9d " +
        "liveness window per the monitor-cadence invariant.",
      verification:
        "- `npx tsc --noEmit` on the branch → clean.\n" +
        "- A weekly cron emits one event per workspace and the handler inserts an `agent_jobs` row with `kind='cold-scaler-cac-ltv'`.\n" +
        "- `scripts/builder-worker.ts` routes `kind === 'cold-scaler-cac-ltv'` to a lane that calls `runColdScalerCacLtvSensor`.\n" +
        "- `src/lib/media-buyer/cold-scaler-cac-ltv-sensor.ts` `runColdScalerCacLtvSensor` has ≥1 non-comment call site outside its own file and its tests.\n" +
        "- `npm run check:node-registry-drift` → passes (the new kind resolves to owner `growth`).\n" +
        "- The cron calls `emitCronHeartbeat`; the registry row uses a 9d liveness window.\n" +
        "- A unit test pins the ISO-week idempotency: two runs in the same week update one snapshot row rather than inserting two.",
    },
    {
      position: 3,
      title: "Phase 3 — judge Bianca on graded outcomes, not shadow reviews",
      status: "planned" as const,
      why:
        "The gate asks for at least twenty reviewed shadow-mode decisions at 80% agreement. Bianca has been " +
        "armed for weeks and produces no shadow decisions, so that precondition can never be met without " +
        "sending her backwards into shadow mode to manufacture evidence. Meanwhile the system already grades " +
        "her live actions against realized attribution — 288 of them — which is strictly better evidence: it " +
        "measures what actually happened rather than whether a reviewer agreed with a proposal.",
      what:
        "The gate reads the existing grade corpus instead of the empty shadow-review table, and it looks only " +
        "at the promote and scale actions, because that is the judgement it authorizes. Blending in her kill " +
        "decisions would let a 97% skill vouch for a 36% one. On today's data the gate answers DENY with named " +
        "reasons, which is the correct answer — the founder gets a readable refusal rather than silence.",
      body:
        "Replace the `shadowReviews` input of `evaluateColdScalerArmingPure` with a graded-actions input read " +
        "from `media_buyer_action_grades`, scoped to the scaling-judgement kinds (`media_buyer_promoted_winner`, " +
        "plus `media_buyer_replenished_test_cohort` if the grader treats it as a scale decision) over the same " +
        "14d window. Threshold: ≥`MIN_GRADED_SCALE_ACTIONS` (start at 20, matching the old sample floor) with " +
        "≥`MIN_SCALE_PASS_RATE` (0.8) scoring `overall_grade >= 7`. Keep the gate PURE and unit-tested per " +
        "branch. Retire `insufficient_sample`/`low_agreement` in favour of explicit `insufficient_graded_scale_actions` " +
        "and `scale_grade_below_bar` reason codes so a denial names the real deficiency. Leave the trust and " +
        "CAC:LTV branches untouched — Phases 1-2 feed those.",
      verification:
        "- `npx tsc --noEmit` on the branch → clean.\n" +
        "- `evaluateColdScalerArmingPure` no longer takes a `shadowReviews` input and takes a graded-scale-actions input instead.\n" +
        "- `src/lib/media-buyer/cold-scaler-arming-gate.ts` reads `media_buyer_action_grades` and filters to the scaling action kinds.\n" +
        "- The denial vocabulary contains `insufficient_graded_scale_actions` and `scale_grade_below_bar`.\n" +
        "- Unit tests pin each branch: below the sample floor → deny; ≥ floor but pass-rate under the bar → deny; ≥ floor at/above the bar → that branch clears.\n" +
        "- A unit test pins that KILL grades cannot lift the verdict — a fixture of all-excellent `media_buyer_paused_loser` grades with poor promote grades still denies.\n" +
        "- `npx tsx scripts/_arming-dryrun.ts` runs clean and reports a verdict sourced from grades.",
    },
  ];

  console.log(`slug: ${SLUG}`);
  console.log(`owner: ${row.owner} · parent_kind: ${row.parent_kind} · parent_ref: ${row.parent_ref}`);
  console.log(`phases: ${phases.length}`);
  if (!APPLY) { console.log("\nDRY RUN — pass --apply to write."); return; }

  const res = await upsertSpec(WS, row, phases, { admin });
  console.log(`\n✅ spec ${res.spec_id}`);
  console.log(`   phase ids: ${JSON.stringify(res.phase_ids)}`);
}
main().then(() => process.exit(0)).catch((e) => {
  console.error(e instanceof Error ? e.message : JSON.stringify(e));
  process.exit(1);
});
