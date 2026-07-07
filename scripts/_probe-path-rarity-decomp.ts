/**
 * READ-ONLY. Decompose the adversary's "25% of volume walks a rare path" stat.
 * Reports path rarity at THREE grains and — the key move — splits the
 * rare-at-full-grain bucket into: (a) familiar PROBLEM, interpreter improvised
 * a novel action sequence (= compilable), vs (b) genuinely novel problem.
 *
 * Grains:
 *   problem = intent (transparent lexicon over subject + first customer inbound)
 *   mid     = intent × primary action family
 *   full    = intent × ordered action sequence × turn bucket  (adversary's def)
 */
import { pgClient } from "./_bootstrap";

// Transparent intent lexicon (first match wins) over subject + first inbound.
const INTENTS: Array<[RegExp, string]> = [
  [/\b(cancel|unsubscribe from (my )?sub|stop (my )?(sub|auto|order|shipment)|end (my )?subscription)\b/i, "cancel"],
  [/\b(refund|money back|reimburse|charge ?back|dispute|overcharg|double charg|charged twice)\b/i, "refund_billing_dispute"],
  [/\b(where.?s? my|track|tracking|when will .* (ship|arrive|deliver)|hasn'?t (arrived|shipped|come)|not (yet )?(arrived|delivered|received)|status of my|delivery status)\b/i, "order_status"],
  [/\b((can'?t|cannot|couldn'?t|trouble|unable|having (issues?|trouble)|help me).{0,30}(order|checkout|check out|buy|purchase|subscribe|resubscribe|place)|place an order|how (do|can) i (order|buy|subscribe))\b/i, "purchase_checkout_help"],
  [/\b(missing|didn'?t (get|receive)|never (got|received|arrived)|damaged|broken|leaked|melted|wrong (item|product|flavor|order)|not what i ordered)\b/i, "missing_damaged_wrong"],
  [/\b(swap|switch .*(flavor|product)|skip|change .*(date|frequency|next|quantity|delivery|often)|push (back|out)|delay|reschedul|too (often|much)|space out|less frequent|more frequent)\b/i, "modify_subscription"],
  [/\b(payment (method|failed|declin)|card (declin|expired|update|change)|update .*(card|payment)|billing info|expired card|failed payment)\b/i, "payment_method"],
  [/\b(log ?in|password|reset|can'?t (access|get into|log)|account access|magic link|verify my|verification)\b/i, "account_access"],
  [/\b(point|reward|loyalty|redeem)\b/i, "loyalty"],
  [/\b(restock|out of stock|back in stock|sold out|when .* (back|available)|availability)\b/i, "restock"],
  [/\b(address|moved?|relocat|zip code|ship .* (to|different)|update .* address)\b/i, "address_change"],
  [/\b(ingredient|allerg|caffeine|sugar|keto|vegan|gluten|how (do i|to) (use|take|mix|prepare)|does it (have|contain)|is it safe|dosage|serving)\b/i, "product_question"],
  [/\b(unsubscribe .*(email|text|sms|marketing)|stop (the )?(text|email|sms)|too many (email|text)|opt out)\b/i, "unsubscribe_marketing"],
  [/\b(resubscribe|reactivat|start .* again|renew|sign back up)\b/i, "reactivate"],
  [/\b(reseller|wholesale|bulk|distributor|retail)\b/i, "wholesale_reseller"],
];
// Seed intent from the handler tag that actually ran — the strongest available
// signal for "what problem was this" (this is how the tree agent hit ~6% residual).
function intentFromTags(tags: string[]): string | null {
  for (const t of tags) {
    if (t.startsWith("j:cancel")) return "cancel";
    if (t === "pb:refund") return "refund_billing_dispute";
    if (t === "pb:replacement_order") return "missing_damaged_wrong";
    if (t.startsWith("j:missing_items")) return "missing_damaged_wrong";
    if (t.startsWith("j:confirm_shipping_address")) return "address_change";
    if (t.startsWith("j:account_linking") || t.startsWith("j:account")) return "account_access";
    if (t.startsWith("j:discount") || t.includes("marketing_signup")) return "marketing_signup";
    if (t.startsWith("j:select_subscription")) return "modify_subscription";
    if (t.startsWith("crisis") || t === "payment-recovery" || t.startsWith("dunning")) return t.startsWith("crisis") ? "crisis_flavor_swap" : "payment_method";
  }
  return null;
}
function intentOf(subject: string, firstIn: string, tags: string[]): string {
  const fromTag = intentFromTags(tags);
  if (fromTag) return fromTag;
  const text = `${subject || ""} ${firstIn || ""}`;
  for (const [re, name] of INTENTS) if (re.test(text)) return name;
  if ((firstIn || "").trim().length < 12) return "greeting_or_empty";
  return "unclassified";
}

function actionName(body: string): string | null {
  const m = body.match(/^Action completed: (.*)/s);
  if (!m) return null;
  const rest = m[1];
  const snake = rest.match(/^([a-z_]+)(\s|$|:)/);
  if (snake) return snake[1];
  const map: Array<[RegExp, string]> = [
    [/^Closed ticket/i, "close_ticket"], [/^Paused/i, "pause"], [/^Enrolled in crisis/i, "crisis_enroll"],
    [/^Triggered bill_now/i, "bill_now"], [/^Reactivated/i, "reactivate"], [/^Changed next billing/i, "change_next_date"],
    [/^Swapped/i, "swap_variant"], [/^Applied loyalty/i, "apply_loyalty_coupon"], [/^Applied coupon/i, "apply_coupon"],
    [/^Updated base price/i, "update_line_item_price"], [/^Changed quantity/i, "change_quantity"], [/^Resumed/i, "resume"],
    [/^Removed (item|\d+ line)/i, "remove_item"], [/address updated/i, "update_shipping_address"], [/^Return created/i, "create_return"],
    [/^Refund/i, "partial_refund"], [/^Replacement order/i, "create_replacement_order"], [/^Skipped next/i, "skip_next_order"],
    [/^Changed (billing )?frequency/i, "change_frequency"], [/^Cancelled/i, "cancel"], [/^Redeemed/i, "redeem_points"],
    [/^Added item/i, "add_item"], [/^Linked account/i, "link_account_by_email"], [/^Switched payment/i, "switch_payment_method"],
  ];
  for (const [re, name] of map) if (re.test(rest)) return name;
  return "other_action";
}

const pctVol = (n: number, d: number) => `${((n / d) * 100).toFixed(1)}%`;

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    const tickets = (await c.query(`
      select t.id, t.subject, t.tags, t.handled_by
      from tickets t where t.merged_into is null
        and t.created_at >= now() - interval '120 days'`)).rows;
    const firstIn = new Map((await c.query(`
      select distinct on (ticket_id) ticket_id, left(body,700) as body
      from ticket_messages where author_type='customer' and direction='inbound'
      order by ticket_id, created_at asc`)).rows.map((r: any) => [r.ticket_id, r.body]));
    const notes = (await c.query(`
      select ticket_id, body, created_at from ticket_messages
      where author_type='system' and body like 'Action completed:%'
      order by ticket_id, created_at asc`)).rows;
    const actByTicket = new Map<string, string[]>();
    for (const n of notes as any[]) {
      const a = actionName(n.body); if (!a) continue;
      (actByTicket.get(n.ticket_id) || actByTicket.set(n.ticket_id, []).get(n.ticket_id)!).push(a);
    }
    const aiTurns = new Map((await c.query(`
      select ticket_id, count(*)::int n from ticket_messages
      where author_type='ai' and direction='outbound' and visibility='external'
      group by ticket_id`)).rows.map((r: any) => [r.ticket_id, r.n]));

    // Clean inbound cohort: has a real customer inbound, not spam/outreach.
    const clean = tickets.filter((t: any) => {
      const tags: string[] = t.tags || [];
      if (tags.some(x => x === "spam" || x.startsWith("cls:outreach"))) return false;
      if (!firstIn.has(t.id)) return false; // pure outbound campaign tickets
      return true;
    });

    const problemSig = new Map<string, string>();
    const midSig = new Map<string, string>();
    const fullSig = new Map<string, string>();
    for (const t of clean as any[]) {
      const intent = intentOf(t.subject, firstIn.get(t.id) || "", t.tags || []);
      const acts = actByTicket.get(t.id) || [];
      const primary = acts[0] || "-";
      const turnB = (aiTurns.get(t.id) || 0) >= 3 ? "t3+" : `t${aiTurns.get(t.id) || 0}`;
      problemSig.set(t.id, intent);
      midSig.set(t.id, `${intent}|${primary}`);
      fullSig.set(t.id, `${intent}|${acts.join(">") || "-"}|${turnB}`);
    }

    const total = clean.length;
    const rarityAt = (m: Map<string, string>, label: string) => {
      const counts: Record<string, number> = {};
      for (const s of m.values()) counts[s] = (counts[s] || 0) + 1;
      const distinct = Object.keys(counts).length;
      let vol1 = 0, vol3 = 0;
      for (const s of m.values()) { if (counts[s] === 1) vol1++; if (counts[s] <= 3) vol3++; }
      console.log(`  ${label.padEnd(34)} distinct=${String(distinct).padStart(4)}  singleton_vol=${pctVol(vol1, total).padStart(6)}  ≤3_vol=${pctVol(vol3, total).padStart(6)}`);
      return counts;
    };

    console.log(`\nClean inbound cohort: ${total} tickets (120d)\n`);
    console.log("Path rarity by grain (% of VOLUME on paths seen 1× and ≤3×):");
    const pCounts = rarityAt(problemSig, "problem (intent only)");
    rarityAt(midSig, "mid (intent × primary action)");
    const fCounts = rarityAt(fullSig, "full (intent × action seq × turns)");

    // Intent distribution + unclassified floor
    console.log("\nProblem-grain (intent) distribution:");
    for (const [k, v] of Object.entries(pCounts).sort((a, b) => b[1] - a[1]))
      console.log(`  ${k.padEnd(26)} ${String(v).padStart(4)}  ${pctVol(v, total)}`);
    const trulyNovelFloor = (pCounts["unclassified"] || 0);
    console.log(`\n"Truly can't bucket it" floor (unclassified intent): ${trulyNovelFloor} = ${pctVol(trulyNovelFloor, total)}`);

    // THE DECOMPOSITION: of tickets on a RARE full path (≤3), is the PROBLEM common or novel?
    const COMMON_INTENT_MIN = 10; // an intent with >=10 tickets in 120d is a well-established problem
    const commonIntents = new Set(Object.entries(pCounts).filter(([k, v]) => v >= COMMON_INTENT_MIN && k !== "unclassified" && k !== "greeting_or_empty").map(([k]) => k));
    let rareFull = 0, rareFull_commonProblem = 0, rareFull_novelProblem = 0;
    for (const t of clean as any[]) {
      if (fCounts[fullSig.get(t.id)!] > 3) continue;
      rareFull++;
      if (commonIntents.has(problemSig.get(t.id)!)) rareFull_commonProblem++;
      else rareFull_novelProblem++;
    }
    console.log(`\n=== DECOMPOSITION of the rare-full-path bucket ===`);
    console.log(`Tickets on a full path seen ≤3×:        ${rareFull}  (${pctVol(rareFull, total)} of volume)`);
    console.log(`  ...of a COMMON problem (compilable improvisation): ${rareFull_commonProblem}  (${pctVol(rareFull_commonProblem, total)} of ALL volume, ${pctVol(rareFull_commonProblem, rareFull)} of the rare bucket)`);
    console.log(`  ...of a NOVEL/rare problem (truly unique):          ${rareFull_novelProblem}  (${pctVol(rareFull_novelProblem, total)} of ALL volume, ${pctVol(rareFull_novelProblem, rareFull)} of the rare bucket)`);
    console.log(`\nCommon intents (≥${COMMON_INTENT_MIN} tickets): ${[...commonIntents].join(", ")}`);
  } finally { await c.end(); }
}
main().catch(e => { console.error(e); process.exit(1); });
