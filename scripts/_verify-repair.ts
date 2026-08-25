/** Confirm the 3 repaired adsets: live status, exclusions on Meta, and the stamped floor. READ-ONLY. */
import { createAdminClient } from "./_bootstrap";
import { getMetaUserToken } from "../src/lib/meta-ads";

const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const IDS = ["120250066584430326", "120250143054030326", "120252355825840184"];

async function main() {
  const admin = createAdminClient();
  const token = await getMetaUserToken(WS);
  if (!token) throw new Error("no Meta token");

  const { data: rows, error } = await admin.from("meta_adsets")
    .select("meta_adset_id,name,effective_status,clean_signal_since").eq("workspace_id", WS).in("meta_adset_id", IDS);
  if (error) throw new Error(`meta_adsets: ${error.message}`);

  for (const id of IDS) {
    const r = (rows ?? []).find((x) => String(x.meta_adset_id) === id);
    const j = await fetch(
      `https://graph.facebook.com/v21.0/${id}?fields=id,name,status,effective_status,targeting,daily_budget&access_token=${encodeURIComponent(token)}`,
    ).then((x) => x.json()) as Record<string, unknown>;
    if (j.error) { console.log(`❌ ${id}: ${JSON.stringify(j.error)}`); continue; }
    const t = (j.targeting ?? {}) as Record<string, unknown>;
    const excl = (t.excluded_custom_audiences ?? []) as Array<Record<string, unknown>>;
    const geo = t.geo_locations as Record<string, unknown> | undefined;

    console.log(`\n${String(j.name).slice(0, 50)}`);
    console.log(`  status ${j.status} · effective ${j.effective_status} · $${Number(j.daily_budget ?? 0) / 100}/day`);
    console.log(`  ${excl.length ? "✅" : "❌"} exclusions: ${JSON.stringify(excl.map((e) => String(e.id)))}`);
    console.log(`  ${geo ? "✅" : "❌"} geo preserved: ${JSON.stringify(geo?.countries)} location_types=${JSON.stringify(geo?.location_types)}`);
    console.log(`  ${r?.clean_signal_since ? "✅" : "❌"} clean_signal_since = ${String(r?.clean_signal_since ?? "unset").slice(0, 10)}`);
  }

  console.log(`\nNOTE: a targeting edit sends an ad set back through Meta review, so effective_status may read`);
  console.log(`PENDING_REVIEW / IN_PROCESS briefly before returning to ACTIVE. status=ACTIVE is the intent field.`);
}
main().then(() => process.exit(0)).catch((e) => {
  console.error(e instanceof Error ? e.message : JSON.stringify(e));
  process.exit(1);
});
