import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { getMetaUserToken, createCampaign, updateObjectStatus, listAdSets } from "../src/lib/meta-ads";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const ASH_ACCT = "2395577783853111";
const SHARED_CAMP = "120249256874270682";
const ZEN_COHORT = "a2c760ca-a16a-42bb-8622-c9a9aa047d13";
const GRAPH = "https://graph.facebook.com/v21.0";
const ZEN_ADSETS: [string, string][] = [
  ["120249262237450682", "Dahlia · Ashwavana Zen Relax · packshot"],
  ["120249262236550682", "Dahlia · Ashwavana Zen Relax · claim"],
  ["120249262235100682", "Dahlia · Ashwavana Zen Relax · mood"],
  ["120249256883430682", "Dahlia · Ashwavana Zen Relax · sleep"],
];

async function graphPost(path: string, body: Record<string, unknown>, token: string): Promise<any> {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(body)) p.append(k, typeof v === "object" ? JSON.stringify(v) : String(v));
  p.append("access_token", token);
  const r = await fetch(`${GRAPH}/${path}`, { method: "POST", body: p });
  const j = await r.json();
  if (!r.ok || j.error) throw new Error(`POST ${path}: ${JSON.stringify(j.error ?? j)}`);
  return j;
}

async function main() {
  const admin = createAdminClient();
  const token = await getMetaUserToken(WS);
  if (!token) throw new Error("no token");

  // 1) new campaign, PAUSED (empty → no spend; copies gated by campaign pause).
  const newCamp = await createCampaign(token, ASH_ACCT, {
    name: "MB — Ashwavana Zen Relax Testing (ABO) | media-buyer loop",
    abo: true, objective: "OUTCOME_SALES", status: "PAUSED",
  } as any);
  console.log(`[1] created campaign ${newCamp} (PAUSED)`);

  // 2) deep-copy each Zen adset (ads included), ACTIVE — but campaign is paused so nothing delivers yet.
  const newAdsetIds: string[] = [];
  for (const [adsetId, name] of ZEN_ADSETS) {
    const res = await graphPost(`${adsetId}/copies`, { campaign_id: newCamp, deep_copy: true, status_option: "ACTIVE" }, token);
    const newId = res.copied_adset_id ?? res.id ?? res.ad_object_ids?.[0];
    if (!newId) throw new Error(`copy of ${adsetId} returned no id: ${JSON.stringify(res)}`);
    await graphPost(`${newId}`, { name }, token); // strip the " - Copy" suffix
    newAdsetIds.push(String(newId));
    console.log(`[2] copied ${adsetId} → ${newId}  (${name})`);
  }

  // 3) VERIFY: exactly 4 adsets now live under the new campaign.
  const check = await listAdSets(token, ASH_ACCT, newCamp);
  console.log(`[3] verify: new campaign has ${check.length} adsets: ${check.map((a) => a.id).join(", ")}`);
  if (check.length !== 4) throw new Error(`ABORT before switch: expected 4 copies, got ${check.length}. Originals untouched, still running.`);

  // 4) go live: activate the new campaign, then pause the 4 originals (seconds of overlap, no gap).
  await updateObjectStatus(token, newCamp, "ACTIVE");
  console.log(`[4a] activated new campaign ${newCamp}`);
  for (const [adsetId] of ZEN_ADSETS) {
    await updateObjectStatus(token, adsetId, "PAUSED");
    console.log(`[4b] paused original ${adsetId}`);
  }

  // 5) remap the Zen Relax cohort → new campaign.
  const { error } = await admin.from("media_buyer_test_cohorts")
    .update({ test_meta_campaign_id: newCamp, updated_at: new Date().toISOString() })
    .eq("id", ZEN_COHORT);
  if (error) throw new Error(`cohort remap failed: ${error.message}`);
  console.log(`[5] remapped Zen Relax cohort ${ZEN_COHORT} → ${newCamp}`);

  // summary
  const shared = await listAdSets(token, ASH_ACCT, SHARED_CAMP);
  const sharedActive = shared.filter((a) => a.status === "ACTIVE");
  console.log(`\n✅ DONE`);
  console.log(`  new Zen campaign ${newCamp}: ${check.length} adsets (now live)`);
  console.log(`  shared/Guru campaign ${SHARED_CAMP}: ${sharedActive.length} ACTIVE adsets remaining (expect 4 Guru Focus)`);
  for (const a of sharedActive) console.log(`     ${a.id} ${a.name}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error("ERROR:", String(e).slice(0, 500)); process.exit(1); });
