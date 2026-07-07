/**
 * Adversarial probe #5 — what IS the "t0 / no action / no intent" head bucket?
 * Sample and characterize. READ-ONLY.
 */
import { createAdminClient } from "./_bootstrap";
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
  type T = { id: string; tags: string[] | null; handled_by: string | null; agent_intervened: boolean; channel: string; status: string; subject: string | null; do_not_reply: boolean };
  const tickets = await pageAll<T>(() =>
    admin.from("tickets").select("id,tags,handled_by,agent_intervened,channel,status,subject,do_not_reply").is("merged_into", null).gte("created_at", since).order("created_at", { ascending: true })
  );
  const isCampaign = (t: T) => (t.handled_by || "").startsWith("Crisis:");
  const isNoise = (t: T) => (t.tags || []).some((x) => x === "outreach" || x.startsWith("spam") || x === "cls:outreach");
  const clean = tickets.filter((t) => !isCampaign(t) && !isNoise(t));

  // find clean tickets with zero AI external msgs, no cls tag, no j:/pb:
  const candidates = clean.filter((t) => {
    const tags = t.tags || [];
    return !tags.some((x) => x.startsWith("cls:") || x.startsWith("j:") || x.startsWith("pb:"));
  });
  console.log(`clean tickets without cls/j/pb tags: ${candidates.length}`);

  // characterize: message compositions
  const ids = candidates.map((t) => t.id);
  type M = { ticket_id: string; author_type: string; direction: string; visibility: string; body: string };
  const byTicket = new Map<string, M[]>();
  for (let i = 0; i < ids.length; i += 100) {
    const rows = await pageAll<M>(() =>
      admin.from("ticket_messages").select("ticket_id,author_type,direction,visibility,body").in("ticket_id", ids.slice(i, i + 100)).order("created_at", { ascending: true })
    );
    for (const m of rows) { if (!byTicket.has(m.ticket_id)) byTicket.set(m.ticket_id, []); byTicket.get(m.ticket_id)!.push(m); }
  }
  const cat: Record<string, number> = {};
  const samples: Record<string, string[]> = {};
  for (const t of candidates) {
    const ms = byTicket.get(t.id) || [];
    const aiExt = ms.filter((m) => m.author_type === "ai" && m.visibility === "external").length;
    const agentExt = ms.filter((m) => m.author_type === "agent" && m.visibility === "external").length;
    const sysExt = ms.filter((m) => m.author_type === "system" && m.visibility === "external").length;
    const custIn = ms.filter((m) => m.author_type === "customer").length;
    let c: string;
    if (t.do_not_reply) c = "do_not_reply";
    else if (agentExt > 0) c = "human-agent-handled";
    else if (aiExt > 0 && sysExt === 0) c = "ai-replied(untagged)";
    else if (aiExt > 0) c = "ai+system-replied(untagged)";
    else if (sysExt > 0) c = "system-replied-only";
    else if (custIn === 0) c = "no-customer-msg(outbound-only?)";
    else c = "customer-msg-no-reply-at-all";
    cat[c] = (cat[c] || 0) + 1;
    if ((samples[c] ||= []).length < 5) samples[c].push(`${t.id} "${(t.subject || "").slice(0, 60)}" ch=${t.channel} status=${t.status}`);
  }
  console.log("categories:", cat);
  for (const [k, v] of Object.entries(samples)) console.log(`\n${k}:\n  ${v.join("\n  ")}`);

  // overall AI-engagement share of clean cohort
  const allIds = clean.map((t) => t.id);
  let engaged = 0;
  const byT2 = new Map<string, number>();
  for (let i = 0; i < allIds.length; i += 100) {
    const rows = await pageAll<{ ticket_id: string }>(() =>
      admin.from("ticket_messages").select("ticket_id").in("ticket_id", allIds.slice(i, i + 100)).eq("author_type", "ai").eq("visibility", "external")
    );
    for (const r of rows) byT2.set(r.ticket_id, (byT2.get(r.ticket_id) || 0) + 1);
  }
  engaged = [...byT2.keys()].length;
  console.log(`\nclean tickets with >=1 external AI message: ${engaged} of ${clean.length} (${((100 * engaged) / clean.length).toFixed(1)}%)`);
}
main().catch((e) => { console.error(e); process.exit(1); });
