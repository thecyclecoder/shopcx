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
  // ONLY the new code-created test ad sets
  const SINCE = "2026-06-01";
  for (const [label, acct] of [["Superfood Tabs","act_196487894712827"],["Ashwavana","act_2395577783853111"]]) {
    const sets = await g(`${acct}/adsets`, { fields: "id,name,created_time", limit: "200" });
    const ids = (sets.data ?? []).filter((s: any) => (s.created_time ?? "") >= SINCE).map((s: any) => s.id);
    console.log(`\n########## ${label} — ${ids.length} code-created ad sets, by placement (maximum) ##########`);
    const agg: Record<string, any> = {};
    for (const id of ids) {
      const ins = await g(`${id}/insights`, {
        fields: "spend,inline_link_clicks,actions,action_values",
        date_preset: "maximum", breakdowns: "publisher_platform,platform_position",
      });
      for (const r of ins.data ?? []) {
        const k = `${r.publisher_platform}/${r.platform_position}`;
        agg[k] ??= { spend:0, lc:0, lpv:0, atc:0, pur:0, rev:0 };
        const a = agg[k];
        a.spend += Number(r.spend ?? 0);
        a.lc  += Number(r.inline_link_clicks ?? 0);
        const act = (t: string) => Number((r.actions ?? []).find((x: any) => x.action_type === t)?.value ?? 0);
        a.lpv += act("landing_page_view"); a.atc += act("add_to_cart");
        a.pur += act("offsite_conversion.fb_pixel_purchase");
        a.rev += Number((r.action_values ?? []).find((x: any) => x.action_type === "offsite_conversion.fb_pixel_purchase")?.value ?? 0);
      }
    }
    const rows = Object.entries(agg).map(([k,v]: any) => ({ k, ...v })).sort((a,b)=>b.spend-a.spend);
    console.log(`${"placement".padEnd(36)} ${"spend".padStart(8)} ${"clicks".padStart(7)} ${"LPV%".padStart(6)} ${"ATC".padStart(4)} ${"PUR".padStart(4)} ${"revenue".padStart(9)} ${"ROAS".padStart(6)}`);
    let T = { spend:0, lc:0, lpv:0, atc:0, pur:0, rev:0 };
    for (const r of rows) {
      for (const m of ["spend","lc","lpv","atc","pur","rev"] as const) (T as any)[m] += r[m];
      console.log(`${r.k.padEnd(36)} ${("$"+r.spend.toFixed(0)).padStart(8)} ${String(r.lc).padStart(7)} ${(r.lc? (r.lpv/r.lc*100).toFixed(1):"-").padStart(5)}% ${String(r.atc).padStart(4)} ${String(r.pur).padStart(4)} ${("$"+r.rev.toFixed(0)).padStart(9)} ${(r.spend? (r.rev/r.spend).toFixed(2):"-").padStart(6)}`);
    }
    console.log(`${"TOTAL".padEnd(36)} ${("$"+T.spend.toFixed(0)).padStart(8)} ${String(T.lc).padStart(7)} ${(T.lpv/T.lc*100).toFixed(1).padStart(5)}% ${String(T.atc).padStart(4)} ${String(T.pur).padStart(4)} ${("$"+T.rev.toFixed(0)).padStart(9)} ${(T.rev/T.spend).toFixed(2).padStart(6)}`);
    const an = rows.filter(r=>r.k.startsWith("audience_network"));
    const anS = an.reduce((s,r)=>s+r.spend,0), anP = an.reduce((s,r)=>s+r.pur,0), anC = an.reduce((s,r)=>s+r.lc,0), anR = an.reduce((s,r)=>s+r.rev,0);
    console.log(`\n  AUDIENCE NETWORK: $${anS.toFixed(0)} spend (${(anS/T.spend*100).toFixed(0)}% of budget) · ${anC} clicks (${(anC/T.lc*100).toFixed(0)}% of all clicks) · ${anP} purchases · $${anR.toFixed(0)} revenue`);
    console.log(`  WITHOUT AN:       $${(T.spend-anS).toFixed(0)} spend · LPV rate ${((T.lpv-an.reduce((s,r)=>s+r.lpv,0))/(T.lc-anC)*100).toFixed(1)}% · ${T.pur-anP} purchases · ROAS ${((T.rev-anR)/(T.spend-anS)).toFixed(2)}`);
  }
})();
