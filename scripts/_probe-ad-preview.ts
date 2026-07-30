import { createAdminClient } from "./_bootstrap";
import { getMetaUserToken } from "../src/lib/meta-ads";
const V = "v21.0";
(async () => {
  const admin = createAdminClient();
  const { data: ws } = await admin.from("workspaces").select("id,name").limit(20);
  let token: string | null = null;
  for (const w of ws ?? []) { token = await getMetaUserToken(w.id); if (token) break; }
  if (!token) throw new Error("no token");
  const g = async (p: string, q: Record<string,string> = {}) => {
    const u = new URL(`https://graph.facebook.com/${V}/${p}`);
    for (const [k,v] of Object.entries(q)) u.searchParams.set(k,v);
    u.searchParams.set("access_token", token!);
    const r = await fetch(u); return r.json();
  };
  const ads = await g("act_196487894712827/ads", { fields: "id,name,effective_status", limit: "100" });
  const active = (ads.data ?? []).filter((x: any) => x.effective_status === "ACTIVE");
  for (const ad of active) {
    console.log(`\n=== ${ad.name} (${ad.id}) ===`);
    const pv = await g(`${ad.id}/previews`, { ad_format: "MOBILE_FEED_STANDARD" });
    const body = pv.data?.[0]?.body ?? "";
    const m = body.match(/src="([^"]+)"/);
    if (!m) { console.log("  no preview iframe", JSON.stringify(pv).slice(0,200)); continue; }
    const url = m[1].replace(/&amp;/g, "&");
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)" } });
    const html = await r.text();
    const hits = ["shop_now","View shop","Shop now","shops","commerce","product_catalog","onsite","checkout_on_facebook","instagram.com/shop","fb.com/shop"];
    console.log(`  preview ${r.status}, ${html.length}B`);
    for (const h of hits) if (html.toLowerCase().includes(h.toLowerCase())) console.log(`    HIT: ${h}`);
    const links = [...html.matchAll(/https?:\/\/[^"'\\ )]{10,90}/g)].map(x=>x[0])
      .filter(u=>/superfoodscompany|shop|commerce|catalog/i.test(u));
    console.log(`    links: ${JSON.stringify([...new Set(links)].slice(0,6), null, 0)}`);
  }
})();
