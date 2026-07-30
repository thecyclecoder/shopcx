import { createAdminClient } from "./_bootstrap";
import { getMetaUserToken } from "../src/lib/meta-ads";
const V = "v21.0";
(async () => {
  const admin = createAdminClient();
  const { data: ws } = await admin.from("workspaces").select("id,name").limit(20);
  let token: string | null = null;
  for (const w of ws ?? []) { token = await getMetaUserToken(w.id); if (token) break; }
  const g = async (p: string, q: Record<string,string> = {}) => {
    const u = new URL(`https://graph.facebook.com/${V}/${p}`);
    for (const [k,v] of Object.entries(q)) u.searchParams.set(k,v);
    u.searchParams.set("access_token", token!);
    return (await fetch(u)).json();
  };
  for (const acct of [["Superfood Tabs","act_196487894712827"],["Ashwavana","act_2395577783853111"]]) {
    console.log(`\n########## ${acct[0]} ##########`);
    let url: any = await g(`${acct[1]}/adsets`, { fields: "id,name,destination_type,created_time", limit: "200" });
    const rows: any[] = [];
    for (const s of url.data ?? []) {
      const ins = await g(`${s.id}/insights`, { fields: "spend,inline_link_clicks,actions", date_preset: "maximum" });
      const r = (ins.data ?? [])[0]; if (!r) continue;
      const lc = Number(r.inline_link_clicks ?? 0); if (lc < 25) continue;
      const lpv = Number((r.actions ?? []).find((x: any) => x.action_type === "landing_page_view")?.value ?? 0);
      rows.push({ dest: s.destination_type, created: (s.created_time||"").slice(0,7), lc, lpv, rate: lpv/lc*100, spend: Number(r.spend), name: s.name.slice(0,42) });
    }
    rows.sort((a,b)=> a.created.localeCompare(b.created));
    console.log(`created  destination  ${"LPV%".padStart(6)} ${"clicks".padStart(7)} ${"spend".padStart(10)}  name`);
    for (const r of rows) console.log(`${r.created.padEnd(8)} ${String(r.dest).padEnd(12)} ${r.rate.toFixed(1).padStart(5)}% ${String(r.lc).padStart(7)} ${("$"+r.spend.toFixed(0)).padStart(10)}  ${r.name}`);
    // group
    const by: Record<string, {lc:number;lpv:number;n:number}> = {};
    for (const r of rows) { const k=String(r.dest); by[k] ??= {lc:0,lpv:0,n:0}; by[k].lc+=r.lc; by[k].lpv+=r.lpv; by[k].n++; }
    console.log("  --- weighted by destination_type ---");
    for (const [k,v] of Object.entries(by)) console.log(`    ${k.padEnd(12)} n=${String(v.n).padStart(3)} adsets  LPV/LC=${(v.lpv/v.lc*100).toFixed(1)}%  (${v.lc} clicks)`);
  }
})();
