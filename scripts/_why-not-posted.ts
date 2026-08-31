/**
 * Why isn't Bianca posting a given ad campaign?
 * Walks EVERY gate in listReadyToTest's filter (brain: libraries/ready-to-test) one at a time,
 * then checks whether the replenish path would actually pick it up.
 * READ-ONLY.
 *
 * Run: npx tsx scripts/_why-not-posted.ts <ad_campaign_id>
 */
import { createAdminClient } from "./_bootstrap";
import { listReadyToTest } from "../src/lib/ads/ready-to-test";

const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const ID = process.argv[2] ?? "1319859a-d2d1-42e9-b125-fd6f00329a33";

const ok = (b: boolean) => (b ? "✅" : "❌");

async function main() {
  const admin = createAdminClient();

  const { data: c, error } = await admin.from("ad_campaigns").select("*").eq("id", ID).maybeSingle();
  if (error) throw new Error(error.message);
  if (!c) { console.log("no such ad_campaigns row"); return; }

  console.log(`=== ad_campaigns ${ID} ===`);
  for (const [k, v] of Object.entries(c)) {
    if (v === null) continue;
    console.log(`  ${k.padEnd(26)} ${typeof v === "object" ? JSON.stringify(v).slice(0, 160) : String(v).slice(0, 160)}`);
  }

  console.log(`\n=== GATES (listReadyToTest) ===`);
  const gStatus = c.status !== "archived";
  console.log(`  ${ok(gStatus)} status !== 'archived'            → ${c.status}`);

  const { data: vids } = await admin.from("ad_videos")
    .select("id,status,media_kind,created_at").eq("campaign_id", ID);
  const readyVid = (vids ?? []).filter((v) => v.status === "ready" || v.media_kind === "static");
  console.log(`  ${ok(readyVid.length > 0)} ≥1 ready video/static asset    → ${readyVid.length} of ${(vids ?? []).length}`);
  for (const v of vids ?? []) console.log(`        ${v.id}  status=${v.status}  kind=${v.media_kind}`);

  const gLander = !!c.landing_url;
  console.log(`  ${ok(gLander)} landing_url set                → ${c.landing_url ?? "NULL"}`);

  const { data: jobs } = await admin.from("ad_publish_jobs")
    .select("id,status,meta_adset_id,origin,created_at,error").eq("campaign_id", ID).order("created_at");
  const blocking = (jobs ?? []).filter((j) => ["queued", "uploading", "creating", "published"].includes(String(j.status)));
  console.log(`  ${ok(blocking.length === 0)} no active publish job          → ${blocking.length} blocking of ${(jobs ?? []).length} total`);
  for (const j of jobs ?? []) console.log(`        ${String(j.created_at).slice(0, 16)}  ${String(j.status).padEnd(10)} origin=${j.origin ?? "—"}  adset=${j.meta_adset_id ?? "—"}  ${j.error ? "err=" + String(j.error).slice(0, 60) : ""}`);

  const gMax = c.max_qc_eligible !== false || c.override_postable === true;
  console.log(`  ${ok(gMax)} max_qc_eligible !== false      → ${c.max_qc_eligible} (override_postable=${c.override_postable})`);

  // Max's actual verdict
  const { data: verdicts } = await admin.from("ad_creative_copy_qc_verdicts")
    .select("*").eq("campaign_id", ID).order("created_at", { ascending: false }).limit(3);
  console.log(`\n=== Max copy-QC verdicts (${(verdicts ?? []).length}) ===`);
  for (const v of verdicts ?? []) {
    const keys = Object.keys(v).filter((k) => /score|gate|pass|verdict|reason|critique/i.test(k));
    console.log(`  ${String(v.created_at).slice(0, 16)}  ` + keys.map((k) => `${k}=${typeof v[k] === "object" ? JSON.stringify(v[k]).slice(0, 80) : v[k]}`).join(" · "));
  }

  // ── does the reader actually return it? ──────────────────────────────────
  console.log(`\n=== listReadyToTest — does it surface? ===`);
  for (const [label, opts] of [
    ["workspace-wide, no filters", { workspaceId: WS }],
    ["cold band (Bianca's replenish path)", { workspaceId: WS, temperature: "cold" as const }],
    ["product-scoped + cold", { workspaceId: WS, productId: c.product_id as string, temperature: "cold" as const }],
  ] as const) {
    try {
      const res = await listReadyToTest(admin, opts as never);
      const rows = (Array.isArray(res) ? res : (res as { readyToTest?: unknown[] }).readyToTest ?? []) as Array<{ ad_campaign_id: string }>;
      const hit = rows.find((r) => r.ad_campaign_id === ID);
      console.log(`  ${ok(!!hit)} ${label.padEnd(38)} ${rows.length} rows total${hit ? " — THIS AD PRESENT" : " — this ad ABSENT"}`);
    } catch (e) {
      console.log(`  ⚠ ${label}: ${e instanceof Error ? e.message : JSON.stringify(e)}`);
    }
  }

  // ── the cohort that would post it ────────────────────────────────────────
  console.log(`\n=== cohort for product ${c.product_id} ===`);
  const { data: cohorts } = await admin.from("media_buyer_test_cohorts")
    .select("*").eq("workspace_id", WS);
  for (const co of cohorts ?? []) {
    const mine = co.product_id === c.product_id;
    if (!mine) continue;
    console.log("  FULL COHORT ROW:");
    for (const [k, v] of Object.entries(co)) {
      if (v === null) continue;
      console.log(`    ${k.padEnd(34)} ${typeof v === "object" ? JSON.stringify(v).slice(0, 200) : String(v)}`);
    }
  }
}
main().then(() => process.exit(0)).catch((e) => {
  console.error(e instanceof Error ? e.message : JSON.stringify(e));
  process.exit(1);
});
