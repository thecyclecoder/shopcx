// READ-ONLY: unit economics of cheap vs expensive AI paths + cancel reply-only samples.
import { pgClient } from "./_bootstrap";

const PRICING: Record<string, { input: number; output: number; cacheRead: number }> = {
  "claude-sonnet-4-6": { input: 0.3, output: 1.5, cacheRead: 0.03 },
  "claude-sonnet-4-20250514": { input: 0.3, output: 1.5, cacheRead: 0.03 },
  "claude-sonnet-4": { input: 0.3, output: 1.5, cacheRead: 0.03 },
  "claude-haiku-4-5-20251001": { input: 0.1, output: 0.5, cacheRead: 0.01 },
  "claude-haiku-4-5": { input: 0.1, output: 0.5, cacheRead: 0.01 },
  "claude-opus-4-7": { input: 1.5, output: 7.5, cacheRead: 0.15 },
};

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    // per-purpose totals with cost computed in SQL via CASE (mirror pricing)
    const rows = (await c.query(`
      select split_part(purpose, ':', 1) as head, model,
             count(*) as calls,
             sum(input_tokens) as inp, sum(output_tokens) as outp,
             sum(cache_creation_tokens) as cc, sum(cache_read_tokens) as cr
      from ai_token_usage
      group by 1,2 order by 1`)).rows;
    const agg = new Map<string, { calls: number; cents: number }>();
    let grand = 0;
    for (const r of rows) {
      const p = PRICING[r.model] || PRICING["claude-sonnet-4-6"];
      const cents = (r.inp / 1000) * p.input + (r.outp / 1000) * p.output +
        (r.cr / 1000) * p.cacheRead + (r.cc / 1000) * p.input * 1.25;
      grand += cents;
      const key = r.head || "<null>";
      const e = agg.get(key) || { calls: 0, cents: 0 };
      e.calls += Number(r.calls); e.cents += cents; agg.set(key, e);
    }
    console.log("== per-purpose cost (all time) ==");
    for (const [k, v] of [...agg.entries()].sort((a, b) => b[1].cents - a[1].cents).slice(0, 22))
      console.log(`${k.padEnd(32)} calls=${String(v.calls).padStart(6)} $${(v.cents / 100).toFixed(2).padStart(9)}  avg/call $${(v.cents / v.calls / 100).toFixed(4)}`);
    console.log(`GRAND TOTAL $${(grand / 100).toFixed(2)}`);

    // orchestrator cost by model
    const om = (await c.query(`
      select model, count(*) as calls, sum(input_tokens) as inp, sum(output_tokens) as outp,
             sum(cache_creation_tokens) as cc, sum(cache_read_tokens) as cr
      from ai_token_usage where purpose like 'orchestrator-decision%'
      group by 1`)).rows;
    console.log("\n== orchestrator by model ==");
    for (const r of om) {
      const p = PRICING[r.model] || PRICING["claude-sonnet-4-6"];
      const cents = (r.inp / 1000) * p.input + (r.outp / 1000) * p.output + (r.cr / 1000) * p.cacheRead + (r.cc / 1000) * p.input * 1.25;
      console.log(`${r.model}  calls=${r.calls}  $${(cents / 100).toFixed(2)}  avg/call $${(cents / r.calls / 100).toFixed(3)}`);
    }

    // sample cancel reply-only tickets: what did the AI say / what happened?
    const samples = (await c.query(`
      select t.id, t.subject, t.status, t.channel,
        (select string_agg(left(m.body, 110), ' >>> ' order by m.created_at)
         from (select body, created_at from ticket_messages m
               where m.ticket_id = t.id order by m.created_at limit 6) m) as flow
      from tickets t
      where t.merged_into is null and t.id in (
        '441fe828-f8a8-4cb3-96fe-cf75d297b6e4','8a5e254c-aa36-4124-a6ce-2d00b869091c')`)).rows;
    console.log("\n== cancel reply-only samples ==");
    for (const s of samples) console.log(`--- ${s.id} [${s.channel}/${s.status}] ${s.subject}\n${s.flow}\n`);
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
