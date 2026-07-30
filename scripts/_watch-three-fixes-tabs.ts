import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "@/lib/supabase/admin";
import { execSync } from "child_process";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const TABS = "221d272d-a6c5-4a5d-86ff-ac693926c992";
const FIXES = [
  { label: "parse-tolerance", grep: "max-copy-qc-verdict-parser-is-tolerant-not-fail-closed" },
  { label: "always-bin", grep: "a-max-copy-qc-miss-still-bins-the-ad-held-never-drops-it" },
  { label: "offer-for-offer", grep: "debrand-offer-swap-prefers-our-real-offer-free-shipping" },
];
const TERMINAL = ["completed", "failed", "cancelled", "needs_input", "needs_attention"];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ts = () => new Date().toISOString().slice(11, 19);

function boxHasAll(boxSha: string): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  try { execSync("git fetch origin main -q", { cwd: process.cwd() }); } catch {}
  for (const f of FIXES) {
    try {
      const sha = execSync(`git log origin/main --grep="${f.grep}" --oneline -1`, { cwd: process.cwd() }).toString().trim().split(" ")[0];
      if (!sha) { missing.push(f.label); continue; }
      execSync(`git merge-base --is-ancestor ${sha} ${boxSha}`, { cwd: process.cwd(), stdio: "ignore" });
    } catch { missing.push(f.label); }
  }
  return { ok: missing.length === 0, missing };
}

async function main() {
  const a = createAdminClient();
  let landed = false;
  for (let i = 0; i < 150; i++) { // ~5h
    const { data: hb } = await a.from("worker_heartbeats").select("running_sha").order("updated_at", { ascending: false }).limit(1);
    const boxSha = (((hb as any)?.[0]?.running_sha) ?? "").replace(/[^0-9a-f]/gi, "").slice(0, 40);
    if (boxSha) {
      const { ok, missing } = boxHasAll(boxSha);
      if (ok) { console.log(`[${ts()}] all three fixes live on box (${boxSha.slice(0, 9)}) — running Superfood Tabs`); landed = true; break; }
      if (i % 4 === 0) console.log(`[${ts()}] box ${boxSha.slice(0, 9)} waiting on: ${missing.join(", ")}`);
    }
    await sleep(120000);
  }
  if (!landed) { console.log("\n════════ ABORT — three fixes never all landed on box in window ════════"); return; }

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
  console.log(`[${ts()}] Superfood Tabs (attempt 4, all fixes live): ENQUEUED ${jobId.slice(0, 8)}`);

  let status = "queued", logTail = "";
  for (let i = 0; i < 60; i++) {
    await sleep(90000);
    const { data } = await a.from("agent_jobs").select("status,log_tail").eq("id", jobId).maybeSingle();
    status = (data as any)?.status ?? status; logTail = (data as any)?.log_tail ?? logTail;
    if (TERMINAL.includes(status)) break;
  }
  console.log(`\n════════ Superfood Tabs — ${jobId.slice(0, 8)} status=${status} ════════`);
  console.log("log:", (logTail || "(none)").slice(0, 260));
  const { data: camps } = await a.from("ad_campaigns").select("id,status,angle_id,concept_tag,created_at")
    .eq("workspace_id", WS).eq("product_id", TABS).gte("created_at", enqAt).order("created_at", { ascending: false }).limit(1);
  const c = (camps as any)?.[0];
  if (!c) { console.log("STILL NO campaign — check the log reason above."); console.log("════════ END ════════"); return; }
  console.log(`✅ CAMPAIGN PRODUCED — ${c.id.slice(0, 8)} status=${c.status} concept=${c.concept_tag}`);
  const { data: ang } = await a.from("product_ad_angles").select("metadata").eq("id", c.angle_id).maybeSingle();
  const cp = (ang as any)?.metadata?.copy_pack; const hs = cp?.headlines ?? [], pts = cp?.primaryTexts ?? [];
  const corpus = (hs.join(" ") + " " + pts.join(" ")).toLowerCase();
  console.log(`  TOTE LEAK: ${/free tote|tote|free gift/.test(corpus) ? "✗ present" : "✓ gone"}  |  OFFER SWAP: ${/free shipping|subscribe.*save|subscribe & save/.test(corpus) ? "✓ free-shipping+S&S present" : "(no free-shipping offer detected — check what it swapped to)"}`);
  const ci = (cp?.frameworks ?? []).indexOf("cialdini");
  if (ci >= 0) console.log(`  [cialdini sample]\n    H: ${hs[ci]}\n    PT: ${(pts[ci] ?? "").replace(/\n/g, "\\n").slice(0, 320)}`);
  const { data: v } = await a.from("ad_creative_copy_qc_verdicts").select("hard_gate_pass,persuasion_score,creative_gate_pass,verdict_reason").eq("ad_campaign_id", c.id).order("created_at", { ascending: false }).limit(1);
  const mv = (v as any)?.[0];
  if (mv) console.log(`  MAX: hard_gate=${mv.hard_gate_pass} persuasion=${mv.persuasion_score}/10 creative_gate=${mv.creative_gate_pass ?? "n/a"} → postable(≥9)=${mv.persuasion_score >= 9 && mv.hard_gate_pass ? "YES" : "NO (held)"}\n       reason: ${(mv.verdict_reason || "").slice(0, 180)}`);
  console.log("════════ END ════════");
}
main().catch((e) => { console.error("watcher threw:", e instanceof Error ? e.message : String(e)); });
