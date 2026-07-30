import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "@/lib/supabase/admin";
import { execSync } from "child_process";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
// Run order: Amazing Coffee first, then Superfood Tabs
const PRODUCTS: { id: string; name: string }[] = [
  { id: "ea433e56-0aa4-4b46-9107-feb11f77f533", name: "Amazing Coffee" },
  { id: "221d272d-a6c5-4a5d-86ff-ac693926c992", name: "Superfood Tabs" },
];
// Both fixes must be on the box before we run (so the test exercises the new logic):
const FIX_GREPS = [
  { label: "require-variations", grep: "requires-variations-no-silent-broadcast" },
  { label: "proofStack", grep: "proofstack-is-a-citeable-claim-source" },
];
const TERMINAL = ["completed", "failed", "cancelled", "needs_input", "needs_attention"];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ts = () => new Date().toISOString().slice(11, 19);

function boxHasAllFixes(boxSha: string): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  try { execSync(`git fetch origin main -q`, { cwd: process.cwd() }); } catch { /* keep going */ }
  for (const f of FIX_GREPS) {
    try {
      const merge = execSync(`git log origin/main --grep="${f.grep}" --oneline -1`, { cwd: process.cwd() })
        .toString().trim().split(" ")[0];
      if (!merge) { missing.push(`${f.label}(not merged)`); continue; }
      execSync(`git merge-base --is-ancestor ${merge} ${boxSha}`, { cwd: process.cwd(), stdio: "ignore" });
    } catch { missing.push(`${f.label}(not on box)`); }
  }
  return { ok: missing.length === 0, missing };
}

async function liveBoxSha(a: ReturnType<typeof createAdminClient>): Promise<string> {
  const { data: hb } = await a.from("worker_heartbeats").select("running_sha").order("updated_at", { ascending: false }).limit(1);
  return (((hb as any)?.[0]?.running_sha) ?? "").replace(/[^0-9a-f]/gi, "").slice(0, 40);
}

async function authorJobInFlight(a: ReturnType<typeof createAdminClient>): Promise<string[]> {
  const { data } = await a.from("agent_jobs").select("id").eq("workspace_id", WS)
    .eq("kind", "ad-creative-copy-author").in("status", ["queued", "queued_resume", "claimed", "building"]);
  return ((data ?? []) as any[]).map((j) => j.id.slice(0, 8));
}

async function runOneProduct(a: ReturnType<typeof createAdminClient>, p: { id: string; name: string }): Promise<void> {
  // Never double-enqueue: wait for any in-flight author job to clear first.
  for (let i = 0; i < 40; i++) {
    const inflight = await authorJobInFlight(a);
    if (!inflight.length) break;
    console.log(`[${ts()}] ${p.name}: waiting — author job in-flight (${inflight.join(",")})`);
    await sleep(90000);
  }
  const { data: job } = await a.from("agent_jobs").insert({
    workspace_id: WS, kind: "ad-creative-copy-author", status: "queued",
    spec_slug: `ad-creative-copy-author:${p.id}`,
    instructions: JSON.stringify({ product_id: p.id, count: 1 }),
  }).select("id").single();
  const jobId = (job as any).id as string;
  console.log(`[${ts()}] ${p.name}: ENQUEUED run ${jobId.slice(0, 8)}`);

  // Wait terminal (~80 min cap)
  let status = "queued";
  for (let i = 0; i < 55; i++) {
    await sleep(90000);
    const { data } = await a.from("agent_jobs").select("status").eq("id", jobId).maybeSingle();
    status = (data as any)?.status ?? status;
    if (TERMINAL.includes(status)) break;
  }

  console.log(`\n════════ ${p.name} — job ${jobId.slice(0, 8)} status=${status} ════════`);
  const { data: jr } = await a.from("agent_jobs").select("log_tail").eq("id", jobId).maybeSingle();
  console.log("log:", (jr as any)?.log_tail || "(none)");

  const since = new Date(Date.now() - 45 * 60 * 1000).toISOString();
  const { data: camps } = await a.from("ad_campaigns")
    .select("id,status,angle_id,audience_temperature,concept_tag,author_self_score,created_at")
    .eq("workspace_id", WS).eq("product_id", p.id).gte("created_at", since)
    .order("created_at", { ascending: false }).limit(1);
  for (const c of (camps ?? []) as any[]) {
    console.log(`campaign ${c.id.slice(0, 8)} status=${c.status} temp=${c.audience_temperature} concept=${c.concept_tag} dahlia_self=${c.author_self_score?.total ?? "-"}`);
    let corpus = "";
    if (c.angle_id) {
      const { data: ang } = await a.from("product_ad_angles").select("metadata").eq("id", c.angle_id).maybeSingle();
      const cp = (ang as any)?.metadata?.copy_pack;
      const hs = cp?.headlines ?? []; const pts = cp?.primaryTexts ?? [];
      const distinct = new Set(hs).size;
      console.log(`  VARIATIONS: ${hs.length} headlines, ${distinct} DISTINCT ${distinct >= 5 ? "✓ (natively distinct)" : distinct >= 2 ? "◐ (partial)" : "✗ (collapsed/identical)"}`);
      hs.forEach((h: string, idx: number) => console.log(`   [${cp.frameworks?.[idx] ?? "?"}] ${h}`));
      corpus = (hs.join(" ") + " " + pts.join(" ")).toLowerCase();
    }
    // Proof-point usage (700k customers / money-back-risk-reversal / gourmet magazine)
    const proof = {
      "700k customers": /700|700,000|700k/.test(corpus),
      "risk reversal (money-back/guarantee/risk-free)": /money-back|money back|guarantee|risk-free|risk free|30[- ]day/.test(corpus),
      "Gourmet Magazine": /gourmet/.test(corpus),
    };
    console.log(`  PROOF POINTS USED: ${Object.entries(proof).map(([k, v]) => `${v ? "✓" : "✗"} ${k}`).join("  |  ")}`);
    const { data: v } = await a.from("ad_creative_copy_qc_verdicts")
      .select("hard_gate_pass,persuasion_score,verdict_reason").eq("ad_campaign_id", c.id)
      .order("created_at", { ascending: false }).limit(1);
    for (const mv of (v ?? []) as any[])
      console.log(`  MAX: hard_gate_pass=${mv.hard_gate_pass} persuasion=${mv.persuasion_score}/10\n       reason=${(mv.verdict_reason || "").slice(0, 200)}`);
    console.log(`  ELIGIBLE (in bin as ready)? ${c.status === "ready" ? "YES ✓" : `no (status=${c.status})`}`);
  }
  console.log(`════════ END ${p.name} ════════\n`);
}

async function main() {
  const a = createAdminClient();
  // Phase A: gate on BOTH fixes being live on the box.
  let landed = false;
  for (let i = 0; i < 90; i++) { // ~2.25h
    const sha = await liveBoxSha(a);
    if (sha) {
      const { ok, missing } = boxHasAllFixes(sha);
      if (ok) { console.log(`[${ts()}] both fixes live on box (${sha.slice(0, 9)}) — starting runs`); landed = true; break; }
      if (i % 4 === 0) console.log(`[${ts()}] waiting — box ${sha.slice(0, 9)} missing: ${missing.join(", ")}`);
    }
    await sleep(90000);
  }
  if (!landed) { console.log("\n════════ ABORT — both fixes never landed on the box within the window ════════"); return; }

  // Phase B/C: run each product in sequence.
  for (const p of PRODUCTS) await runOneProduct(a, p);
  console.log("════════ ALL RUNS COMPLETE ════════");
}
main().catch((e) => { console.error("monitor threw:", e instanceof Error ? e.message : String(e)); process.exit(1); });
