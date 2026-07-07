// seed-media-buyer-iteration-policy — insert + activate ONE conservative
// iteration_policies row for the workspace (media-buyer-test-winner-loop Phase 2).
// The Media Buyer runner (src/lib/media-buyer/agent.ts) refuses to autonomously
// promote/kill without an active policy — this script opens the loop. Uses the
// sanctioned SDK: authorIterationPolicy → activateIterationPolicy (never a raw
// upsert on iteration_policies). Idempotent-safe: activating an already-active
// row is a no-op; a fresh call inserts a new pending version.
//
// Run:
//   npx tsx scripts/seed-media-buyer-iteration-policy.ts <workspaceId>
// Or set MB_WORKSPACE_ID in .env.local:
//   MB_WORKSPACE_ID=... npx tsx scripts/seed-media-buyer-iteration-policy.ts
import "./_bootstrap";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  authorIterationPolicy,
  activateIterationPolicy,
  type IterationPolicyDraft,
} from "@/lib/iteration-policy-authoring";
import { recordDirectorActivity } from "@/lib/director-activity";

/**
 * Conservative Phase 2 seed:
 *  - roas_floor 1.5 (spec's blended-CAC-LTV target; a conservative pause floor).
 *  - scale_up_roas_trigger 3.0 (double the floor — clear winners only).
 *  - scale_up_step_pct 0.15 / cap 0.25 — small budget bumps per pass.
 *  - scale_down_step_pct 0.20 — reverses a bad scale before pausing.
 *  - pause_min_spend_cents 10_000 ($100) — 2× the detector's default noise floor.
 *  - pause_window_days 7 — matches the ad-spend-governor rolling window.
 *  - per_object_cooldown_hours 24 — one action per object per day.
 *  - per_account_daily_budget_delta_ceiling_cents 100_000 ($1000) — the tight
 *    per-pass motion cap the Growth Director's leash expects.
 *  - min_budget_floor_cents 500 ($5) — never scale below this per-object floor.
 *  - never_pause_object_ids [] — no protected objects by default.
 */
const CONSERVATIVE_DRAFT: IterationPolicyDraft = {
  roas_floor: 1.5,
  scale_up_roas_trigger: 3.0,
  scale_up_step_pct: 0.15,
  scale_up_cap_pct: 0.25,
  scale_down_step_pct: 0.2,
  pause_min_spend_cents: 10_000,
  pause_window_days: 7,
  unpause_sales_after_pause: 5, // require ≥ 5 sales since pause before unpausing
  unpause_lookback_days: 14,
  min_creatives_per_adset: 0, // replenish handled by the Media Buyer loop, not the engine
  per_object_cooldown_hours: 24,
  per_account_daily_budget_delta_ceiling_cents: 100_000,
  min_budget_floor_cents: 500,
  never_pause_object_ids: [],
};

async function main() {
  const workspaceId = process.argv[2] || process.env.MB_WORKSPACE_ID;
  if (!workspaceId) {
    console.error("usage: npx tsx scripts/seed-media-buyer-iteration-policy.ts <workspaceId>");
    process.exit(1);
  }
  const admin = createAdminClient();

  const authored = await authorIterationPolicy(admin, {
    workspaceId,
    draft: CONSERVATIVE_DRAFT,
    createdBy: "director",
    rationale:
      "Media Buyer Phase 2 seed — conservative floors: 1.5× ROAS floor, 3.0× scale trigger, +15% step (cap 25%), $100 pause min-spend, $10 per-pass account motion ceiling. Opens the autonomous Test→Measure→Promote→Kill loop.",
  });
  console.log(`✓ authored policy v${authored.version} (id=${authored.policyId})`);

  const activated = await activateIterationPolicy(admin, {
    workspaceId,
    policyId: authored.policyId,
    activatedBy: "director",
  });
  console.log(
    activated.activated
      ? `✓ activated v${activated.version} (superseded ${activated.supersededPolicyId ?? "none"})`
      : `= v${activated.version} already active — no-op`,
  );

  await recordDirectorActivity(admin, {
    workspaceId,
    directorFunction: "growth",
    actionKind: "activated_iteration_policy",
    specSlug: "media-buyer-test-winner-loop",
    reason: "Seeded conservative iteration_policies row so the Media Buyer's Test→Measure→Promote→Kill loop can autonomously produce a non-empty action set.",
    metadata: {
      policy_id: authored.policyId,
      version: authored.version,
      superseded_policy_id: activated.supersededPolicyId,
      draft: CONSERVATIVE_DRAFT,
      autonomous: false,
    },
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
