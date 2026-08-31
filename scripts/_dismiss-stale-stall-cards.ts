/**
 * Dismiss the phantom cold-scaler stall cards.
 *
 * They claim Superfood Tabs has "3 crowned winners but no graduate" and Zen Relax "2". Verified
 * FALSE: all five crowns were revoked 2026-08-25 (the crown bar moved 8→15 purchases plus a
 * confidence bound, so none still qualifies), and `countEligibleCrownedWinnersByCohort` counted them
 * only because it checked `graduated_at IS NULL` with no notion of revocation. With the fix in
 * place, every cohort reads 0 eligible.
 *
 * Re-verifies through the FIXED counter before dismissing anything — a card is only dismissed when
 * its cohort genuinely has zero pending work. Pass --apply to write.
 */
import { createAdminClient } from "./_bootstrap";
import { countEligibleCrownedWinnersByCohort } from "../src/lib/media-buyer/cold-scaler-graduate-heartbeat";

const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const APPLY = process.argv.includes("--apply");

async function main() {
  const admin = createAdminClient();

  const { data: notifs, error } = await admin.from("dashboard_notifications")
    .select("id,title,created_at,metadata").eq("workspace_id", WS)
    .eq("type", "agent_approval_request").eq("dismissed", false);
  if (error) throw new Error(`dashboard_notifications: ${error.message}`);

  const stall = (notifs ?? []).filter(
    (n) => String((n.metadata as Record<string, unknown> | null)?.escalation_kind ?? "") === "cold_scaler_graduate_stall",
  );
  console.log(`undismissed cold_scaler_graduate_stall cards: ${stall.length}`);
  if (!stall.length) return;

  // Re-verify each card's cohort through the FIXED counter.
  const { data: cohorts } = await admin.from("media_buyer_cold_scaler_cohorts")
    .select("id,product_id,meta_ad_account_id").eq("workspace_id", WS);
  const scopes = (cohorts ?? []).map((c) => ({
    cohortId: String(c.id),
    metaAdAccountId: c.meta_ad_account_id ? String(c.meta_ad_account_id) : null,
    productId: c.product_id ? String(c.product_id) : null,
  }));
  const counts = await countEligibleCrownedWinnersByCohort(admin, { workspaceId: WS, cohortScopes: scopes });

  const toDismiss: string[] = [];
  for (const n of stall) {
    const cohortId = String((n.metadata as Record<string, unknown>).cohort_id ?? "");
    const eligible = counts.get(cohortId) ?? 0;
    const ok = eligible === 0;
    console.log(`  ${ok ? "✓ phantom" : "⚠ REAL"} ${String(n.created_at).slice(0, 10)} cohort ${cohortId.slice(0, 8)} — eligible now ${eligible} · "${String(n.title).slice(0, 60)}"`);
    if (ok) toDismiss.push(String(n.id));
    else console.log(`      NOT dismissing — this cohort has genuine pending graduate work.`);
  }

  if (!APPLY) { console.log(`\nDRY RUN — would dismiss ${toDismiss.length}. Pass --apply.`); return; }
  if (!toDismiss.length) { console.log("\nnothing to dismiss"); return; }

  const { error: uerr } = await admin.from("dashboard_notifications")
    .update({ dismissed: true }).in("id", toDismiss).eq("workspace_id", WS);
  if (uerr) throw new Error(`dismiss failed: ${uerr.message}`);
  console.log(`\n✅ dismissed ${toDismiss.length} phantom stall card(s)`);

  await admin.from("director_activity").insert({
    workspace_id: WS,
    director_function: "growth",
    action_kind: "cold_scaler_stall_cards_dismissed_as_phantom",
    reason:
      `CEO 2026-08-28: dismissed ${toDismiss.length} cold-scaler graduate-stall card(s). They cited crowned winners ` +
      `awaiting graduation that had been REVOKED on 2026-08-25 — countEligibleCrownedWinnersByCohort checked only ` +
      `graduated_at IS NULL and had no notion of revocation, so retired records read as pending work. With ` +
      `revoked_at added and filtered, every cohort reads 0 eligible. The cards were also 3 days older than the ` +
      `cohorts they named, against a 7-day window.`,
    metadata: { dismissed_notification_ids: toDismiss, autonomous: false },
  });
  console.log("✅ audit row written");
}
main().then(() => process.exit(0)).catch((e) => {
  console.error(e instanceof Error ? e.message : JSON.stringify(e));
  process.exit(1);
});
