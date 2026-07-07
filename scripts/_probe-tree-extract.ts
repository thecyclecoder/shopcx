// READ-ONLY: extract per-ticket features for the tree-hypothesis study → JSONL in scratchpad.
import { pgClient } from "./_bootstrap";
import { writeFileSync } from "fs";

const OUT = "/private/tmp/claude-501/-Users-admin-Projects-shopcx/57cce165-d0bb-485b-8710-a739b07da08c/scratchpad/tickets.jsonl";

// cents per 1K tokens — mirror of src/lib/ai-usage.ts PRICING
const PRICING: Record<string, { input: number; output: number; cacheRead: number }> = {
  "claude-sonnet-4-6": { input: 0.3, output: 1.5, cacheRead: 0.03 },
  "claude-sonnet-4-20250514": { input: 0.3, output: 1.5, cacheRead: 0.03 },
  "claude-sonnet-4": { input: 0.3, output: 1.5, cacheRead: 0.03 },
  "claude-haiku-4-5-20251001": { input: 0.1, output: 0.5, cacheRead: 0.01 },
  "claude-haiku-4-5": { input: 0.1, output: 0.5, cacheRead: 0.01 },
  "claude-opus-4-7": { input: 1.5, output: 7.5, cacheRead: 0.15 },
};
function costCents(model: string, r: { input_tokens: number; output_tokens: number; cache_creation_tokens: number; cache_read_tokens: number }) {
  const p = PRICING[model] || PRICING["claude-sonnet-4-6"];
  return (r.input_tokens / 1000) * p.input + (r.output_tokens / 1000) * p.output +
    (r.cache_read_tokens / 1000) * p.cacheRead + (r.cache_creation_tokens / 1000) * p.input * 1.25;
}

function normalizeActionNote(body: string): string | null {
  const m = body.match(/^Action (completed|failed): (.*)/s);
  if (!m) return null;
  const rest = m[2];
  const snake = rest.match(/^([a-z_]+)(\s|$|:)/);
  if (snake) return snake[1];
  const map: Array<[RegExp, string]> = [
    [/^Closed ticket/i, "close_ticket"],
    [/^Paused subscription/i, "pause"],
    [/^Enrolled in crisis/i, "crisis_enroll"],
    [/^Triggered bill_now/i, "bill_now"],
    [/^Reactivated subscription/i, "reactivate"],
    [/^Changed next billing date/i, "change_next_date"],
    [/^Swapped (variant|item)/i, "swap_variant"],
    [/^Deactivated ticket/i, "deactivate_ticket"],
    [/^Applied coupon/i, "apply_coupon"],
    [/^Applied loyalty/i, "apply_loyalty_coupon"],
    [/^Updated base price/i, "update_line_item_price"],
    [/^Changed quantity/i, "change_quantity"],
    [/^Resumed subscription/i, "resume"],
    [/^Removed item/i, "remove_item"],
    [/address updated/i, "update_shipping_address"],
    [/^Return created/i, "create_return"],
    [/^Refund(ed)?\b/i, "partial_refund"],
    [/^Replacement order/i, "create_replacement_order"],
    [/^Skipped next/i, "skip_next_order"],
    [/^Changed (billing )?frequency/i, "change_frequency"],
    [/^Cancelled subscription/i, "cancel"],
    [/^Redeemed/i, "redeem_points"],
    [/^Added item/i, "add_item"],
    [/^Linked account/i, "link_account_by_email"],
    [/^Updated (customer|name|phone|email)/i, "update_customer_info"],
    [/^(Unsubscribed|Marketing)/i, "unsubscribe_marketing"],
    [/^Switched payment/i, "switch_payment_method"],
    [/^Subscription .* paused/i, "pause"],
    [/^Partial refund of \$/i, "partial_refund"],
    [/^Paused for \d+ days/i, "pause_timed"],
    [/^Rejected link suggestion/i, "reject_account_link"],
    [/^Removed \d+ line/i, "remove_item"],
    [/^Removed coupon/i, "remove_coupon"],
    [/^Flipped auto_readd/i, "crisis_set_auto_readd"],
  ];
  for (const [re, name] of map) if (re.test(rest)) return name;
  return "other:" + rest.slice(0, 30).replace(/\s+/g, "_");
}

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    const tickets = (await c.query(`
      select t.id, t.created_at, t.channel, t.status, t.subject, t.tags,
             t.handled_by, t.agent_intervened, t.customer_id
      from tickets t where t.merged_into is null
      order by t.created_at asc`)).rows;

    // first customer inbound per ticket
    const firstIn = (await c.query(`
      select distinct on (ticket_id) ticket_id, left(body, 700) as body
      from ticket_messages
      where author_type='customer' and direction='inbound'
      order by ticket_id, created_at asc`)).rows;
    const firstInMap = new Map(firstIn.map((r: any) => [r.ticket_id, r.body]));

    // message-derived signals per ticket
    const msgs = (await c.query(`
      select ticket_id, author_type, direction, visibility, left(body, 200) as body
      from ticket_messages
      where (author_type='system' and visibility='internal')
         or (author_type='ai' and direction='outbound' and visibility='external')
         or (author_type='agent' and direction='outbound' and visibility='external')
         or (author_type='customer' and direction='inbound')
      order by ticket_id, created_at asc`)).rows;

    const byTicket = new Map<string, any[]>();
    for (const m of msgs) {
      let a = byTicket.get(m.ticket_id); if (!a) byTicket.set(m.ticket_id, (a = []));
      a.push(m);
    }

    // journeys per ticket
    const js = (await c.query(`
      select js.ticket_id, jd.name, js.status
      from journey_sessions js join journey_definitions jd on jd.id = js.journey_id
      where js.ticket_id is not null`)).rows;
    const jMap = new Map<string, string[]>();
    for (const r of js) {
      let a = jMap.get(r.ticket_id); if (!a) jMap.set(r.ticket_id, (a = []));
      a.push(r.name);
    }

    // cost per ticket
    const usage = (await c.query(`
      select ticket_id, model, purpose,
             sum(input_tokens)::bigint as input_tokens, sum(output_tokens)::bigint as output_tokens,
             sum(cache_creation_tokens)::bigint as cache_creation_tokens, sum(cache_read_tokens)::bigint as cache_read_tokens,
             count(*) as calls
      from ai_token_usage where ticket_id is not null
      group by 1,2,3`)).rows;
    const costMap = new Map<string, { total: number; orch: number; opusOrch: number; calls: number; orchCalls: number }>();
    for (const u of usage) {
      const cents = costCents(u.model, {
        input_tokens: Number(u.input_tokens), output_tokens: Number(u.output_tokens),
        cache_creation_tokens: Number(u.cache_creation_tokens), cache_read_tokens: Number(u.cache_read_tokens),
      });
      let e = costMap.get(u.ticket_id);
      if (!e) costMap.set(u.ticket_id, (e = { total: 0, orch: 0, opusOrch: 0, calls: 0, orchCalls: 0 }));
      e.total += cents; e.calls += Number(u.calls);
      if (String(u.purpose || "").startsWith("orchestrator-decision")) {
        e.orch += cents; e.orchCalls += Number(u.calls);
        if (String(u.model).includes("opus")) e.opusOrch += cents;
      }
    }

    const lines: string[] = [];
    for (const t of tickets) {
      const tm = byTicket.get(t.id) || [];
      const decisions: string[] = [];
      const actions: string[] = [];
      let escalated = false, positiveClose = false, aiTurns = 0, agentTurns = 0, custTurns = 0;
      const models = new Set<string>();
      for (const m of tm) {
        if (m.author_type === "ai" && m.visibility === "external") aiTurns++;
        else if (m.author_type === "agent" && m.visibility === "external") agentTurns++;
        else if (m.author_type === "customer") custTurns++;
        else if (m.author_type === "system") {
          const d = m.body.match(/^\[System\] (Opus|Sonnet): ([a-z_]+) —/);
          if (d) { decisions.push(d[2]); models.add(d[1].toLowerCase()); }
          const om = m.body.match(/^\[System\] Orchestrator model: (opus|sonnet)/);
          if (om) models.add(om[1]);
          if (/^\[System\] Ticket escalated/.test(m.body) || /escalat/i.test(m.body) && /^\[Auto-Analysis\]/.test(m.body)) escalated = true;
          if (/^\[System\] Positive close/.test(m.body)) positiveClose = true;
          const a = normalizeActionNote(m.body);
          if (a) actions.push(a);
        }
      }
      const cost = costMap.get(t.id) || { total: 0, orch: 0, opusOrch: 0, calls: 0, orchCalls: 0 };
      lines.push(JSON.stringify({
        id: t.id, created_at: t.created_at, channel: t.channel, status: t.status,
        subject: t.subject, tags: t.tags || [], handled_by: t.handled_by,
        agent_intervened: t.agent_intervened,
        first_inbound: firstInMap.get(t.id) || null,
        decisions, actions, journeys: jMap.get(t.id) || [],
        escalated, positiveClose, aiTurns, agentTurns, custTurns,
        models: [...models],
        cost_total_cents: +cost.total.toFixed(3), cost_orch_cents: +cost.orch.toFixed(3),
        cost_opus_orch_cents: +cost.opusOrch.toFixed(3), ai_calls: cost.calls, orch_calls: cost.orchCalls,
      }));
    }
    writeFileSync(OUT, lines.join("\n"));
    console.log(`wrote ${lines.length} tickets → ${OUT}`);

    // sanity: unmapped action notes
    const unmapped = new Map<string, number>();
    for (const l of lines) {
      const o = JSON.parse(l);
      for (const a of o.actions) if (a.startsWith("other:")) unmapped.set(a, (unmapped.get(a) || 0) + 1);
    }
    console.log("unmapped actions:", [...unmapped.entries()].sort((x, y) => y[1] - x[1]).slice(0, 15));

    // total cost sanity
    let tot = 0, orch = 0;
    for (const l of lines) { const o = JSON.parse(l); tot += o.cost_total_cents; orch += o.cost_orch_cents; }
    console.log(`ticket-linked cost: total $${(tot / 100).toFixed(2)}, orchestrator $${(orch / 100).toFixed(2)}`);
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
