import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "@/lib/supabase/admin";
import { execSync } from "child_process";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const TABS = "221d272d-a6c5-4a5d-86ff-ac693926c992";
const FIX_GREP = "swap-competitor-offer-slot-for-our-grounded-proof-benefit-or-feature-in-debrand";
const TERMINAL = ["completed", "failed", "cancelled", "needs_input", "needs_attention"];
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

async function main() {
  const a = createAdminClient();
  let landed = false;
  for (let i = 0; i < 120; i++) {
    const { data: hb } = await a.from("worker_heartbeats").select("running_sha").order("updated_at", { ascending: false }).limit(1);
    const boxSha = (((hb as any)?.[0]?.running_sha) ?? "").replace(/[^0-9a-f]/gi, "").slice(0, 40);
    if (boxSha && fixOnBox(boxSha)) { console.log(`[${ts()}] offer-swap fix live on box (${boxSha.slice(0, 9)}) — re-running Superfood Tabs`); landed = true; break; }
    if (i % 5 === 0) console.log(`[${ts()}] waiting for offer-swap fix on box…`);
    await sleep(120000);
  }
  if (!landed) { console.log("\n════════ ABORT — offer-swap fix never landed on box in window ════════"); return; }

  // one-at-a-time
  for (let i = 0; i < 30; i++) {
    const { data } = await a.from("agent_jobs").select("id").eq("workspace_id", WS)
      .eq("kind", "ad-creative-copy-author").in("status", ["queued", "queued_resume", "claimed", "building"]);
    if (!(data ?? []).length) break;
    await sleep(60000);
  }
  const enqAt = new Date().toISOString();
  const { data: job } = await a.from("agent_jobs").insert({
    workspace_id: WS, kind: "ad-creative-copy-author", status: "queued",
    spec_slug: `ad-creative-copy-author:${TABS}`, instructions: JSON.stringify({ product_id: TABS, count: 1 }),
  }).select("id").single();
  const jobId = (job as any).id as string;
  console.log(`[${ts()}] Superfood Tabs (attempt 3): ENQUEUED ${jobId.slice(0, 8)}`);

  let status = "queued", logTail = "";
  for (let i = 0; i < 60; i++) {
    await sleep(90000);
    const { data } = await a.from("agent_jobs").select("status,log_tail").eq("id", jobId).maybeSingle();
    status = (data as any)?.status ?? status; logTail = (data as any)?.log_tail ?? logTail;
    if (TERMINAL.includes(status)) break;
  }
  console.log(`\n════════ Superfood Tabs — ${jobId.slice(0, 8)} status=${status} ════════`);
  console.log("log:", (logTail || "(none)").slice(0, 240));
  const { data: camps } = await a.from("ad_campaigns").select("id,status,angle_id,concept_tag,created_at")
    .eq("workspace_id", WS).eq("product_id", TABS).gte("created_at", enqAt).order("created_at", { ascending: false }).limit(1);
  const c = (camps as any)?.[0];
  if (!c) { console.log("STILL NO campaign — check the log reason above (which gate blocked it this time)."); console.log("════════ END ════════"); return; }
  console.log(`✅ CAMPAIGN PRODUCED — ${c.id.slice(0, 8)} status=${c.status} concept=${c.concept_tag}`);
  const { data: ang } = await a.from("product_ad_angles").select("metadata").eq("id", c.angle_id).maybeSingle();
  const cp = (ang as any)?.metadata?.copy_pack; const hs = cp?.headlines ?? [], pts = cp?.primaryTexts ?? [];
  const corpus = (hs.join(" ") + " " + pts.join(" ")).toLowerCase();
  console.log(`  TOTE/OFFER LEAK CHECK: ${/tote|free gift|free tote|bonus/.test(corpus) ? "✗ still present!" : "✓ no tote/offer"}`);
  console.log(`  SWAPPED-IN SELLING POINTS: ${["15 superfood", "superfoods", "fizz", "reduce bloat|bloat", "metabolism", "curb crav|craving", "700|700,000", "money-back|guarantee|risk-free"].filter((re) => new RegExp(re).test(corpus)).map((re) => re.split("|")[0]).join(", ") || "(none detected)"}`);
  const ci = (cp?.frameworks ?? []).indexOf("cialdini");
  if (ci >= 0) console.log(`  [cialdini sample]\n    H: ${hs[ci]}\n    PT: ${(pts[ci] ?? "").replace(/\n/g, "\\n").slice(0, 300)}`);
  const { data: v } = await a.from("ad_creative_copy_qc_verdicts").select("hard_gate_pass,persuasion_score,creative_gate_pass").eq("ad_campaign_id", c.id).order("created_at", { ascending: false }).limit(1);
  const mv = (v as any)?.[0];
  if (mv) console.log(`  MAX: hard_gate=${mv.hard_gate_pass} persuasion=${mv.persuasion_score}/10 creative_gate=${mv.creative_gate_pass ?? "n/a"} → postable(≥9)=${mv.persuasion_score >= 9 && mv.hard_gate_pass ? "YES" : "NO (held)"}`);
  console.log("════════ END ════════");
}
main().catch((e) => { console.error("watcher threw:", e instanceof Error ? e.message : String(e)); });
