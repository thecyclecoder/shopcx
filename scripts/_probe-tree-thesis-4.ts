/**
 * Adversarial probe #4 — clean-cohort head/tail, Opus-spend vs path-triviality overlap,
 * ticket_analyses quality join, and exhibit tickets. READ-ONLY.
 */
import { createAdminClient } from "./_bootstrap";
const PRICING: Record<string, { input: number; output: number; cacheRead: number }> = {
  "claude-sonnet-4-6": { input: 0.3, output: 1.5, cacheRead: 0.03 },
  "claude-sonnet-4-20250514": { input: 0.3, output: 1.5, cacheRead: 0.03 },
  "claude-sonnet-4": { input: 0.3, output: 1.5, cacheRead: 0.03 },
  "claude-haiku-4-5-20251001": { input: 0.1, output: 0.5, cacheRead: 0.01 },
  "claude-haiku-4-5": { input: 0.1, output: 0.5, cacheRead: 0.01 },
  "claude-opus-4-7": { input: 1.5, output: 7.5, cacheRead: 0.15 },
};
function costCents(model: string, r: any): number {
  const p = PRICING[model] || PRICING["claude-sonnet-4-6"];
  return (r.input_tokens / 1000) * p.input + (r.output_tokens / 1000) * p.output + (r.cache_read_tokens / 1000) * p.cacheRead + (r.cache_creation_tokens / 1000) * p.input * 1.25;
}
const PAGE = 1000;
async function pageAll<T>(build: (f: number) => any): Promise<T[]> {
  const out: T[] = []; let from = 0;
  for (;;) {
    const { data, error } = await build(from).range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    out.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return out;
}

async function main() {
  const admin = createAdminClient();
  const since = new Date(Date.now() - 120 * 86400_000).toISOString();

  type T = { id: string; tags: string[] | null; handled_by: string | null; agent_intervened: boolean; channel: string; status: string };
  const tickets = await pageAll<T>(() =>
    admin.from("tickets").select("id,tags,handled_by,agent_intervened,channel,status").is("merged_into", null).gte("created_at", since).order("created_at", { ascending: true })
  );

  // clean cohort: exclude crisis-campaign-handled outbound + outreach/spam
  const isCampaign = (t: T) => (t.handled_by || "").startsWith("Crisis:");
  const isNoise = (t: T) => (t.tags || []).some((x) => x === "outreach" || x.startsWith("spam") || x === "cls:outreach");
  const clean = tickets.filter((t) => !isCampaign(t) && !isNoise(t));
  console.log(`total=${tickets.length} campaign=${tickets.filter(isCampaign).length} noise=${tickets.filter(isNoise).length} clean-inbound=${clean.length}`);

  // messages for clean cohort
  type M = { ticket_id: string; direction: string; visibility: string; author_type: string; body: string; created_at: string };
  const ids = clean.map((t) => t.id);
  const byTicket = new Map<string, M[]>();
  for (let i = 0; i < ids.length; i += 100) {
    const rows = await pageAll<M>(() =>
      admin.from("ticket_messages").select("ticket_id,direction,visibility,author_type,body,created_at").in("ticket_id", ids.slice(i, i + 100)).order("created_at", { ascending: true })
    );
    for (const m of rows) { if (!byTicket.has(m.ticket_id)) byTicket.set(m.ticket_id, []); byTicket.get(m.ticket_id)!.push(m); }
  }

  const normalizeAction = (s: string): string => {
    const raw = s.replace(/^Action (completed|failed): /, "").trim();
    return raw.split("—")[0].trim().toLowerCase().replace(/[0-9$#%().,:'"]/g, "").split(/\s+/).slice(0, 3).join("_").slice(0, 40);
  };

  const sigCounts: Record<string, number> = {};
  const sigOf = new Map<string, string>();
  const info = new Map<string, { aiTurns: number; nActions: number; nFams: number; handlers: string[] }>();
  for (const t of clean) {
    const ms = byTicket.get(t.id) || [];
    const aiTurns = ms.filter((m) => m.author_type === "ai" && m.direction === "outbound" && m.visibility === "external").length;
    const completed = ms.filter((m) => m.author_type === "system" && m.body.startsWith("Action completed:")).map((m) => normalizeAction(m.body));
    const tags = t.tags || [];
    const cls = tags.find((x) => x.startsWith("cls:")) || "cls:?";
    const handlers = tags.filter((x) => x.startsWith("j:") || x.startsWith("pb:")).sort();
    const bucket = aiTurns === 0 ? "0" : aiTurns === 1 ? "1" : aiTurns === 2 ? "2" : aiTurns <= 4 ? "3-4" : "5+";
    const sig = [cls, handlers.join("+") || "-", completed.join(">") || "-", `t${bucket}`].join(" | ");
    sigCounts[sig] = (sigCounts[sig] || 0) + 1;
    sigOf.set(t.id, sig);
    info.set(t.id, { aiTurns, nActions: completed.length, nFams: new Set(completed.map((a) => a.split("_")[0])).size, handlers });
  }
  const sigs = Object.entries(sigCounts).sort((a, b) => b[1] - a[1]);
  const N = clean.length;
  console.log(`\nCLEAN cohort distinct signatures: ${sigs.length} over ${N} tickets`);
  for (const k of [5, 10, 20, 30, 50, 100]) {
    const sum = sigs.slice(0, k).reduce((s, [, n]) => s + n, 0);
    console.log(`  Top-${k} signatures: ${((100 * sum) / N).toFixed(1)}%`);
  }
  const singles = sigs.filter(([, n]) => n === 1).length;
  const le3 = sigs.filter(([, n]) => n <= 3).reduce((s, [, n]) => s + n, 0);
  console.log(`  singleton signatures: ${singles} (${((100 * singles) / N).toFixed(1)}% of clean volume); volume in signatures with n<=3: ${le3} (${((100 * le3) / N).toFixed(1)}%)`);
  console.log("  Top 15 clean signatures:");
  let cum = 0;
  for (const [s, n] of sigs.slice(0, 15)) { cum += n; console.log(`   ${String(n).padStart(4)} cum ${((100 * cum) / N).toFixed(1)}%  ${s}`); }

  // agent_intervened by repeatability cohort
  const freqOf = new Map(sigs.map(([s, n]) => [s, n]));
  let repN = 0, repInt = 0, rareN = 0, rareInt = 0;
  for (const t of clean) {
    const f = freqOf.get(sigOf.get(t.id)!) || 0;
    if (f >= 10) { repN++; if (t.agent_intervened) repInt++; }
    else if (f <= 3) { rareN++; if (t.agent_intervened) rareInt++; }
  }
  console.log(`\nRepeatable-path tickets (sig freq>=10): n=${repN}, agent_intervened=${((100 * repInt) / Math.max(1, repN)).toFixed(1)}%`);
  console.log(`Rare-path tickets (sig freq<=3):       n=${rareN}, agent_intervened=${((100 * rareInt) / Math.max(1, rareN)).toFixed(1)}%`);

  // ---- Opus spend vs path triviality ----
  type U = { ticket_id: string | null; model: string; purpose: string | null; input_tokens: number; output_tokens: number; cache_creation_tokens: number; cache_read_tokens: number };
  const usage = await pageAll<U>(() =>
    admin.from("ai_token_usage").select("ticket_id,model,purpose,input_tokens,output_tokens,cache_creation_tokens,cache_read_tokens").gte("created_at", since).like("purpose", "orchestrator-decision:%").order("created_at", { ascending: true })
  );
  let opusTrivial = 0, opusComplex = 0, opusUnknown = 0;
  const opusTicketCost = new Map<string, number>();
  for (const u of usage) {
    if (!u.purpose?.startsWith("orchestrator-decision:opus")) continue;
    const c = costCents(u.model, u);
    if (!u.ticket_id) { opusUnknown += c; continue; }
    opusTicketCost.set(u.ticket_id, (opusTicketCost.get(u.ticket_id) || 0) + c);
  }
  let trivialTickets = 0, complexTickets = 0;
  for (const [tid, c] of opusTicketCost) {
    const i = info.get(tid);
    if (!i) { opusUnknown += c; continue; }
    const sigFreq = freqOf.get(sigOf.get(tid)!) || 0;
    // "trivial/compilable": a repeatable path (freq>=10) OR (<=1 action family and <=2 ai turns and no multi-handler)
    const trivial = sigFreq >= 10 || (i.nFams <= 1 && i.aiTurns <= 2 && i.handlers.length <= 1);
    if (trivial) { opusTrivial += c; trivialTickets++; } else { opusComplex += c; complexTickets++; }
  }
  console.log(`\nOpus orchestrator spend split by path shape (clean cohort):`);
  console.log(`  trivial/repeatable paths: $${(opusTrivial / 100).toFixed(2)} over ${trivialTickets} tickets`);
  console.log(`  complex/rare paths:       $${(opusComplex / 100).toFixed(2)} over ${complexTickets} tickets`);
  console.log(`  outside clean cohort/unattributed: $${(opusUnknown / 100).toFixed(2)}`);

  // ---- quality scores by cohort (ticket_analyses, pipeline paused ~2026-04-28) ----
  const { data: ta } = await admin.from("ticket_analyses").select("ticket_id,score,created_at").gte("created_at", since).limit(5000);
  let repScores: number[] = [], rareScores: number[] = [];
  for (const row of ta || []) {
    const sig = sigOf.get(row.ticket_id); if (!sig || row.score == null) continue;
    const f = freqOf.get(sig) || 0;
    if (f >= 10) repScores.push(row.score);
    else if (f <= 3) rareScores.push(row.score);
  }
  const avg = (a: number[]) => (a.length ? (a.reduce((s, x) => s + x, 0) / a.length).toFixed(2) : "n/a");
  const lowShare = (a: number[]) => (a.length ? ((100 * a.filter((x) => x <= 5).length) / a.length).toFixed(1) + "%" : "n/a");
  console.log(`\nticket_analyses scores: repeatable n=${repScores.length} avg=${avg(repScores)} (<=5: ${lowShare(repScores)}); rare n=${rareScores.length} avg=${avg(rareScores)} (<=5: ${lowShare(rareScores)})`);

  // ---- exhibits ----
  for (const tid of ["8b879c4f-dcf7-42b4-be3a-a5c3189728d2", "c769e4ff-d630-448a-9dad-b1b1401f3ffb", "c00119a1-25b3-453f-a833-ce5acc55b1bf", "39a108ae-8a86-434c-a73d-66df0d6f827d"]) {
    const { data: ms } = await admin.from("ticket_messages").select("author_type,direction,visibility,body,created_at").eq("ticket_id", tid).order("created_at", { ascending: true }).limit(60);
    console.log(`\n===== EXHIBIT ${tid} (${ms?.length} msgs) =====`);
    for (const m of ms || []) {
      const body = (m.body || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 160);
      console.log(`  [${String(m.created_at).slice(0, 16)}] ${m.author_type}/${m.direction}/${m.visibility}: ${body}`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
