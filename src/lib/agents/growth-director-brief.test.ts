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
  // Every chain method returns the same chain object — both .select/.eq/.order/.limit are chainable and
  // .maybeSingle is the terminal that resolves the result. We also make the chain `thenable` so plain
  // `await admin.from(...).select(...)` works (no terminal .maybeSingle), which is what the
  // iteration_policies / iteration_recommendations queries do.
  chain.select = () => chain;
  chain.eq = () => chain;
  chain.order = () => chain;
  chain.limit = () => chain;
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

test("buildGrowthDirectorBrief loads the growth autonomy row, the iteration_policies versions, the optimizer policy, the pending recommendations, the latest iteration_runs row, and its iteration_actions outcomes", async () => {
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
    iteration_runs: { data: null, error: null },
    iteration_actions: { data: null, error: null },
  });
  const { actions } = directorLeashCandidates(baseJob);
  const brief = await buildGrowthDirectorBrief(admin, baseJob, actions);
  assert.equal(brief.growthAutonomy, null);
  assert.deepEqual(brief.iterationPolicies, []);
  assert.equal(brief.storefrontOptimizerPolicy, null);
  assert.deepEqual(brief.pendingRecommendations, []);
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
