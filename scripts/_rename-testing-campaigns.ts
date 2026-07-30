import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { getMetaUserToken } from "../src/lib/meta-ads";
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const GRAPH = "https://graph.facebook.com/v21.0";

async function gget(path: string, params: Record<string,string>, token: string) {
  const u = new URL(`${GRAPH}/${path}`); for (const [k,v] of Object.entries(params)) u.searchParams.append(k,v);
  u.searchParams.append("access_token", token); const r = await fetch(u); const j = await r.json();
  if (!r.ok || j.error) throw new Error(`GET ${path}: ${JSON.stringify(j.error??j)}`); return j;
}
async function gpost(path: string, body: Record<string,unknown>, token: string) {
  const p = new URLSearchParams(); for (const [k,v] of Object.entries(body)) p.append(k, typeof v==="object"?JSON.stringify(v):String(v));
  p.append("access_token", token); const r = await fetch(`${GRAPH}/${path}`, { method:"POST", body:p }); const j = await r.json();
  if (!r.ok || j.error) throw new Error(`POST ${path}: ${JSON.stringify(j.error??j)}`); return j;
}

async function main() {
  const admin = createAdminClient();
  const token = await getMetaUserToken(WS);
  if (!token) throw new Error("no token");

  const { data: cohorts } = await admin.from("media_buyer_test_cohorts")
    .select("product_id, test_meta_campaign_id, meta_ad_account_id").eq("workspace_id", WS).eq("is_active", true);
  const { data: prods } = await admin.from("products").select("id, title").eq("workspace_id", WS);
  const { data: accts } = await admin.from("meta_ad_accounts").select("id, meta_account_name").eq("workspace_id", WS);
  const pTitle = new Map((prods??[]).map((p:any)=>[p.id,p.title]));
  const aName = new Map((accts??[]).map((a:any)=>[a.id,a.meta_account_name]));

  const targets = (cohorts??[]).filter((c:any)=>c.product_id && c.test_meta_campaign_id);
  console.log(`Renaming ${targets.length} testing campaigns:\n`);
  for (const c of targets as any[]) {
    const title = pTitle.get(c.product_id) ?? c.product_id;
    const camp = c.test_meta_campaign_id;
    const cur = await gget(`${camp}`, { fields: "name" }, token);
    const newName = `MB — ${title} Testing (ABO)`;
    if (cur.name === newName) { console.log(`= [${aName.get(c.meta_ad_account_id)}] ${camp}\n    already: "${cur.name}"\n`); continue; }
    await gpost(`${camp}`, { name: newName }, token);
    console.log(`✎ [${aName.get(c.meta_ad_account_id)}] ${camp}\n    was: "${cur.name}"\n    now: "${newName}"\n`);
  }
}
main().then(()=>process.exit(0)).catch(e=>{console.error("ERROR:",String(e).slice(0,400));process.exit(1);});
