/**
 * Scope the three cold-scaler arming feeds: does each PRODUCER exist, and is it ever TRIGGERED?
 *
 * The arming gate needs three evidence feeds, all currently empty. For each, the fix is very
 * different depending on which of these is true:
 *   (a) no producer exists              → build it
 *   (b) producer exists, nothing calls it → wire it (the pattern that broke the graduate)
 *   (c) producer runs but writes nothing → debug it
 *
 * READ-ONLY.
 */
import { createAdminClient } from "./_bootstrap";

const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";

async function count(admin: ReturnType<typeof createAdminClient>, table: string, scoped = true) {
  const q = admin.from(table).select("id", { count: "exact", head: true });
  const { count: n, error } = scoped ? await q.eq("workspace_id", WS) : await q;
  return error ? `ERROR ${error.message}` : String(n ?? 0);
}

async function main() {
  const admin = createAdminClient();

  console.log("=== FEED TABLES (rows all time) ===");
  for (const t of [
    "media_buyer_shadow_reviews",
    "media_buyer_sensor_trust",
    "media_buyer_cold_scaler_cac_ltv_snapshots",
  ]) {
    console.log(`  ${t.padEnd(44)} ${await count(admin, t)}`);
  }

  // Are the producer JOBS ever enqueued?
  console.log("\n=== agent_jobs by kind (producer jobs) ===");
  const kinds = ["sensor-trust-probe", "media-buyer", "cold-scaler-cac-ltv", "media-buyer-shadow-review"];
  for (const k of kinds) {
    const { count: n, error } = await admin.from("agent_jobs")
      .select("id", { count: "exact", head: true }).eq("workspace_id", WS).eq("kind", k);
    const { data: newest } = await admin.from("agent_jobs")
      .select("created_at,status").eq("workspace_id", WS).eq("kind", k)
      .order("created_at", { ascending: false }).limit(1);
    console.log(`  ${k.padEnd(30)} ${error ? `ERROR ${error.message}` : String(n ?? 0).padStart(5)} job(s)  newest ${(newest ?? [])[0] ? `${String(newest![0].created_at).slice(0, 16)} ${newest![0].status}` : "—"}`);
  }

  // Shadow mode is the source of shadow reviews — is any policy in shadow?
  const { data: pol } = await admin.from("iteration_policies")
    .select("id,mode,status").eq("workspace_id", WS);
  console.log("\n=== iteration policies (shadow mode produces shadow actions to review) ===");
  for (const p of pol ?? []) console.log(`  ${String(p.id).slice(0, 8)} status=${p.status} mode=${p.mode}`);

  // What shadow-flavoured activity exists at all?
  const { data: acts } = await admin.from("director_activity")
    .select("action_kind").eq("workspace_id", WS).ilike("action_kind", "%shadow%").limit(200);
  const byKind: Record<string, number> = {};
  for (const a of acts ?? []) byKind[String(a.action_kind)] = (byKind[String(a.action_kind)] ?? 0) + 1;
  console.log("\n=== director_activity kinds containing 'shadow' ===");
  if (!Object.keys(byKind).length) console.log("  none");
  for (const [k, v] of Object.entries(byKind).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(52)} ${v}`);
}
main().then(() => process.exit(0)).catch((e) => {
  console.error(e instanceof Error ? e.message : JSON.stringify(e));
  process.exit(1);
});
