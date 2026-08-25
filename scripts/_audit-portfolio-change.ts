/** One-off: write the missing director_activity audit row for the 2026-08-25 portfolio retune. Idempotent. */
import { createAdminClient } from "./_bootstrap";
const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const KIND = "media_buyer_test_portfolio_retuned";

async function main() {
  const admin = createAdminClient();
  const { data: existing } = await admin.from("director_activity")
    .select("id").eq("workspace_id", WS).eq("action_kind", KIND).limit(1);
  if (existing?.length) { console.log("audit row already present — no-op"); return; }

  const { error } = await admin.from("director_activity").insert({
    workspace_id: WS,
    director_function: "growth",
    action_kind: KIND,
    reason:
      "CEO 2026-08-25: crown_min_purchases 8→15 and per-test budget $150→$200/day on all 6 active cohorts. " +
      "Spend ramp now comes from BREADTH (more concurrent tests), not from scaling winners — measured pooled " +
      "post-crown CPA was 1.89x pre-crown across all 5 crowned winners while scaled IN PLACE (no scale campaign " +
      "involved), i.e. regression to the mean from crowning on an 8-purchase sample. Observed CPA is flat $100–$200/day " +
      "($312/$305/$306) and degrades above it ($337 at $300, $408 at $450), so $200 is the top of the plateau.",
    metadata: {
      crown_min_purchases: { from: 8, to: 15 },
      per_test_daily_budget_cents: { from: 15000, to: 20000, cohorts: 6 },
      pooled_post_crown_cpa_multiple: 1.89,
      autonomous: false,
    },
  });
  if (error) throw new Error(error.message);
  console.log("✅ audit row written");
}
main().then(() => process.exit(0)).catch((e) => {
  console.error(e instanceof Error ? e.message : JSON.stringify(e));
  process.exit(1);
});
