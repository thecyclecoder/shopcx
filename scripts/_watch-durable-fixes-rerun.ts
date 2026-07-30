import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "@/lib/supabase/admin";
import { execSync } from "child_process";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const PRODUCTS = [
  { id: "48bfa48c-b8db-42f9-9303-19c70ab8e7a1", name: "Ashwavana Zen Relax", prevFail: "meta_caps" },
  { id: "221d272d-a6c5-4a5d-86ff-ac693926c992", name: "Superfood Tabs", prevFail: "firewall leadProof" },
];
const FIXES = [
  { label: "long-form caps", grep: "reconcile-long-form-3-paragraph-primary-text-with-meta-primary-text-cap" },
  { label: "firewall recovery", grep: "dahlia-recovers-from-firewall-claim-miss-actionable-revise-reason" },
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
      if (!sha) { missing.push(`${f.label}(not merged)`); continue; }
      execSync(`git merge-base --is-ancestor ${sha} ${boxSha}`, { cwd: process.cwd(), stdio: "ignore" });
    } catch { missing.push(`${f.label}(not on box)`); }
  }
  return { ok: missing.length === 0, missing };
}

async function runOne(a: ReturnType<typeof createAdminClient>, p: { id: string; name: string; prevFail: string }) {
  for (let i = 0; i < 30; i++) {
    const { data } = await a.from("agent_jobs").select("id").eq("workspace_id", WS)
      .eq("kind", "ad-creative-copy-author").in("status", ["queued", "queued_resume", "claimed", "building"]);
    if (!(data ?? []).length) break;
    await sleep(60000);
  }
  const enqAt = new Date().toISOString();
  const { data: job } = await a.from("agent_jobs").insert({
    workspace_id: WS, kind: "ad-creative-copy-author", status: "queued",
    spec_slug: `ad-creative-copy-author:${p.id}`, instructions: JSON.stringify({ product_id: p.id, count: 1 }),
  }).select("id").single();
  const jobId = (job as any).id as string;
  console.log(`[${ts()}] ${p.name}: ENQUEUED ${jobId.slice(0, 8)} (prev failed on ${p.prevFail})`);
  let status = "queued", logTail = "";
  for (let i = 0; i < 60; i++) {
    await sleep(90000);
    const { data } = await a.from("agent_jobs").select("status,log_tail").eq("id", jobId).maybeSingle();
    status = (data as any)?.status ?? status; logTail = (data as any)?.log_tail ?? logTail;
    if (TERMINAL.includes(status)) break;
  }
  console.log(`\n════════ ${p.name} — ${jobId.slice(0, 8)} status=${status} ════════`);
  console.log("log:", (logTail || "(none)").slice(0, 220));
  const { data: camps } = await a.from("ad_campaigns").select("id,status,angle_id,concept_tag,created_at")
    .eq("workspace_id", WS).eq("product_id", p.id).gte("created_at", enqAt).order("created_at", { ascending: false }).limit(1);
  const c = (camps as any)?.[0];
  if (!c) { console.log(`STILL NO campaign — prev failure (${p.prevFail}) may persist; check log reason above.`); console.log(`════════ END ${p.name} ════════\n`); return; }
  console.log(`✅ CAMPAIGN PRODUCED (prev failure ${p.prevFail} resolved) — ${c.id.slice(0, 8)} status=${c.status} concept=${c.concept_tag}`);
  const { data: ang } = await a.from("product_ad_angles").select("metadata").eq("id", c.angle_id).maybeSingle();
  const cp = (ang as any)?.metadata?.copy_pack; const hs = cp?.headlines ?? [], pts = cp?.primaryTexts ?? [];
  let emdash = false, threePara = 0, maxLen = 0;
  pts.forEach((pt: string) => { if (/—/.test(pt)) emdash = true; if (pt.split(/\n\s*\n/).filter((x: string) => x.trim()).length === 3) threePara++; maxLen = Math.max(maxLen, pt.length); });
  console.log(`  VARIATIONS: ${new Set(hs).size}/5 distinct  |  LONG-FORM: ${threePara}/${pts.length} 3-para (longest primary ${maxLen} chars)  |  EM-DASH: ${emdash ? "✗" : "✓ none"}`);
  const { data: v } = await a.from("ad_creative_copy_qc_verdicts").select("hard_gate_pass,persuasion_score,creative_gate_pass").eq("ad_campaign_id", c.id).order("created_at", { ascending: false }).limit(1);
  const mv = (v as any)?.[0];
  if (mv) console.log(`  MAX: hard_gate=${mv.hard_gate_pass} persuasion=${mv.persuasion_score}/10 creative_gate=${mv.creative_gate_pass ?? "n/a"} → postable(≥9)=${mv.persuasion_score >= 9 && mv.hard_gate_pass ? "YES" : "NO (held)"}`);
  console.log(`════════ END ${p.name} ════════\n`);
}

async function main() {
  const a = createAdminClient();
  let landed = false;
  for (let i = 0; i < 120; i++) {
    const { data: hb } = await a.from("worker_heartbeats").select("running_sha").order("updated_at", { ascending: false }).limit(1);
    const boxSha = (((hb as any)?.[0]?.running_sha) ?? "").replace(/[^0-9a-f]/gi, "").slice(0, 40);
    if (boxSha) {
      const { ok, missing } = boxHasAll(boxSha);
      if (ok) { console.log(`[${ts()}] both durable fixes live on box (${boxSha.slice(0, 9)}) — re-running the two failed products`); landed = true; break; }
      if (i % 5 === 0) console.log(`[${ts()}] box ${boxSha.slice(0, 9)} waiting: ${missing.join(", ")}`);
    }
    await sleep(120000);
  }
  if (!landed) { console.log("\n════════ ABORT — durable fixes never landed on box in window ════════"); return; }
  for (const p of PRODUCTS) await runOne(a, p);
  console.log("════════ BOTH RE-RUNS COMPLETE ════════");
}
main().catch((e) => { console.error("watcher threw:", e instanceof Error ? e.message : String(e)); });
