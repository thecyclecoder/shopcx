/**
 * READ-ONLY: fetch each test cohort's Meta campaign real created_time + status +
 * insights start, so the purchaser-overlap window is scoped to actual test lifetime
 * (tests are days-to-a-week old — a 60d window is meaningless).
 */
import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { getMetaUserToken } from "../src/lib/meta-ads";
import { metaGraphRequest } from "../src/lib/meta/api";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

async function main() {
  const admin = createAdminClient();
  const token = await getMetaUserToken(WS);
  if (!token) throw new Error("no meta user token");

  const { data: cohorts } = await admin
    .from("media_buyer_test_cohorts")
    .select("product_id, test_meta_campaign_id, meta_ad_account_id, is_active")
    .eq("workspace_id", WS);

  // product names for readability
  const pids = (cohorts || []).map((c: any) => c.product_id).filter(Boolean);
  const { data: prods } = await admin.from("products").select("id, title").in("id", pids.length ? pids : ["_"]);
  const nameOf = new Map((prods || []).map((p: any) => [p.id, p.title]));

  let minCreated: string | null = null;
  console.log("product                         | campaign_id        | created_time         | status    | active");
  for (const c of cohorts || []) {
    const cid = c.test_meta_campaign_id;
    if (!cid) { console.log(`${String(nameOf.get(c.product_id) || c.product_id).slice(0,30).padEnd(31)} | (no test_meta_campaign_id)`); continue; }
    try {
      const res: any = await metaGraphRequest(token, `/${cid}`, { fields: "id,name,created_time,start_time,effective_status,status" });
      const created = res.created_time || res.start_time || "";
      if (created && (!minCreated || created < minCreated)) minCreated = created;
      console.log(
        `${String(nameOf.get(c.product_id) || c.product_id).slice(0,30).padEnd(31)} | ${String(cid).padEnd(18)} | ${String(created).padEnd(20)} | ${String(res.effective_status||res.status||"").padEnd(9)} | ${c.is_active}`);
    } catch (e: any) {
      console.log(`${String(nameOf.get(c.product_id) || c.product_id).slice(0,30).padEnd(31)} | ${String(cid).padEnd(18)} | ERR ${e.message?.slice(0,60)}`);
    }
  }
  if (minCreated) {
    const days = Math.round((Date.now() - new Date(minCreated).getTime()) / 864e5);
    console.log(`\nEarliest test campaign created: ${minCreated}  (~${days}d ago)`);
    console.log(`→ purchaser-overlap window should start at the earliest campaign create, not 60d.`);
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
