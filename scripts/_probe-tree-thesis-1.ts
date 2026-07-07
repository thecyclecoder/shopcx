/**
 * Adversarial probe #1 — head vs tail of ticket intents, Opus share, per-ticket cost.
 * READ-ONLY.
 */
import { createAdminClient } from "./_bootstrap";

async function main() {
  const admin = createAdminClient();

  // ---------- 1. Ticket universe ----------
  // All canonical tickets (merged_into IS NULL), last 120 days for recency.
  const sinceDays = 120;
  const since = new Date(Date.now() - sinceDays * 86400_000).toISOString();

  type T = {
    id: string;
    status: string;
    channel: string;
    tags: string[] | null;
    handled_by: string | null;
    ai_turn_count: number;
    escalated_at: string | null;
    escalation_reason: string | null;
    agent_intervened: boolean;
    created_at: string;
    customer_id: string | null;
  };

  const tickets: T[] = [];
  let from = 0;
  const PAGE = 1000;
  for (;;) {
    const { data, error } = await admin
      .from("tickets")
      .select(
        "id,status,channel,tags,handled_by,ai_turn_count,escalated_at,escalation_reason,agent_intervened,created_at,customer_id"
      )
      .is("merged_into", null)
      .gte("created_at", since)
      .order("created_at", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    tickets.push(...(data as unknown as T[]));
    if (data.length < PAGE) break;
    from += PAGE;
  }
  console.log(`Tickets (canonical, last ${sinceDays}d): ${tickets.length}`);
  console.log(`  since: ${since}`);

  // status distribution
  const statusDist: Record<string, number> = {};
  for (const t of tickets) statusDist[t.status] = (statusDist[t.status] || 0) + 1;
  console.log("Status:", statusDist);

  // channel distribution
  const chanDist: Record<string, number> = {};
  for (const t of tickets) chanDist[t.channel] = (chanDist[t.channel] || 0) + 1;
  console.log("Channel:", chanDist);

  // ---------- 2. Intent taxonomy from tags ----------
  // prefixes: cls: (classifier), j: (journey), pb: (playbook), ft: (?)
  const prefixCounts: Record<string, number> = {};
  const intentCounts: Record<string, number> = {}; // primary intent per ticket
  const rawTagCounts: Record<string, number> = {};
  let noIntentTag = 0;
  let multiIntent = 0;
  const multiIntentExamples: string[] = [];
  const intentTicketIds: Record<string, string[]> = {};

  for (const t of tickets) {
    const tags = t.tags || [];
    for (const tag of tags) {
      rawTagCounts[tag] = (rawTagCounts[tag] || 0) + 1;
      const m = tag.match(/^([a-z_]+):/);
      if (m) prefixCounts[m[1]] = (prefixCounts[m[1]] || 0) + 1;
    }
    const intentTags = tags.filter(
      (tg) => tg.startsWith("cls:") || tg.startsWith("j:") || tg.startsWith("pb:") || tg.startsWith("ft:")
    );
    if (intentTags.length === 0) {
      noIntentTag++;
      continue;
    }
    const distinctIntents = [...new Set(intentTags)];
    if (distinctIntents.filter((x) => x.startsWith("cls:")).length > 1) {
      multiIntent++;
      if (multiIntentExamples.length < 15)
        multiIntentExamples.push(`${t.id} [${distinctIntents.join(", ")}]`);
    }
    // primary intent = first cls: tag, else first j:/pb:/ft:
    const primary =
      distinctIntents.find((x) => x.startsWith("cls:")) || distinctIntents[0];
    intentCounts[primary] = (intentCounts[primary] || 0) + 1;
    (intentTicketIds[primary] ||= []).push(t.id);
  }

  console.log("\nTag prefix counts (tag occurrences):", prefixCounts);
  console.log(`\nTickets with NO intent tag (cls:/j:/pb:/ft:): ${noIntentTag} of ${tickets.length}`);
  console.log(`Tickets with MULTIPLE distinct cls: intents: ${multiIntent}`);
  console.log("Examples:", multiIntentExamples);

  // head vs tail
  const sorted = Object.entries(intentCounts).sort((a, b) => b[1] - a[1]);
  const totalWithIntent = sorted.reduce((s, [, n]) => s + n, 0);
  console.log(`\nDistinct primary intents: ${sorted.length}; tickets with intent: ${totalWithIntent}`);
  console.log("\nFull intent distribution (count, cum%):");
  let cum = 0;
  for (const [intent, n] of sorted) {
    cum += n;
    console.log(
      `  ${intent.padEnd(45)} ${String(n).padStart(5)}  ${((100 * n) / totalWithIntent).toFixed(1)}%  cum ${((100 * cum) / totalWithIntent).toFixed(1)}%`
    );
  }
  // head coverage
  for (const k of [3, 5, 10, 15, 20]) {
    const headSum = sorted.slice(0, k).reduce((s, [, n]) => s + n, 0);
    console.log(`Top-${k} intents cover ${((100 * headSum) / totalWithIntent).toFixed(1)}% of intent-tagged volume`);
  }
  // singleton/low-freq tail
  const singletons = sorted.filter(([, n]) => n <= 2).length;
  console.log(`Intents with <=2 tickets (long tail noise): ${singletons}`);

  // sample tail ticket ids for later inspection
  console.log("\nTail intents (bottom, n<=5) sample ticket ids:");
  for (const [intent, n] of sorted.filter(([, x]) => x <= 5).slice(0, 20)) {
    console.log(`  ${intent} (${n}): ${intentTicketIds[intent].slice(0, 3).join(", ")}`);
  }

  // ---------- 3. Escalation + intervention by intent (head vs tail quality) ----------
  const headSet = new Set(sorted.slice(0, 10).map(([i]) => i));
  let headEsc = 0, headN = 0, tailEsc = 0, tailN = 0;
  let headIntervene = 0, tailIntervene = 0;
  for (const t of tickets) {
    const tags = t.tags || [];
    const intentTags = tags.filter(
      (tg) => tg.startsWith("cls:") || tg.startsWith("j:") || tg.startsWith("pb:") || tg.startsWith("ft:")
    );
    if (intentTags.length === 0) continue;
    const primary = intentTags.find((x) => x.startsWith("cls:")) || intentTags[0];
    const escalated = !!t.escalated_at || !!t.escalation_reason;
    if (headSet.has(primary)) {
      headN++;
      if (escalated) headEsc++;
      if (t.agent_intervened) headIntervene++;
    } else {
      tailN++;
      if (escalated) tailEsc++;
      if (t.agent_intervened) tailIntervene++;
    }
  }
  console.log(`\nHEAD (top-10 intents): n=${headN}, escalated(open-state)=${headEsc}, agent_intervened=${headIntervene} (${((100 * headIntervene) / Math.max(1, headN)).toFixed(1)}%)`);
  console.log(`TAIL (rest):           n=${tailN}, escalated(open-state)=${tailEsc}, agent_intervened=${tailIntervene} (${((100 * tailIntervene) / Math.max(1, tailN)).toFixed(1)}%)`);
  console.log("(note: escalated_* cleared on close — agent_intervened is the durable human-touch signal)");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
