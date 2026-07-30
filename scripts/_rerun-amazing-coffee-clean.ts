import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "@/lib/supabase/admin";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const COFFEE = "ea433e56-0aa4-4b46-9107-feb11f77f533";
const TERMINAL = ["completed", "failed", "cancelled", "needs_input", "needs_attention"];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ts = () => new Date().toISOString().slice(11, 19);

async function main() {
  const a = createAdminClient();
  // No double-enqueue: wait for any in-flight author job to clear.
  for (let i = 0; i < 30; i++) {
    const { data } = await a.from("agent_jobs").select("id").eq("workspace_id", WS)
      .eq("kind", "ad-creative-copy-author").in("status", ["queued", "queued_resume", "claimed", "building"]);
    if (!(data ?? []).length) break;
    console.log(`[${ts()}] waiting — author job in-flight`);
    await sleep(60000);
  }
  const enqAt = new Date().toISOString();
  const { data: job } = await a.from("agent_jobs").insert({
    workspace_id: WS, kind: "ad-creative-copy-author", status: "queued",
    spec_slug: `ad-creative-copy-author:${COFFEE}`,
    instructions: JSON.stringify({ product_id: COFFEE, count: 1 }),
  }).select("id").single();
  const jobId = (job as any).id as string;
  console.log(`[${ts()}] Amazing Coffee re-run ENQUEUED ${jobId.slice(0, 8)} (enqAt=${enqAt.slice(11, 19)})`);

  let status = "queued", logTail = "";
  for (let i = 0; i < 55; i++) {
    await sleep(90000);
    const { data } = await a.from("agent_jobs").select("status,log_tail").eq("id", jobId).maybeSingle();
    status = (data as any)?.status ?? status; logTail = (data as any)?.log_tail ?? logTail;
    if (TERMINAL.includes(status)) break;
  }
  console.log(`\n════════ Amazing Coffee re-run ${jobId.slice(0, 8)} status=${status} ════════`);
  console.log("log:", logTail || "(none)");

  // CORRECT attribution: only a campaign created AT/AFTER this job's enqueue counts as its output.
  const { data: camps } = await a.from("ad_campaigns")
    .select("id,status,angle_id,concept_tag,created_at")
    .eq("workspace_id", WS).eq("product_id", COFFEE).gte("created_at", enqAt)
    .order("created_at", { ascending: false }).limit(1);
  const c = (camps as any)?.[0];
  if (!c) { console.log("NO campaign created by this run (it failed to bin — see log reason above)."); console.log("════════ END ════════"); return; }
  console.log(`campaign ${c.id.slice(0, 8)} status=${c.status} concept=${c.concept_tag}`);
  const { data: ang } = await a.from("product_ad_angles").select("metadata").eq("id", c.angle_id).maybeSingle();
  const cp = (ang as any)?.metadata?.copy_pack;
  const hs = cp?.headlines ?? [], pts = cp?.primaryTexts ?? [];
  const distinct = new Set(hs).size;
  console.log(`VARIATIONS: ${hs.length} headlines, ${distinct} DISTINCT ${distinct >= 5 ? "✓" : "✗"}`);
  hs.forEach((h: string, i: number) => console.log(`  [${cp.frameworks?.[i] ?? "?"}] ${h}  ::  ${(pts[i] ?? "").slice(0, 160)}`));
  const corpus = (hs.join(" ") + " " + pts.join(" ")).toLowerCase();
  const proof = {
    "700k customers": /700|700,000|700k/.test(corpus),
    "risk reversal (money-back/guarantee)": /money-back|money back|guarantee|risk-free|risk free|30[- ]day/.test(corpus),
    "Gourmet Magazine": /gourmet/.test(corpus),
    "reviews/certs (15k/non-gmo/3rd-party)": /15,?000|15k|non-gmo|3rd[- ]party|best tasting/.test(corpus),
  };
  console.log(`PROOF POINTS USED: ${Object.entries(proof).map(([k, v]) => `${v ? "✓" : "✗"} ${k}`).join("  |  ")}`);
  const { data: v } = await a.from("ad_creative_copy_qc_verdicts")
    .select("hard_gate_pass,persuasion_score,verdict_reason").eq("ad_campaign_id", c.id)
    .order("created_at", { ascending: false }).limit(1);
  for (const mv of (v ?? []) as any[])
    console.log(`MAX: hard_gate_pass=${mv.hard_gate_pass} persuasion=${mv.persuasion_score}/10 (postable=${mv.persuasion_score >= 7 && mv.hard_gate_pass ? "YES" : "NO — Bianca holds"})\n     reason: ${(mv.verdict_reason || "").slice(0, 260)}`);
  console.log("════════ END ════════");
}
main().catch((e) => { console.error("rerun threw:", e instanceof Error ? e.message : String(e)); process.exit(1); });
