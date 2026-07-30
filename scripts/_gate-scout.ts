import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "@/lib/supabase/admin";
import { inngest } from "@/lib/inngest/client";
import { execSync } from "child_process";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906", CREAMER = "61a4490e-cb2a-4f65-9613-faab40f0b153";
const FIX_GREP = "creative-scout-reliably-ingests-every-approved-competitor-no-drops-no-leaks";
const MAPPED = ["Obvi Health", "Obvi", "NativePath", "Vital Proteins", "SkinnyFit", "Ancient Nutrition"];
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
async function advBreakdown(a: ReturnType<typeof createAdminClient>) {
  const { data } = await a.from("creative_skeletons").select("advertiser").eq("product_id", CREAMER) as any;
  const advs: Record<string, number> = {};
  for (const s of (data || [])) advs[s.advertiser || "?"] = (advs[s.advertiser || "?"] || 0) + 1;
  return { total: (data || []).length, advs };
}
async function main() {
  const a = createAdminClient();
  let landed = false;
  for (let i = 0; i < 150; i++) {
    const { data: hb } = await a.from("worker_heartbeats").select("running_sha").order("updated_at", { ascending: false }).limit(1);
    const boxSha = (((hb as any)?.[0]?.running_sha) ?? "").replace(/[^0-9a-f]/gi, "").slice(0, 40);
    if (boxSha && fixOnBox(boxSha)) { console.log(`[${ts()}] scout-fix live on box (${boxSha.slice(0, 9)}) — firing the scout for Creamer`); landed = true; break; }
    if (i % 5 === 0) console.log(`[${ts()}] waiting for scout-fix to land on box…`);
    await sleep(120000);
  }
  if (!landed) { console.log("\n════════ ABORT — scout-fix never landed on box ════════"); return; }

  const before = await advBreakdown(a);
  console.log(`BEFORE: ${before.total} skeletons — ${JSON.stringify(before.advs)}`);
  await inngest.send({ name: "ads/creative-scout.sweep", data: { workspaceId: WS, productId: CREAMER, force: true } });
  console.log(`[${ts()}] fired scout (Creamer, force) — watching ingestion…`);
  for (let i = 0; i < 20; i++) {
    await sleep(45000);
    const now = await advBreakdown(a);
    const gotObvi = now.advs["Obvi Health"] || now.advs["Obvi"];
    const gotNative = now.advs["NativePath"];
    const gotVital = now.advs["Vital Proteins"];
    if (gotObvi || now.total > before.total) {
      console.log(`\n════════ SCOUT INGESTED — ${now.total} skeletons ════════`);
      console.log(`  ${JSON.stringify(now.advs)}`);
      console.log(`  Obvi=${gotObvi ? "✓ " + gotObvi : "✗ still 0"}  NativePath=${gotNative ? "✓ " + gotNative : "✗ 0"}  VitalProteins=${gotVital ? "✓ " + gotVital : "✗ 0"}`);
      const leaks = Object.keys(now.advs).filter((adv) => !MAPPED.some((m) => adv.includes(m) || m.includes(adv)) && adv !== "?");
      console.log(`  non-mapped leakage: ${leaks.length ? leaks.join(", ") : "none ✓"}`);
      console.log("════════ END ════════"); return;
    }
    if (i % 3 === 0) console.log(`[${ts()}] ${now.total} skeletons, still no Obvi…`);
  }
  console.log("\n════════ scout fired but Obvi still 0 after window — fix may need another pass ════════");
}
main().then(() => process.exit(0)).catch((e) => { console.error("threw:", e instanceof Error ? e.message : String(e)); process.exit(1); });
