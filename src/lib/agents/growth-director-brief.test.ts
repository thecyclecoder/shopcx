/**
 * Unit tests for the Growth Director Phase-2 brief loader + investigation prompt (growth-director-agent spec).
 *
 * Built-in node:test — no test-runner dependency. Run:
 *   npm run test:growth-director-brief
 *   (= tsx --test src/lib/agents/growth-director-brief.test.ts)
 *
 * Mirrors the platform-director's brief-shape coverage: a hand-rolled fake admin client returns fixture
 * function_autonomy('growth'), iteration_policies, storefront_optimizer_policy, and pending
 * iteration_recommendations rows; the brief assertions confirm every loaded surface is present and the
 * prompt assertions confirm the `directorLiveStateFact` wrap + the loaded data render into the prompt.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildGrowthDirectorBrief,
  growthDirectorInvestigationPrompt,
  directorLeashCandidates,
  gradeDirectorDecision,
  type DirectorTargetJob,
} from "./growth-director";

// ── Fake admin client (the minimum chain the brief loaders + directorLiveStateFact call) ─────────
// The real createAdminClient returns a PostgrestQueryBuilder whose chain calls (.select/.eq/.order/
// .limit/.maybeSingle) eventually resolve to `{data, error}`. We model the chain as a chainable object
// per table whose terminal awaits resolve to a fixed result. directorLiveStateFact also reads
// `function_autonomy` via this same shape, so the live-state wrap renders correctly.

interface FakeTableRow {
  data: unknown;
  error: null;
}

// One chainable per .from('<table>') call. We DON'T model multiplexed responses (one shape per table is
// enough for the brief — each loader hits ONE table once).
function makeChain(result: FakeTableRow) {
  const chain: Record<string, unknown> = {};
  // Every chain method returns the same chain object — both .select/.eq/.order/.limit/.in are chainable and
  // .maybeSingle is the terminal that resolves the result. We also make the chain `thenable` so plain
  // `await admin.from(...).select(...)` works (no terminal .maybeSingle), which is what the
  // iteration_policies / iteration_recommendations queries do. .update / .insert are wired through the
  // same chain so a gradeDirectorDecision-style write resolves cleanly to `{data:null,error:null}`.
  chain.select = () => chain;
  chain.eq = () => chain;
  chain.in = () => chain;
  chain.gte = () => chain;
  chain.order = () => chain;
  chain.limit = () => chain;
  chain.update = () => chain;
  chain.insert = () => chain;
  chain.maybeSingle = async () => result;
  chain.then = (onFulfilled: (v: FakeTableRow) => unknown) => Promise.resolve(result).then(onFulfilled);
  return chain;
}

function makeAdmin(tables: Record<string, FakeTableRow>) {
  return {
    from(table: string) {
      const result = tables[table] ?? { data: null, error: null };
      return makeChain(result);
    },
  } as unknown as Parameters<typeof buildGrowthDirectorBrief>[0];
}

const baseJob: DirectorTargetJob = {
  id: "job-1",
  workspace_id: "ws-1",
  kind: "approval_request",
  spec_slug: "growth-spec-1",
  status: "needs_approval",
  pending_actions: [
    {
      id: "a1",
      type: "iteration_policy_activation",
      summary: "Activate iteration_policies v3",
      preview: "ROAS floor 1.4 → 1.5 (scale-up step 0.15)",
      cmd: "select * from iteration_policies where version=3",
    },
  ],
  log_tail: "engine evaluated v3 candidate; rationale: tighten ROAS floor after weekend traffic",
};

test("buildGrowthDirectorBrief loads the growth autonomy row, the iteration_policies versions, the optimizer policy, the pending recommendations, the open optimizer jobs, the recent grades, the per-experiment delivery flags, the latest iteration_runs row, and its iteration_actions outcomes", async () => {
  const admin = makeAdmin({
    function_autonomy: { data: { live: true, autonomous: false }, error: null },
    iteration_policies: {
      data: [
        { id: "p3", version: 3, status: "pending", created_by: "agent", rationale: "tighter ROAS floor", activated_at: null, superseded_at: null, created_at: "2026-06-29T10:00:00Z" },
        { id: "p2", version: 2, status: "active", created_by: "human", rationale: "baseline", activated_at: "2026-06-20T10:00:00Z", superseded_at: null, created_at: "2026-06-20T09:00:00Z" },
        { id: "p1", version: 1, status: "superseded", created_by: "human", rationale: "first cut", activated_at: "2026-06-10T10:00:00Z", superseded_at: "2026-06-20T10:00:00Z", created_at: "2026-06-10T09:00:00Z" },
      ],
      error: null,
    },
    storefront_optimizer_policy: {
      data: {
        id: "op1",
        active: true,
        product_scope: ["ea433e56-0aa4-4b46-9107-feb11f77f533"],
        auto_run_reversible: false,
        rationale: "amazing-coffee only — propose-and-approve",
        updated_by: "ceo-uid",
        updated_at: "2026-06-27T12:00:00Z",
      },
      error: null,
    },
    iteration_recommendations: {
      data: [
        { id: "r1", action_type: "new_static_adset", title: "Test ROAS-1.6 floor adset", rationale: "Top-quartile creative on the v3 floor", persona: "media_buyer", status: "pending", created_at: "2026-06-29T11:00:00Z" },
        { id: "r2", action_type: "new_lander_variant", title: "Bold benefit hero", rationale: "winning angle from grader", persona: "direct_response_marketer", status: "pending", created_at: "2026-06-29T10:00:00Z" },
      ],
      error: null,
    },
    agent_jobs: {
      data: [
        { id: "aj1", spec_slug: "prod-a:advertorial:all", status: "needs_approval", pending_actions: [{ id: "p1" }, { id: "p2" }], created_at: "2026-06-29T08:00:00Z" },
        { id: "aj2", spec_slug: "prod-b:pdp:all", status: "queued", pending_actions: null, created_at: "2026-06-28T08:00:00Z" },
      ],
      error: null,
    },
    storefront_campaign_grades: {
      data: [
        { id: "g1", experiment_id: "exp-1", grade_initial: 8, grade_revised: null, hypothesis_quality: 9, result_quality: 7, graded_by: "agent", initial_graded_at: "2026-06-25T10:00:00Z", revised_graded_at: null },
        { id: "g2", experiment_id: "exp-2", grade_initial: 5, grade_revised: 7, hypothesis_quality: 6, result_quality: 4, graded_by: "human", initial_graded_at: "2026-04-01T10:00:00Z", revised_graded_at: "2026-06-20T10:00:00Z" },
      ],
      error: null,
    },
    storefront_experiments: {
      data: [
        {
          id: "exp-1",
          product_id: "prod-a",
          lander_type: "advertorial",
          audience: "all",
          lever: "headline",
          status: "promoted",
          last_decision: { delivery_flag: "ok", rule: "promote_winner" },
          started_at: "2026-06-20T00:00:00Z",
          stopped_at: "2026-06-26T00:00:00Z",
        },
        {
          id: "exp-2",
          product_id: "prod-b",
          lander_type: "pdp",
          audience: "all",
          lever: "hero",
          status: "running",
          last_decision: { delivery_flag: "failed_to_deliver", rule: "blocked_promote_undelivered" },
          started_at: "2026-06-25T00:00:00Z",
          stopped_at: null,
        },
        {
          id: "exp-3",
          product_id: "prod-c",
          lander_type: "listicle",
          audience: "all",
          lever: "chapter_order",
          status: "running",
          last_decision: null,
          started_at: "2026-06-28T00:00:00Z",
          stopped_at: null,
        },
      ],
      error: null,
    },
    iteration_runs: {
      data: {
        id: "run-1",
        status: "complete",
        snapshot_date: "2026-06-29",
        policy_active: true,
        policy_version_id: "p2",
        meta_ad_account_id: "acct-1",
        counts: { actions_decided: 2, recommendations: 2, outcomes_reconciled: 1 },
        error: null,
        started_at: "2026-06-29T08:00:00Z",
        finished_at: "2026-06-29T08:05:00Z",
        duration_ms: 300000,
      },
      error: null,
    },
    iteration_actions: {
      data: [
        { id: "a1", action_type: "scale_up", status: "executed", rationale: "ROAS 1.8 ≥ trigger", outcome_roas: 1.7, outcome_revenue_cents: 12000, outcome_window_days: 7, guardrail: null, created_at: "2026-06-29T08:02:00Z" },
        { id: "a2", action_type: "pause", status: "escalated", rationale: "below floor 3d", outcome_roas: null, outcome_revenue_cents: null, outcome_window_days: null, guardrail: "min_budget_floor", created_at: "2026-06-29T08:03:00Z" },
      ],
      error: null,
    },
  });

  const { actions } = directorLeashCandidates(baseJob);
  assert.equal(actions.length, 1);

  const brief = await buildGrowthDirectorBrief(admin, baseJob, actions);

  assert.equal(brief.jobId, "job-1");
  assert.equal(brief.workspaceId, "ws-1");
  assert.equal(brief.specSlug, "growth-spec-1");
  assert.deepEqual(brief.categories, ["iteration_policy_activation"]);
  assert.equal(brief.actions.length, 1);
  assert.equal(brief.actions[0].summary, "Activate iteration_policies v3");
  assert.equal(brief.multi, false);

  // The growth autonomy row (the same DB row directorLiveStateFact wraps the prompt with) is in the brief.
  assert.deepEqual(brief.growthAutonomy, { live: true, autonomous: false });

  // The active+pending+superseded iteration_policies versions are loaded, newest first.
  assert.equal(brief.iterationPolicies.length, 3);
  assert.deepEqual(
    brief.iterationPolicies.map((p) => ({ version: p.version, status: p.status })),
    [
      { version: 3, status: "pending" },
      { version: 2, status: "active" },
      { version: 1, status: "superseded" },
    ],
  );

  // The single-row storefront_optimizer_policy is loaded.
  assert.ok(brief.storefrontOptimizerPolicy, "expected an optimizer policy row");
  assert.equal(brief.storefrontOptimizerPolicy!.active, true);
  assert.equal(brief.storefrontOptimizerPolicy!.auto_run_reversible, false);

  // The open pending recommendation queue is loaded.
  assert.equal(brief.pendingRecommendations.length, 2);
  assert.equal(brief.pendingRecommendations[0].action_type, "new_static_adset");

  // The open storefront-optimizer agent_jobs (proposals in flight) are loaded.
  assert.equal(brief.openOptimizerJobs.length, 2);
  assert.equal(brief.openOptimizerJobs[0].surfaceKey, "prod-a:advertorial:all");
  assert.equal(brief.openOptimizerJobs[0].status, "needs_approval");
  assert.equal(brief.openOptimizerJobs[0].pendingActionsCount, 2);
  assert.equal(brief.openOptimizerJobs[1].pendingActionsCount, 0);

  // The recent storefront_campaign_grades rows are loaded — both axes + the human-override flag.
  assert.equal(brief.recentCampaignGrades.length, 2);
  assert.equal(brief.recentCampaignGrades[0].experiment_id, "exp-1");
  assert.equal(brief.recentCampaignGrades[0].grade_initial, 8);
  assert.equal(brief.recentCampaignGrades[0].grade_revised, null);
  assert.equal(brief.recentCampaignGrades[1].graded_by, "human");

  // The per-experiment delivery flag is extracted from last_decision.delivery_flag.
  assert.equal(brief.recentExperiments.length, 3);
  assert.equal(brief.recentExperiments[0].delivery_flag, "ok");
  assert.equal(brief.recentExperiments[1].delivery_flag, "failed_to_deliver");
  assert.equal(brief.recentExperiments[2].delivery_flag, null);

  // The latest iteration_runs row is loaded with its supervisability fields.
  assert.ok(brief.latestIterationRun, "expected a latest iteration_runs row");
  assert.equal(brief.latestIterationRun!.id, "run-1");
  assert.equal(brief.latestIterationRun!.status, "complete");
  assert.equal(brief.latestIterationRun!.policy_active, true);
  assert.equal(brief.latestIterationRun!.snapshot_date, "2026-06-29");

  // The iteration_actions outcomes (status mix + outcome_roas) are loaded.
  assert.equal(brief.iterationActionOutcomes.length, 2);
  assert.equal(brief.iterationActionOutcomes[0].action_type, "scale_up");
  assert.equal(brief.iterationActionOutcomes[0].status, "executed");
  assert.equal(brief.iterationActionOutcomes[0].outcome_roas, 1.7);
  assert.equal(brief.iterationActionOutcomes[1].guardrail, "min_budget_floor");
});

test("buildGrowthDirectorBrief survives read errors — missing rows render as null/[], not a throw", async () => {
  const admin = makeAdmin({
    function_autonomy: { data: null, error: null },
    iteration_policies: { data: null, error: null },
    storefront_optimizer_policy: { data: null, error: null },
    iteration_recommendations: { data: null, error: null },
    agent_jobs: { data: null, error: null },
    storefront_campaign_grades: { data: null, error: null },
    storefront_experiments: { data: null, error: null },
    iteration_runs: { data: null, error: null },
    iteration_actions: { data: null, error: null },
  });
  const { actions } = directorLeashCandidates(baseJob);
  const brief = await buildGrowthDirectorBrief(admin, baseJob, actions);
  assert.equal(brief.growthAutonomy, null);
  assert.deepEqual(brief.iterationPolicies, []);
  assert.equal(brief.storefrontOptimizerPolicy, null);
  assert.deepEqual(brief.pendingRecommendations, []);
  assert.deepEqual(brief.openOptimizerJobs, []);
  assert.deepEqual(brief.recentCampaignGrades, []);
  assert.deepEqual(brief.recentExperiments, []);
  assert.equal(brief.latestIterationRun, null);
  assert.deepEqual(brief.iterationActionOutcomes, []);
});

test("growthDirectorInvestigationPrompt wraps with directorLiveStateFact and renders the loaded brief data (including the latest iteration_runs row + iteration_actions outcomes)", async () => {
  const admin = makeAdmin({
    // directorLiveStateFact also reads function_autonomy → renders the LIVE+AUTONOMOUS line into the prompt.
    function_autonomy: { data: { live: true, autonomous: true, updated_at: "2026-06-29T08:00:00Z", updated_by: "ceo-uid" }, error: null },
    iteration_policies: {
      data: [
        { id: "p3", version: 3, status: "pending", created_by: "agent", rationale: "tighter ROAS floor", activated_at: null, superseded_at: null, created_at: "2026-06-29T10:00:00Z" },
        { id: "p2", version: 2, status: "active", created_by: "human", rationale: "baseline", activated_at: "2026-06-20T10:00:00Z", superseded_at: null, created_at: "2026-06-20T09:00:00Z" },
      ],
      error: null,
    },
    storefront_optimizer_policy: {
      data: { id: "op1", active: true, product_scope: ["amazing-coffee"], auto_run_reversible: false, rationale: null, updated_by: null, updated_at: "2026-06-27T12:00:00Z" },
      error: null,
    },
    iteration_recommendations: {
      data: [{ id: "r1", action_type: "new_static_adset", title: "Test ROAS-1.6 floor adset", rationale: "Top-quartile creative", persona: "media_buyer", status: "pending", created_at: "2026-06-29T11:00:00Z" }],
      error: null,
    },
    agent_jobs: {
      data: [{ id: "aj1", spec_slug: "amazing-coffee:advertorial:all", status: "needs_approval", pending_actions: [{ id: "p1" }], created_at: "2026-06-29T08:00:00Z" }],
      error: null,
    },
    storefront_campaign_grades: {
      data: [{ id: "g1", experiment_id: "exp-1", grade_initial: 8, grade_revised: null, hypothesis_quality: 9, result_quality: 7, graded_by: "agent", initial_graded_at: "2026-06-25T10:00:00Z", revised_graded_at: null }],
      error: null,
    },
    storefront_experiments: {
      data: [{ id: "exp-1", product_id: "amazing-coffee", lander_type: "advertorial", audience: "all", lever: "headline", status: "promoted", last_decision: { delivery_flag: "failed_to_deliver" }, started_at: "2026-06-20T00:00:00Z", stopped_at: null }],
      error: null,
    },
    iteration_runs: {
      data: {
        id: "run-1",
        status: "complete",
        snapshot_date: "2026-06-29",
        policy_active: true,
        policy_version_id: "p2",
        meta_ad_account_id: "acct-1",
        counts: { actions_decided: 2, recommendations: 1 },
        error: null,
        started_at: "2026-06-29T08:00:00Z",
        finished_at: "2026-06-29T08:05:00Z",
        duration_ms: 300000,
      },
      error: null,
    },
    iteration_actions: {
      data: [
        { id: "a1", action_type: "scale_up", status: "executed", rationale: "ROAS 1.8 ≥ trigger", outcome_roas: 1.7, outcome_revenue_cents: 12000, outcome_window_days: 7, guardrail: null, created_at: "2026-06-29T08:02:00Z" },
      ],
      error: null,
    },
  });

  const { actions } = directorLeashCandidates(baseJob);
  const brief = await buildGrowthDirectorBrief(admin, baseJob, actions);
  const prompt = await growthDirectorInvestigationPrompt(admin, brief);

  // The live-state wrap is in place (directorLiveStateFact's signature header).
  assert.match(prompt, /Your authoritative live-state \(from function_autonomy/);
  assert.match(prompt, /LIVE \+ AUTONOMOUS/);

  // The persona + leash narration is present.
  assert.match(prompt, /Growth Director for ShopCX/);
  assert.match(prompt, /iteration_policy_activation/);
  assert.match(prompt, /storefront_optimizer_policy_activation/);
  assert.match(prompt, /reallocate_within_ceiling/);
  assert.match(prompt, /promote_ready_to_test_creative/);
  assert.match(prompt, /pause_underperforming_creative/);

  // The loaded brief surfaces render into the prompt.
  assert.match(prompt, /v3 · status=pending/);
  assert.match(prompt, /v2 · status=active/);
  assert.match(prompt, /storefront_optimizer_policy:[\s\S]*active=true/);
  assert.match(prompt, /Test ROAS-1\.6 floor adset/);

  // The Phase-2 surfaces — proposals in flight, recent grades, per-campaign mini-report — render.
  assert.match(prompt, /storefront-optimizer agent_jobs \(open, newest first\):/);
  assert.match(prompt, /surface=amazing-coffee:advertorial:all/);
  assert.match(prompt, /storefront_campaign_grades \(recent, newest first\):/);
  assert.match(prompt, /exp=exp-1 · initial=8\/10 · revised=—/);
  assert.match(prompt, /storefront_experiments \(recent, newest first\) — the per-campaign mini-report/);
  assert.match(prompt, /delivery_flag=failed_to_deliver/);

  // growth-adopt-meta-iteration-engine Phase 2 — the latest iteration_runs row + the
  // iteration_actions outcomes mix render into the prompt (the realized signal the Director judges
  // before approving the next policy version).
  assert.match(prompt, /iteration_runs \(latest, newest first\):/);
  assert.match(prompt, /policy_active=true/);
  assert.match(prompt, /day=2026-06-29/);
  assert.match(prompt, /iteration_actions \(latest run · 1 action\):/);
  assert.match(prompt, /status mix: executed=1/);
  assert.match(prompt, /realized outcome_roas: mean 1\.70/);

  // The request under investigation block + the JSON verdict shape are present.
  assert.match(prompt, /This request — category=iteration_policy_activation/);
  assert.match(prompt, /"verdict":"auto-approve"/);
  assert.match(prompt, /"verdict":"escalate"/);
});

test("growthDirectorInvestigationPrompt renders a multi-action bundle with the all-or-nothing rule", async () => {
  const multiJob: DirectorTargetJob = {
    ...baseJob,
    pending_actions: [
      { id: "a1", type: "iteration_policy_activation", summary: "Activate v3", preview: "p3 preview", cmd: "" },
      { id: "a2", type: "storefront_optimizer_policy_activation", summary: "Flip optimizer.active=true", preview: "p2 preview", cmd: "" },
    ],
  };
  const admin = makeAdmin({
    function_autonomy: { data: { live: true, autonomous: true, updated_at: "2026-06-29T08:00:00Z", updated_by: "ceo-uid" }, error: null },
    iteration_policies: { data: [], error: null },
    storefront_optimizer_policy: { data: null, error: null },
    iteration_recommendations: { data: [], error: null },
    agent_jobs: { data: [], error: null },
    storefront_campaign_grades: { data: [], error: null },
    storefront_experiments: { data: [], error: null },
    iteration_runs: { data: null, error: null },
    iteration_actions: { data: [], error: null },
  });
  const { actions, verdict } = directorLeashCandidates(multiJob);
  assert.equal(verdict, "multi");

  const brief = await buildGrowthDirectorBrief(admin, multiJob, actions);
  assert.equal(brief.multi, true);
  const prompt = await growthDirectorInvestigationPrompt(admin, brief);
  assert.match(prompt, /BUNDLES 2 actions/);
  assert.match(prompt, /ALL-OR-NOTHING/);
  assert.match(prompt, /Action 1 — category=iteration_policy_activation/);
  assert.match(prompt, /Action 2 — category=storefront_optimizer_policy_activation/);
});

test("gradeDirectorDecision rejects unknown experiment with a typed result, never throws", async () => {
  const admin = makeAdmin({
    storefront_campaign_grades: { data: null, error: null }, // no row for this experiment_id
  });
  const result = await gradeDirectorDecision(admin, {
    workspaceId: "ws-1",
    experimentId: "exp-missing",
    axis: "initial",
    grade: 7,
    reasoning: "looks reasonable in hindsight",
  });
  assert.equal(result.ok, false);
  assert.match(result.detail, /no storefront_campaign_grades row/);
});

test("gradeDirectorDecision validates inputs (axis, grade, reasoning) without touching the DB", async () => {
  const admin = makeAdmin({});

  const bad1 = await gradeDirectorDecision(admin, { workspaceId: "", experimentId: "exp-1", axis: "initial", grade: 5, reasoning: "x" });
  assert.equal(bad1.ok, false);
  assert.match(bad1.detail, /workspaceId required/);

  const bad2 = await gradeDirectorDecision(admin, { workspaceId: "ws-1", experimentId: "exp-1", axis: "weird" as "initial", grade: 5, reasoning: "x" });
  assert.equal(bad2.ok, false);
  assert.match(bad2.detail, /axis must be/);

  const bad3 = await gradeDirectorDecision(admin, { workspaceId: "ws-1", experimentId: "exp-1", axis: "initial", grade: 11, reasoning: "x" });
  assert.equal(bad3.ok, false);
  assert.match(bad3.detail, /grade must be 1–10/);

  const bad4 = await gradeDirectorDecision(admin, { workspaceId: "ws-1", experimentId: "exp-1", axis: "initial", grade: 5, reasoning: "   " });
  assert.equal(bad4.ok, false);
  assert.match(bad4.detail, /reasoning required/);
});

test("gradeDirectorDecision applies an override on an existing grade row (writes the human-override fields)", async () => {
  const admin = makeAdmin({
    storefront_campaign_grades: {
      data: { id: "g1", grade_initial: 4, grade_revised: null, graded_by: "agent" },
      error: null,
    },
    director_activity: { data: null, error: null },
  });
  const result = await gradeDirectorDecision(admin, {
    workspaceId: "ws-1",
    experimentId: "exp-1",
    axis: "initial",
    grade: 8,
    reasoning: "sound bet — rubric under-weighted the funnel signal",
    decidedBy: "ceo-uid",
  });
  assert.equal(result.ok, true);
  assert.equal(result.cleared, false);
  assert.equal(result.gradeId, "g1");
  assert.match(result.detail, /set initial grade to 8/);
});

// ── media-buyer-grade-rollup-on-growth-director-brief Phase 1 ─────────────────────────────────────
// The Media Buyer supervision rollup on the brief + the prompt section that surfaces it. Verifies:
//   - a populated workspace → mediaBuyerRollup carries per-verb avgs, the 14-day sparkline, the
//     concur rate, and the latest arming authorization; the prompt renders "Media Buyer supervision".
//   - a zero-grades workspace (no grades, no shadow reviews, no arming row) → mediaBuyerRollup is
//     null and the prompt OMITS the section rather than rendering an empty header.

test("buildGrowthDirectorBrief carries a populated mediaBuyerRollup + growthDirectorInvestigationPrompt renders the Media Buyer supervision section (Phase 1)", async () => {
  const now = new Date("2026-07-09T00:00:00Z");
  const iso = (d: Date) => d.toISOString();
  const day = (offsetDays: number) => iso(new Date(now.getTime() - offsetDays * 24 * 60 * 60 * 1000));
  const admin = makeAdmin({
    // Minimal Growth control surfaces so the brief loader completes.
    function_autonomy: { data: { live: true, autonomous: true, updated_at: iso(now), updated_by: "ceo-uid" }, error: null },
    iteration_policies: { data: [], error: null },
    storefront_optimizer_policy: { data: null, error: null },
    iteration_recommendations: { data: [], error: null },
    agent_jobs: { data: [], error: null },
    storefront_campaign_grades: { data: [], error: null },
    storefront_experiments: { data: [], error: null },
    iteration_runs: { data: null, error: null },
    iteration_actions: { data: [], error: null },
    // The Media Buyer supervision rollup — three graded actions across two verbs + shadow reviews +
    // an arming authorization row. `graded_at` is within the 14-day and 30-day windows.
    media_buyer_action_grades: {
      data: [
        { action_kind: "media_buyer_promoted_winner", overall_grade: 9, graded_at: day(1) },
        { action_kind: "media_buyer_promoted_winner", overall_grade: 7, graded_at: day(2) },
        { action_kind: "media_buyer_paused_loser", overall_grade: 8, graded_at: day(3) },
      ],
      error: null,
    },
    media_buyer_shadow_reviews: {
      data: [
        { verdict: "concur", reviewed_at: day(1) },
        { verdict: "concur", reviewed_at: day(2) },
        { verdict: "dissent", reviewed_at: day(3) },
        { verdict: "undecided", reviewed_at: day(4) },
      ],
      error: null,
    },
    media_buyer_arming_authorization: {
      data: {
        id: "auth-1",
        meta_ad_account_id: null,
        iso_week: "2026-W28",
        allowed: true,
        reasons: { reasons: [], metrics: { agreementRate: 0.75 } },
        evaluated_at: iso(now),
        expires_at: iso(new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)),
      },
      error: null,
    },
  });

  const { actions } = directorLeashCandidates(baseJob);
  const brief = await buildGrowthDirectorBrief(admin, baseJob, actions);

  assert.ok(brief.mediaBuyerRollup, "expected mediaBuyerRollup to be populated");
  const r = brief.mediaBuyerRollup!;

  // Per-verb avg grades — grouped by action_kind, sorted alphabetically.
  assert.equal(r.avgGradeByKind.length, 2);
  assert.deepEqual(
    r.avgGradeByKind.map((v) => v.actionKind),
    ["media_buyer_paused_loser", "media_buyer_promoted_winner"],
  );
  const promoted = r.avgGradeByKind.find((v) => v.actionKind === "media_buyer_promoted_winner")!;
  assert.equal(promoted.count, 2);
  assert.equal(promoted.avgGrade, 8);

  // 14-day daily sparkline — one bucket per UTC day.
  assert.ok(r.dailyOverallAvg14d.length >= 3, "expected ≥3 daily buckets for 3 in-window grades");

  // Shadow agreement — 2 concur / 4 reviewed = 0.5.
  assert.equal(r.shadowAgreement.reviewedCount, 4);
  assert.equal(r.shadowAgreement.concurCount, 2);
  assert.equal(r.shadowAgreement.concurRate, 0.5);

  // Latest arming authorization row.
  assert.ok(r.latestArmingAuthorization, "expected a latest arming authorization row");
  assert.equal(r.latestArmingAuthorization!.isoWeek, "2026-W28");
  assert.equal(r.latestArmingAuthorization!.allowed, true);

  // The prompt renders the Media Buyer supervision section with the numeric averages.
  const prompt = await growthDirectorInvestigationPrompt(admin, brief);
  assert.match(prompt, /## Media Buyer supervision/);
  assert.match(prompt, /avg grade by action_kind \(last 30d\):/);
  assert.match(prompt, /media_buyer_promoted_winner: 8\.00\/10 \(2 actions\)/);
  assert.match(prompt, /media_buyer_paused_loser: 8\.00\/10 \(1 action\)/);
  assert.match(prompt, /daily overall avg grade \(last 14d\):/);
  assert.match(prompt, /shadow-vs-review agreement \(last 14d\): 50\.0% \(2\/4 concur\)/);
  assert.match(prompt, /latest arming authorization: iso_week=2026-W28/);
  assert.match(prompt, /allowed=true/);
});

test("buildGrowthDirectorBrief returns null mediaBuyerRollup + prompt omits 'Media Buyer supervision' section for a zero-grades workspace (Phase 1)", async () => {
  const admin = makeAdmin({
    function_autonomy: { data: { live: true, autonomous: true, updated_at: "2026-07-01T00:00:00Z", updated_by: "ceo-uid" }, error: null },
    iteration_policies: { data: [], error: null },
    storefront_optimizer_policy: { data: null, error: null },
    iteration_recommendations: { data: [], error: null },
    agent_jobs: { data: [], error: null },
    storefront_campaign_grades: { data: [], error: null },
    storefront_experiments: { data: [], error: null },
    iteration_runs: { data: null, error: null },
    iteration_actions: { data: [], error: null },
    // No grades, no shadow reviews, no arming authorization row — the rollup MUST be null so the
    // prompt omits the section (the spec's verification: prompt omits rather than renders an
    // empty header).
    media_buyer_action_grades: { data: [], error: null },
    media_buyer_shadow_reviews: { data: [], error: null },
    media_buyer_arming_authorization: { data: null, error: null },
  });
  const { actions } = directorLeashCandidates(baseJob);
  const brief = await buildGrowthDirectorBrief(admin, baseJob, actions);
  assert.equal(brief.mediaBuyerRollup, null);
  const prompt = await growthDirectorInvestigationPrompt(admin, brief);
  assert.doesNotMatch(prompt, /Media Buyer supervision/);
});

test("gradeDirectorDecision un-grades (grade=null) — resets the chosen axis to NULL + graded_by back to 'agent'", async () => {
  const admin = makeAdmin({
    storefront_campaign_grades: {
      data: { id: "g1", grade_initial: 9, grade_revised: null, graded_by: "human" },
      error: null,
    },
    director_activity: { data: null, error: null },
  });
  const result = await gradeDirectorDecision(admin, {
    workspaceId: "ws-1",
    experimentId: "exp-1",
    axis: "initial",
    grade: null,
    reasoning: "override was wrong — let the agent grade re-stand",
    decidedBy: "ceo-uid",
  });
  assert.equal(result.ok, true);
  assert.equal(result.cleared, true);
  assert.match(result.detail, /cleared initial grade/);
});
