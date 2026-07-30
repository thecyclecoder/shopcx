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
  for (const [label, acct] of [["Superfood Tabs","act_196487894712827"],["Ashwavana","act_2395577783853111"]]) {
    console.log(`\n########## ${label} — NEW ads (last_30d) by placement ##########`);
    const ins = await g(`${acct}/insights`, {
      fields: "spend,impressions,inline_link_clicks,actions",
      level: "account", date_preset: "last_30d",
      breakdowns: "publisher_platform,platform_position",
    });
    const rows = (ins.data ?? []).map((r: any) => {
      const lc = Number(r.inline_link_clicks ?? 0);
      const lpv = Number((r.actions ?? []).find((x: any) => x.action_type === "landing_page_view")?.value ?? 0);
      return { plat: r.publisher_platform, pos: r.platform_position, spend: Number(r.spend), lc, lpv, rate: lc ? lpv/lc*100 : 0 };
    }).filter((r: any) => r.lc > 0).sort((a: any,b: any) => b.spend - a.spend);
    console.log(`${"platform".padEnd(18)} ${"position".padEnd(22)} ${"spend".padStart(9)} ${"clicks".padStart(7)} ${"LPV".padStart(6)} ${"LPV%".padStart(6)}`);
    let ts=0, tl=0, tp=0;
    for (const r of rows) {
      console.log(`${String(r.plat).padEnd(18)} ${String(r.pos).padEnd(22)} ${("$"+r.spend.toFixed(0)).padStart(9)} ${String(r.lc).padStart(7)} ${String(r.lpv).padStart(6)} ${r.rate.toFixed(1).padStart(5)}%`);
      ts+=r.spend; tl+=r.lc; tp+=r.lpv;
    }
    if (tl) console.log(`${"TOTAL".padEnd(41)} ${("$"+ts.toFixed(0)).padStart(9)} ${String(tl).padStart(7)} ${String(tp).padStart(6)} ${(tp/tl*100).toFixed(1).padStart(5)}%`);
  }
})();
