import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "@/lib/supabase/admin";
import { inngest } from "@/lib/inngest/client";
import { getMetaUserToken } from "@/lib/meta-ads";
import { execSync } from "child_process";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const TEST_CAMPAIGN = "120250066504550326"; // Superfood Tabs test campaign
const FIX_GREP = "bianca-static-publish-uses-all-5-copy-variations-and-correct-right-column-placement";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ts = () => new Date().toISOString().slice(11, 19);

function fixOnBox(boxSha: string): boolean {
  try {
    execSync("git fetch origin main -q", { cwd: process.cwd() });
    const sha = execSync(`git log origin/main --grep="${FIX_GREP}" --oneline -1`, { cwd: process.cwd() }).toString().trim().split(" ")[0];
    if (!sha) return false;
    execSync(`git merge-base --is-ancestor ${sha} ${boxSha}`, { cwd: process.cwd(), stdio: "ignore" });
    return true;
  } catch { return false; }
}

async function metaAdsetSnapshot(token: string): Promise<Set<string>> {
  const r = await fetch(`https://graph.facebook.com/v21.0/${TEST_CAMPAIGN}/adsets?fields=id&limit=50&access_token=${encodeURIComponent(token)}`);
  const j = await r.json();
  return new Set((j.data || []).map((s: any) => s.id));
}

async function main() {
  const a = createAdminClient();
  const token = await getMetaUserToken(WS);
  if (!token) { console.log("no meta token — abort"); return; }

  // Phase A: wait for the publish-fix on the box
  let landed = false;
  for (let i = 0; i < 150; i++) { // ~5h
    const { data: hb } = await a.from("worker_heartbeats").select("running_sha").order("updated_at", { ascending: false }).limit(1);
    const boxSha = (((hb as any)?.[0]?.running_sha) ?? "").replace(/[^0-9a-f]/gi, "").slice(0, 40);
    if (boxSha && fixOnBox(boxSha)) { console.log(`[${ts()}] publish-fix live on box (${boxSha.slice(0, 9)}) — firing Bianca`); landed = true; break; }
    if (i % 5 === 0) console.log(`[${ts()}] waiting for publish-fix to land on box…`);
    await sleep(120000);
  }
  if (!landed) { console.log("\n════════ ABORT — publish-fix never landed on box in window ════════"); return; }

  // Phase B: snapshot Meta adsets, fire Bianca
  const before = await metaAdsetSnapshot(token);
  await inngest.send({ name: "growth/media-buyer-cadence-sweep", data: { workspace_id: WS, trigger: "manual-ceo-postfix" } });
  console.log(`[${ts()}] fired Bianca (had ${before.size} adsets before) — watching Meta for new live ads…`);

  // Phase C: poll Meta for NEW adsets + whether their ad went live with the correct creative
  for (let i = 0; i < 30; i++) {
    await sleep(60000);
    const r = await fetch(`https://graph.facebook.com/v21.0/${TEST_CAMPAIGN}/adsets?fields=id,name,effective_status,ads.limit(2){id,effective_status,creative{asset_feed_spec{titles,bodies,images}}}&limit=50&access_token=${encodeURIComponent(token)}`);
    const j = await r.json();
    const news = (j.data || []).filter((s: any) => !before.has(s.id));
    if (news.length) {
      console.log(`\n════════ BIANCA PUBLISHED ${news.length} NEW AD SET(S) ════════`);
      for (const s of news) {
        const ad = s.ads?.data?.[0];
        const afs = ad?.creative?.asset_feed_spec;
        const shape = afs ? `titles=${afs.titles?.length} bodies=${afs.bodies?.length} images=${afs.images?.length}` : "no asset_feed_spec";
        console.log(`  "${(s.name || "").slice(0, 46)}" — ${s.ads?.data?.length ? `ad ${ad.effective_status} [${shape}]` : "⚠️ EMPTY (ad failed to upload)"}`);
      }
      console.log("════════ END ════════");
      return;
    }
    if (i % 4 === 0) console.log(`[${ts()}] waiting for Bianca's publish to appear on Meta…`);
  }
  console.log("\n════════ no new ad sets on Meta within window — check Bianca / slots ════════");
}
main().then(() => process.exit(0)).catch((e) => { console.error("threw:", e instanceof Error ? e.message : String(e)); process.exit(1); });
