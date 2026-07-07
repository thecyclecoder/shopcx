/**
 * Adversarial probe #3 — cost analysis (Opus share, per-ticket cost concentration),
 * plus policy/prompt drift rates, escalation/knowledge gaps, and the crisis-noise
 * correction to the head/tail picture. READ-ONLY.
 */
import { createAdminClient } from "./_bootstrap";
// pricing copied from src/lib/ai-usage.ts usageCostCents
const PRICING: Record<string, { input: number; output: number; cacheRead: number }> = {
  "claude-sonnet-4-6": { input: 0.3, output: 1.5, cacheRead: 0.03 },
  "claude-sonnet-4-20250514": { input: 0.3, output: 1.5, cacheRead: 0.03 },
  "claude-sonnet-4": { input: 0.3, output: 1.5, cacheRead: 0.03 },
  "claude-haiku-4-5-20251001": { input: 0.1, output: 0.5, cacheRead: 0.01 },
  "claude-haiku-4-5": { input: 0.1, output: 0.5, cacheRead: 0.01 },
  "claude-opus-4-7": { input: 1.5, output: 7.5, cacheRead: 0.15 },
};
function costCents(model: string, r: { input_tokens: number; output_tokens: number; cache_creation_tokens: number; cache_read_tokens: number }): number {
  const p = PRICING[model] || PRICING["claude-sonnet-4-6"];
  return (r.input_tokens / 1000) * p.input + (r.output_tokens / 1000) * p.output + (r.cache_read_tokens / 1000) * p.cacheRead + (r.cache_creation_tokens / 1000) * p.input * 1.25;
}

const PAGE = 1000;
async function pageAll<T>(build: (f: number) => any): Promise<T[]> {
  const out: T[] = [];
  let from = 0;
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
  const sinceDays = 120;
  const since = new Date(Date.now() - sinceDays * 86400_000).toISOString();

  // ---- full handled_by (was truncated) + crisis split ----
  type T = { id: string; tags: string[] | null; handled_by: string | null; agent_intervened: boolean; channel: string };
  const tickets = await pageAll<T>(() =>
    admin.from("tickets").select("id,tags,handled_by,agent_intervened,channel").is("merged_into", null).gte("created_at", since).order("created_at", { ascending: true })
  );
  const hb: Record<string, number> = {};
  for (const t of tickets) hb[t.handled_by || "(null)"] = (hb[t.handled_by || "(null)"] || 0) + 1;
  console.log("handled_by (full):");
  for (const [k, v] of Object.entries(hb).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(45)} ${v}`);

  const crisisTickets = tickets.filter((t) => (t.tags || []).some((x) => x.startsWith("crisis")));
  console.log(`\ncrisis-tagged tickets: ${crisisTickets.length} of ${tickets.length}`);
  const spamOutreach = tickets.filter((t) => (t.tags || []).some((x) => x === "outreach" || x.startsWith("spam") || x === "cls:outreach"));
  console.log(`outreach/spam tickets: ${spamOutreach.length}`);

  // ---- ai_token_usage in window ----
  type U = { ticket_id: string | null; model: string; purpose: string | null; input_tokens: number; output_tokens: number; cache_creation_tokens: number; cache_read_tokens: number; created_at: string };
  const usage = await pageAll<U>(() =>
    admin.from("ai_token_usage")
      .select("ticket_id,model,purpose,input_tokens,output_tokens,cache_creation_tokens,cache_read_tokens,created_at")
      .gte("created_at", since)
      .order("created_at", { ascending: true })
  );
  console.log(`\nai_token_usage rows (${sinceDays}d): ${usage.length}`);

  // model distribution + cost
  const byModel: Record<string, { n: number; cents: number }> = {};
  for (const u of usage) {
    const m = (byModel[u.model] ||= { n: 0, cents: 0 });
    m.n++;
    m.cents += costCents(u.model, u);
  }
  console.log("By model:");
  for (const [k, v] of Object.entries(byModel).sort((a, b) => b[1].cents - a[1].cents))
    console.log(`  ${k.padEnd(30)} calls=${String(v.n).padStart(6)} cost=$${(v.cents / 100).toFixed(2)}`);

  // purpose families
  const byPurpose: Record<string, { n: number; cents: number }> = {};
  for (const u of usage) {
    let p = u.purpose || "(null)";
    // family: strip round + parenthetical detail variants but keep opus reason
    p = p.replace(/:round\d+$/, "");
    const fam = (byPurpose[p] ||= { n: 0, cents: 0 });
    fam.n++;
    fam.cents += costCents(u.model, u);
  }
  console.log("\nTop purposes by cost:");
  for (const [k, v] of Object.entries(byPurpose).sort((a, b) => b[1].cents - a[1].cents).slice(0, 30))
    console.log(`  ${k.padEnd(70)} calls=${String(v.n).padStart(5)} $${(v.cents / 100).toFixed(2)}`);

  // orchestrator-decision opus reasons
  const opusReasons: Record<string, { n: number; cents: number; tickets: Set<string> }> = {};
  let orchSonnet = { n: 0, cents: 0, tickets: new Set<string>() };
  let orchOpus = { n: 0, cents: 0, tickets: new Set<string>() };
  for (const u of usage) {
    const p = u.purpose || "";
    if (!p.startsWith("orchestrator-decision:")) continue;
    const c = costCents(u.model, u);
    const m = p.match(/^orchestrator-decision:(sonnet|opus)\(([^)]*)\)/);
    if (!m) continue;
    if (m[1] === "opus") {
      orchOpus.n++; orchOpus.cents += c; if (u.ticket_id) orchOpus.tickets.add(u.ticket_id);
      for (const reason of m[2].split("+")) {
        const key = reason.replace(/=.*$/, "").replace(/>=\d+/, "");
        const r = (opusReasons[key] ||= { n: 0, cents: 0, tickets: new Set() });
        r.n++; r.cents += c; if (u.ticket_id) r.tickets.add(u.ticket_id);
      }
    } else {
      orchSonnet.n++; orchSonnet.cents += c; if (u.ticket_id) orchSonnet.tickets.add(u.ticket_id);
    }
  }
  console.log(`\nOrchestrator decisions: sonnet calls=${orchSonnet.n} ($${(orchSonnet.cents / 100).toFixed(2)}, ${orchSonnet.tickets.size} tickets) | opus calls=${orchOpus.n} ($${(orchOpus.cents / 100).toFixed(2)}, ${orchOpus.tickets.size} tickets)`);
  console.log("Opus reasons (a call can carry several):");
  for (const [k, v] of Object.entries(opusReasons).sort((a, b) => b[1].cents - a[1].cents))
    console.log(`  ${k.padEnd(25)} calls=${String(v.n).padStart(5)} $${(v.cents / 100).toFixed(2)} tickets=${v.tickets.size}`);

  // per-ticket cost distribution
  const perTicket: Record<string, number> = {};
  let unattributed = 0;
  for (const u of usage) {
    const c = costCents(u.model, u);
    if (u.ticket_id) perTicket[u.ticket_id] = (perTicket[u.ticket_id] || 0) + c;
    else unattributed += c;
  }
  const costs = Object.values(perTicket).sort((a, b) => a - b);
  const totalTicketCost = costs.reduce((s, x) => s + x, 0);
  const pct = (q: number) => costs[Math.min(costs.length - 1, Math.floor(q * costs.length))];
  console.log(`\nPer-ticket cost: tickets with usage=${costs.length}, total=$${(totalTicketCost / 100).toFixed(2)}, unattributed=$${(unattributed / 100).toFixed(2)}`);
  console.log(`  mean=${(totalTicketCost / costs.length).toFixed(2)}c p50=${pct(0.5).toFixed(2)}c p75=${pct(0.75).toFixed(2)}c p90=${pct(0.9).toFixed(2)}c p95=${pct(0.95).toFixed(2)}c p99=${pct(0.99).toFixed(2)}c max=${costs[costs.length - 1].toFixed(1)}c`);
  // concentration
  const desc = [...costs].reverse();
  for (const share of [0.1, 0.2, 0.5]) {
    const k = Math.floor(share * desc.length);
    const sum = desc.slice(0, k).reduce((s, x) => s + x, 0);
    console.log(`  top ${share * 100}% most expensive tickets carry ${((100 * sum) / totalTicketCost).toFixed(1)}% of ticket-attributed cost`);
  }

  // top 12 most expensive tickets with tags
  const topIds = Object.entries(perTicket).sort((a, b) => b[1] - a[1]).slice(0, 12);
  const tmap = new Map(tickets.map((t) => [t.id, t]));
  console.log("\nMost expensive tickets:");
  for (const [id, c] of topIds) {
    const t = tmap.get(id);
    console.log(`  ${id} $${(c / 100).toFixed(2)} tags=[${(t?.tags || []).join(",")}] handled_by=${t?.handled_by} intervened=${t?.agent_intervened}`);
  }

  // ---- drift rates: policies / sonnet_prompts / playbook_steps churn ----
  const { data: pol } = await admin.from("policies").select("id,updated_at,created_at").order("updated_at", { ascending: false });
  console.log(`\npolicies rows: ${pol?.length}; updated_at:`, (pol || []).map((p) => String(p.updated_at).slice(0, 10)).join(", "));
  const { data: sp } = await admin.from("sonnet_prompts").select("id,created_at,updated_at,is_active").order("updated_at", { ascending: false }).limit(2000);
  const spActive = (sp || []).filter((x) => x.is_active !== false);
  const sp90 = (sp || []).filter((x) => x.updated_at >= new Date(Date.now() - 90 * 86400_000).toISOString());
  console.log(`sonnet_prompts rows: ${sp?.length} (active=${spActive.length}); touched in last 90d: ${sp90.length}`);
  const { data: pbs } = await admin.from("playbook_steps").select("id,updated_at").order("updated_at", { ascending: false }).limit(1000);
  const pbs90 = (pbs || []).filter((x) => x.updated_at >= new Date(Date.now() - 90 * 86400_000).toISOString());
  console.log(`playbook_steps rows: ${pbs?.length}; touched in last 90d: ${pbs90.length}`);
  const { data: jd } = await admin.from("journey_definitions").select("id,name,updated_at").order("updated_at", { ascending: false }).limit(200);
  const jd90 = (jd || []).filter((x) => x.updated_at >= new Date(Date.now() - 90 * 86400_000).toISOString());
  console.log(`journey_definitions rows: ${jd?.length}; touched in last 90d: ${jd90.length}`);

  // gaps
  const { count: eg } = await admin.from("escalation_gaps").select("id", { count: "exact", head: true }).gte("created_at", since);
  const { count: kg } = await admin.from("knowledge_gaps").select("id", { count: "exact", head: true }).gte("created_at", since);
  console.log(`escalation_gaps (${sinceDays}d): ${eg}; knowledge_gaps: ${kg}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
