/**
 * Adversarial probe #2 — resolution-PATH signatures (the actual "trees"),
 * plus Opus/cost analysis from ai_token_usage.
 * READ-ONLY.
 */
import { createAdminClient } from "./_bootstrap";

const PAGE = 1000;

async function pageAll<T>(build: (from: number) => any): Promise<T[]> {
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

  // ---- tickets ----
  type T = { id: string; status: string; channel: string; tags: string[] | null; handled_by: string | null; agent_intervened: boolean; created_at: string };
  const tickets = await pageAll<T>((f) =>
    admin.from("tickets")
      .select("id,status,channel,tags,handled_by,agent_intervened,created_at")
      .is("merged_into", null)
      .gte("created_at", since)
      .order("created_at", { ascending: true })
  );
  const tmap = new Map(tickets.map((t) => [t.id, t]));
  console.log(`tickets: ${tickets.length}`);

  // ---- handled_by distribution ----
  const hb: Record<string, number> = {};
  for (const t of tickets) hb[t.handled_by || "(null)"] = (hb[t.handled_by || "(null)"] || 0) + 1;
  console.log("\nhandled_by distribution:");
  for (const [k, v] of Object.entries(hb).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(40)} ${v}`);

  // ---- messages for these tickets (system notes + ai/outbound) ----
  // fetch in chunks of ticket ids
  type M = { ticket_id: string; direction: string; visibility: string; author_type: string; body: string; created_at: string };
  const ids = tickets.map((t) => t.id);
  const msgs: M[] = [];
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const rows = await pageAll<M>((f) =>
      admin.from("ticket_messages")
        .select("ticket_id,direction,visibility,author_type,body,created_at")
        .in("ticket_id", chunk)
        .order("created_at", { ascending: true })
    );
    msgs.push(...rows);
  }
  console.log(`messages: ${msgs.length}`);

  // group by ticket
  const byTicket = new Map<string, M[]>();
  for (const m of msgs) {
    if (!byTicket.has(m.ticket_id)) byTicket.set(m.ticket_id, []);
    byTicket.get(m.ticket_id)!.push(m);
  }

  // ---- build resolution-path signature per ticket ----
  // signature = primary cls bucket | ordered list of: action-completed names, action-failed names,
  //             journey/playbook launches (from tags j:/pb:), ai turn count bucket
  const sigCounts: Record<string, number> = {};
  const sigExamples: Record<string, string[]> = {};
  const actionNameCounts: Record<string, number> = {};
  const failedActionCounts: Record<string, number> = {};
  let ticketsWithActions = 0;
  let ticketsWithFailedActions = 0;
  const failedExamples: string[] = [];
  let multiActionFamilies = 0;
  const multiFamilyExamples: string[] = [];
  const aiTurnDist: Record<string, number> = {};

  const normalizeAction = (s: string): string => {
    // "Action completed: <summary or type>" — summaries are freeform; take first few words / type token
    const raw = s.replace(/^Action (completed|failed): /, "").trim();
    // failed carries "type — error"
    const t = raw.split("—")[0].trim();
    // collapse to snake-ish key: first 4 words lowercased, digits stripped
    return t.toLowerCase().replace(/[0-9$#%().,:'"]/g, "").split(/\s+/).slice(0, 4).join("_").slice(0, 48);
  };

  for (const t of tickets) {
    const ms = byTicket.get(t.id) || [];
    const aiTurns = ms.filter((m) => m.author_type === "ai" && m.direction === "outbound" && m.visibility === "external").length;
    const bucket = aiTurns === 0 ? "0" : aiTurns === 1 ? "1" : aiTurns === 2 ? "2" : aiTurns <= 4 ? "3-4" : "5+";
    aiTurnDist[bucket] = (aiTurnDist[bucket] || 0) + 1;

    const completed: string[] = [];
    const failed: string[] = [];
    for (const m of ms) {
      if (m.author_type !== "system") continue;
      if (m.body.startsWith("Action completed:")) completed.push(normalizeAction(m.body));
      else if (m.body.startsWith("Action failed:")) failed.push(normalizeAction(m.body));
    }
    if (completed.length) ticketsWithActions++;
    if (failed.length) {
      ticketsWithFailedActions++;
      if (failedExamples.length < 12) failedExamples.push(`${t.id}: ${failed.join(" | ")}`);
    }
    for (const a of completed) actionNameCounts[a] = (actionNameCounts[a] || 0) + 1;
    for (const a of failed) failedActionCounts[a] = (failedActionCounts[a] || 0) + 1;

    // action families = first word of normalized action
    const fams = new Set(completed.map((a) => a.split("_")[0]));
    if (fams.size >= 2) {
      multiActionFamilies++;
      if (multiFamilyExamples.length < 12) multiFamilyExamples.push(`${t.id}: [${[...fams].join(",")}]`);
    }

    const tags = t.tags || [];
    const cls = tags.find((x) => x.startsWith("cls:")) || "cls:?";
    const handlers = tags.filter((x) => x.startsWith("j:") || x.startsWith("pb:")).sort();
    const sig = [cls, handlers.join("+") || "-", completed.join(">") || "-", `t${bucket}`].join(" | ");
    sigCounts[sig] = (sigCounts[sig] || 0) + 1;
    (sigExamples[sig] ||= []).push(t.id);
  }

  console.log("\nAI turn distribution (external ai outbound msgs):", aiTurnDist);
  console.log(`tickets with >=1 completed action: ${ticketsWithActions}`);
  console.log(`tickets with >=1 FAILED action: ${ticketsWithFailedActions}`);
  console.log("failed examples:", failedExamples);
  console.log(`tickets whose completed actions span >=2 families: ${multiActionFamilies}`);
  console.log("multi-family examples:", multiFamilyExamples);

  console.log("\nTop 40 completed action kinds:");
  for (const [k, v] of Object.entries(actionNameCounts).sort((a, b) => b[1] - a[1]).slice(0, 40))
    console.log(`  ${k.padEnd(50)} ${v}`);
  console.log(`distinct completed action kinds: ${Object.keys(actionNameCounts).length}`);
  console.log("\nFailed action kinds:", Object.entries(failedActionCounts).sort((a, b) => b[1] - a[1]).slice(0, 20));

  // ---- signature head/tail ----
  const sigs = Object.entries(sigCounts).sort((a, b) => b[1] - a[1]);
  const totalSig = tickets.length;
  console.log(`\nDistinct resolution-path signatures: ${sigs.length} over ${totalSig} tickets`);
  let cum = 0;
  console.log("Top 30 signatures:");
  for (const [s, n] of sigs.slice(0, 30)) {
    cum += n;
    console.log(`  ${String(n).padStart(4)}  cum ${((100 * cum) / totalSig).toFixed(1)}%  ${s}`);
  }
  for (const k of [5, 10, 20, 30, 50, 100]) {
    const sum = sigs.slice(0, k).reduce((s, [, n]) => s + n, 0);
    console.log(`Top-${k} signatures cover ${((100 * sum) / totalSig).toFixed(1)}%`);
  }
  const singletonSigs = sigs.filter(([, n]) => n === 1).length;
  const singletonVol = singletonSigs;
  console.log(`Signatures appearing exactly ONCE: ${singletonSigs} (${((100 * singletonVol) / totalSig).toFixed(1)}% of ticket volume)`);
  // sample singleton examples with actions
  console.log("Sample singleton signatures (the unrepeatable tail):");
  for (const [s] of sigs.filter(([, n]) => n === 1).slice(0, 15))
    console.log(`  ${sigExamples[s][0]}  ${s}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
