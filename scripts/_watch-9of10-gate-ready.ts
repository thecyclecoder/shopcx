import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "@/lib/supabase/admin";
import { execSync } from "child_process";

// Watch for the 9/10 gate + CEO override to be BOTH merged and live on the box.
// NOTIFY ONLY — never touches the ad-creative kill switch. Dylan gives the explicit go-live.
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ts = () => new Date().toISOString().slice(11, 19);

function commitOnBox(searchStr: string, boxSha: string): string | null {
  try {
    execSync("git fetch origin main -q", { cwd: process.cwd() });
    const sha = execSync(`git log -S ${JSON.stringify(searchStr)} origin/main --oneline -1`, { cwd: process.cwd() })
      .toString().trim().split(" ")[0];
    if (!sha) return null; // not merged yet
    execSync(`git merge-base --is-ancestor ${sha} ${boxSha}`, { cwd: process.cwd(), stdio: "ignore" });
    return sha; // on box
  } catch { return null; }
}

async function main() {
  const a = createAdminClient();
  for (let i = 0; i < 120; i++) { // ~4h @ 2min
    const { data: hb } = await a.from("worker_heartbeats").select("running_sha").order("updated_at", { ascending: false }).limit(1);
    const boxSha = (((hb as any)?.[0]?.running_sha) ?? "").replace(/[^0-9a-f]/gi, "").slice(0, 40);
    if (boxSha) {
      const floor = commitOnBox("MAX_QC_ELIGIBILITY_FLOOR = 9", boxSha);      // Phase 1: 9/10 floor
      const override = commitOnBox("override_postable", boxSha)               // Phase 2: CEO override
        ?? commitOnBox("setPostabilityOverride", boxSha);
      if (floor && override) {
        console.log(`\n════════ 9/10 GATE + OVERRIDE ARE LIVE ON THE BOX (${boxSha.slice(0, 9)}) ════════`);
        console.log("Bianca now auto-posts only at Max 9/10; CEO manual override is available on the ad detail page.");
        console.log("READY FOR DYLAN'S GO-LIVE DECISION — the ad-creative freeze is still IN PLACE (not touched).");
        console.log("On his 'go live', lift it by deleting the kill_switches row node_id='ad-creative'.");
        return;
      }
      if (i % 5 === 0) console.log(`[${ts()}] box ${boxSha.slice(0, 9)} — floor9=${floor ? "on" : "pending"} override=${override ? "on" : "pending"}`);
    }
    await sleep(120000);
  }
  console.log("\n════════ TIMED OUT — 9/10 gate not fully on box within the window; re-check the spec build. ════════");
}
main().catch((e) => { console.error("watcher threw:", e instanceof Error ? e.message : String(e)); process.exit(1); });
