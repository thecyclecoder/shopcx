/**
 * Have any crowned winners actually GRADUATED to the cold scaler?
 * A crowned winner that never graduates keeps occupying a test-cohort explore slot,
 * which drives exploreDeficit to 0 and seals the cohort against new creative.
 * READ-ONLY.
 */
import { createAdminClient } from "./_bootstrap";
const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";

async function main() {
  const admin = createAdminClient();

  const { data: winners } = await admin.from("media_buyer_crowned_winners").select("*").eq("workspace_id", WS);
  const graduated = (winners ?? []).filter((w) => w.scaler_meta_adset_id);
  console.log(`crowned winners: ${(winners ?? []).length} · graduated to scaler: ${graduated.length}`);

  const { data: cohorts } = await admin.from("media_buyer_cold_scaler_cohorts").select("*").eq("workspace_id", WS);
  console.log(`\ncold-scaler cohorts (${(cohorts ?? []).length}):`);
  for (const c of cohorts ?? []) {
    const keys = Object.keys(c).filter((k) => /product|campaign|active|status|arm|ceiling|created/i.test(k));
    console.log("  " + keys.map((k) => `${k}=${String(c[k]).slice(0, 36)}`).join(" · "));
  }

  // Any escalation / activity about the graduate path
  const { data: acts } = await admin.from("director_activity")
    .select("created_at,kind,summary,metadata").eq("workspace_id", WS)
    .or("kind.ilike.%graduate%,kind.ilike.%crown%,kind.ilike.%scaler%,kind.ilike.%replenish%")
    .order("created_at", { ascending: false }).limit(25);
  console.log(`\nrecent graduate/crown/scaler/replenish activity (${(acts ?? []).length}):`);
  for (const a of acts ?? []) {
    console.log(`  ${String(a.created_at).slice(0, 16)}  ${String(a.kind).padEnd(48)} ${String(a.summary ?? "").slice(0, 90)}`);
  }

  // Arming authorization — the graduate may be gated behind it
  for (const t of ["media_buyer_cold_scaler_arming_authorization", "media_buyer_arming_authorization"]) {
    const { data, error } = await admin.from(t).select("*").eq("workspace_id", WS)
      .order("created_at", { ascending: false }).limit(3);
    console.log(`\n${t}: ${error ? error.message : (data ?? []).length + " rows"}`);
    for (const r of data ?? []) {
      const keys = Object.keys(r).filter((k) => !/^(id|workspace_id)$/.test(k));
      console.log("  " + keys.map((k) => `${k}=${String(r[k]).slice(0, 30)}`).join(" · "));
    }
  }
}
main().then(() => process.exit(0)).catch((e) => {
  console.error(e instanceof Error ? e.message : JSON.stringify(e));
  process.exit(1);
});
