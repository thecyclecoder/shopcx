import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "@/lib/supabase/admin";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const PRODUCTS = [
  { id: "f55a1cb1-f3ca-4e0d-9c64-ecd1cd865efb", name: "Ashwavana Guru Focus" },
  { id: "48bfa48c-b8db-42f9-9303-19c70ab8e7a1", name: "Ashwavana Zen Relax" },
  { id: "61a4490e-cb2a-4f65-9613-faab40f0b153", name: "Amazing Creamer" },
  { id: "221d272d-a6c5-4a5d-86ff-ac693926c992", name: "Superfood Tabs" },
];
const TERMINAL = ["completed", "failed", "cancelled", "needs_input", "needs_attention"];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ts = () => new Date().toISOString().slice(11, 19);

async function runOne(a: ReturnType<typeof createAdminClient>, p: { id: string; name: string }) {
  // one-at-a-time: wait for any in-flight author job to clear
  for (let i = 0; i < 30; i++) {
    const { data } = await a.from("agent_jobs").select("id").eq("workspace_id", WS)
      .eq("kind", "ad-creative-copy-author").in("status", ["queued", "queued_resume", "claimed", "building"]);
    if (!(data ?? []).length) break;
    await sleep(60000);
  }
  const enqAt = new Date().toISOString();
  const { data: job } = await a.from("agent_jobs").insert({
    workspace_id: WS, kind: "ad-creative-copy-author", status: "queued",
    spec_slug: `ad-creative-copy-author:${p.id}`,
    instructions: JSON.stringify({ product_id: p.id, count: 1 }),
  }).select("id").single();
  const jobId = (job as any).id as string;
  console.log(`[${ts()}] ${p.name}: ENQUEUED ${jobId.slice(0, 8)}`);

  let status = "queued", logTail = "";
  for (let i = 0; i < 60; i++) {
    await sleep(90000);
    const { data } = await a.from("agent_jobs").select("status,log_tail").eq("id", jobId).maybeSingle();
    status = (data as any)?.status ?? status; logTail = (data as any)?.log_tail ?? logTail;
    if (TERMINAL.includes(status)) break;
  }

  console.log(`\n════════ ${p.name} — ${jobId.slice(0, 8)} status=${status} ════════`);
  console.log("log:", (logTail || "(none)").slice(0, 240));
  const { data: camps } = await a.from("ad_campaigns")
    .select("id,status,angle_id,concept_tag,created_at")
    .eq("workspace_id", WS).eq("product_id", p.id).gte("created_at", enqAt)
    .order("created_at", { ascending: false }).limit(1);
  const c = (camps as any)?.[0];
  if (!c) { console.log("NO campaign produced (see log reason above — held/failed)."); console.log(`════════ END ${p.name} ════════\n`); return; }
  console.log(`campaign ${c.id.slice(0, 8)} status=${c.status} concept=${c.concept_tag}`);
  const { data: ang } = await a.from("product_ad_angles").select("metadata").eq("id", c.angle_id).maybeSingle();
  const cp = (ang as any)?.metadata?.copy_pack;
  const hs = cp?.headlines ?? [], pts = cp?.primaryTexts ?? [];
  const distinct = new Set(hs).size;
  console.log(`  VARIATIONS: ${hs.length} headlines, ${distinct} distinct ${distinct >= 5 ? "✓" : "✗"}`);
  // per-variation: 3-paragraph long-form? em-dash? show first framework as sample
  let emdash = false, threePara = 0;
  pts.forEach((pt: string) => {
    if (/—/.test(pt)) emdash = true;
    if ((pt.split(/\n\s*\n/).filter((x: string) => x.trim()).length) === 3) threePara++;
  });
  console.log(`  LONG-FORM: ${threePara}/${pts.length} variations are 3-paragraph  |  EM-DASH: ${emdash ? "✗ present" : "✓ none"}`);
  const corpus = (hs.join(" ") + " " + pts.join(" ")).toLowerCase();
  console.log(`  PROOF: ${["700|700,000|700k", "money-back|money back|guarantee|risk-free|30[- ]day", "gourmet", "15,?000|15k|non-gmo|3rd[- ]party"].map((re, i) => `${new RegExp(re).test(corpus) ? "✓" : "✗"}${["700K", "risk-rev", "gourmet", "reviews/certs"][i]}`).join(" ")}`);
  // sample: cialdini variation (best proof home)
  const ci = (cp?.frameworks ?? []).indexOf("cialdini");
  if (ci >= 0) console.log(`  [cialdini sample]\n    H: ${hs[ci]}\n    PT: ${(pts[ci] ?? "").replace(/\n/g, "\\n").slice(0, 300)}`);
  const { data: v } = await a.from("ad_creative_copy_qc_verdicts")
    .select("hard_gate_pass,persuasion_score,creative_gate_pass,verdict_reason").eq("ad_campaign_id", c.id)
    .order("created_at", { ascending: false }).limit(1);
  const mv = (v as any)?.[0];
  if (mv) console.log(`  MAX: hard_gate=${mv.hard_gate_pass} persuasion=${mv.persuasion_score}/10 creative_gate=${mv.creative_gate_pass ?? "n/a"} → postable(≥9)=${mv.persuasion_score >= 9 && mv.hard_gate_pass ? "YES" : "NO (held for review)"}\n       reason: ${(mv.verdict_reason || "").slice(0, 180)}`);
  console.log(`════════ END ${p.name} ════════\n`);
}

async function main() {
  const a = createAdminClient();
  for (const p of PRODUCTS) await runOne(a, p);
  console.log("════════ ALL FOUR RUNS COMPLETE ════════");
}
main().catch((e) => { console.error("test threw:", e instanceof Error ? e.message : String(e)); });
