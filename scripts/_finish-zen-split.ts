import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { getMetaUserToken, updateObjectStatus } from "../src/lib/meta-ads";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const NEW_CAMP = "120249298361370682";
const SHARED_CAMP = "120249256874270682";
const ZEN_COHORT = "a2c760ca-a16a-42bb-8622-c9a9aa047d13";
const ZEN_ORIGINALS = ["120249262237450682","120249262236550682","120249262235100682","120249256883430682"];
const GRAPH = "https://graph.facebook.com/v21.0";

async function graphGet(path: string, params: Record<string,string>, token: string): Promise<any> {
  const u = new URL(`${GRAPH}/${path}`);
  for (const [k,v] of Object.entries(params)) u.searchParams.append(k,v);
  u.searchParams.append("access_token", token);
  const r = await fetch(u); const j = await r.json();
  if (!r.ok || j.error) throw new Error(`GET ${path}: ${JSON.stringify(j.error??j)}`);
  return j;
}

async function main() {
  const admin = createAdminClient();
  const token = await getMetaUserToken(WS);
  if (!token) throw new Error("no token");

  // VERIFY (unfiltered): the new campaign's adsets across ALL statuses.
  const nc = await graphGet(`${NEW_CAMP}/adsets`, { fields: "id,name,status,effective_status", limit: "50" }, token);
  const copies = (nc.data ?? []) as any[];
  console.log(`new campaign ${NEW_CAMP}: ${copies.length} adsets`);
  for (const a of copies) console.log(`   ${a.id} [${a.status}/${a.effective_status}] ${a.name}`);
  if (copies.length !== 4) throw new Error(`ABORT: expected 4 copies, got ${copies.length}. Not switching. Investigate/clean up campaign ${NEW_CAMP}.`);

  // GO LIVE: activate new campaign, then pause the 4 originals.
  await updateObjectStatus(token, NEW_CAMP, "ACTIVE");
  console.log(`\nactivated new campaign ${NEW_CAMP}`);
  for (const id of ZEN_ORIGINALS) { await updateObjectStatus(token, id, "PAUSED"); console.log(`paused original ${id}`); }

  // REMAP cohort.
  const { error } = await admin.from("media_buyer_test_cohorts")
    .update({ test_meta_campaign_id: NEW_CAMP, updated_at: new Date().toISOString() }).eq("id", ZEN_COHORT);
  if (error) throw new Error(`cohort remap failed: ${error.message}`);
  console.log(`remapped Zen Relax cohort → ${NEW_CAMP}`);

  // SUMMARY: shared campaign should now have 4 ACTIVE (Guru only); new should have 4 ACTIVE.
  const sh = await graphGet(`${SHARED_CAMP}/adsets`, { fields: "id,name,effective_status", limit: "50" }, token);
  const shActive = (sh.data??[]).filter((a:any)=>a.effective_status==="ACTIVE");
  const ncNow = await graphGet(`${NEW_CAMP}/adsets`, { fields: "id,name,effective_status", limit: "50" }, token);
  const ncActive = (ncNow.data??[]).filter((a:any)=>a.effective_status==="ACTIVE");
  console.log(`\n✅ shared/Guru campaign: ${shActive.length} ACTIVE (expect 4 Guru Focus)`);
  for (const a of shActive) console.log(`     ${a.name}`);
  console.log(`✅ new Zen campaign: ${ncActive.length} ACTIVE (expect 4 Zen Relax)`);
  for (const a of ncActive) console.log(`     ${a.name}`);
}
main().then(()=>process.exit(0)).catch(e=>{console.error("ERROR:",String(e).slice(0,500));process.exit(1);});
