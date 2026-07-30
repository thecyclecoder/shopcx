import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "@/lib/supabase/admin";
import { inngest } from "@/lib/inngest/client";
import { getMetaUserToken } from "@/lib/meta-ads";
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906", ZEN = "48bfa48c-b8db-42f9-9303-19c70ab8e7a1";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ts = () => new Date().toISOString().slice(11, 19);
async function snap(token: string, campaign: string): Promise<Set<string>> {
  const r = await fetch(`https://graph.facebook.com/v21.0/${campaign}/adsets?fields=id&limit=50&access_token=${encodeURIComponent(token)}`);
  const j = await r.json(); return new Set((j.data || []).map((s: any) => s.id));
}
async function main() {
  const a = createAdminClient();
  const token = await getMetaUserToken(WS); if (!token) { console.log("no token"); return; }
  const { data: coh } = await a.from("media_buyer_test_cohorts").select("test_meta_campaign_id").eq("workspace_id", WS).eq("product_id", ZEN).maybeSingle() as any;
  const CAMP = coh?.test_meta_campaign_id;
  if (!CAMP) { console.log("no Zen test campaign"); return; }
  console.log(`[${ts()}] Zen Relax test campaign=${CAMP}`);
  const before = await snap(token, CAMP);
  await inngest.send({ name: "growth/media-buyer-cadence-sweep", data: { workspace_id: WS, trigger: "manual-ceo-zen" } });
  console.log(`[${ts()}] fired Bianca (Zen campaign had ${before.size} adsets) — watching Meta…`);
  for (let i = 0; i < 30; i++) {
    await sleep(60000);
    const r = await fetch(`https://graph.facebook.com/v21.0/${CAMP}/adsets?fields=id,name,effective_status,ads.limit(2){id,effective_status,creative{asset_feed_spec{titles,bodies,images}}}&limit=50&access_token=${encodeURIComponent(token)}`);
    const j = await r.json();
    const news = (j.data || []).filter((s: any) => !before.has(s.id));
    if (news.length) {
      console.log(`\n════════ BIANCA PUBLISHED ${news.length} NEW ZEN AD SET(S) ════════`);
      for (const s of news) {
        const ad = s.ads?.data?.[0]; const afs = ad?.creative?.asset_feed_spec;
        const shape = afs ? `titles=${afs.titles?.length} bodies=${afs.bodies?.length} images=${afs.images?.length}` : "no asset_feed_spec";
        console.log(`  "${(s.name || "").slice(0, 46)}" — ${s.ads?.data?.length ? `ad ${ad.effective_status} [${shape}]` : "⚠️ EMPTY (ad failed to upload)"}`);
      }
      console.log("════════ END ════════"); return;
    }
    if (i % 4 === 0) console.log(`[${ts()}] waiting for Zen publish on Meta…`);
  }
  console.log("\n════════ no new Zen ad sets within window — check Bianca / slots ════════");
}
main().then(() => process.exit(0)).catch((e) => { console.error("threw:", e instanceof Error ? e.message : String(e)); process.exit(1); });
