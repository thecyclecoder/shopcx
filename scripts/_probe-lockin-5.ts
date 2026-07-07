/**
 * Probe 5 — problem lock-in research: positive-close misfires, identify-ask
 * frequency over time, per-turn cost. READ-ONLY.
 */
import { pgClient } from "./_bootstrap";

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    const q = async (label: string, sql: string) => {
      const r = await c.query(sql);
      console.log(`\n=== ${label} (${r.rowCount} rows) ===`);
      console.log(JSON.stringify(r.rows, null, 1).slice(0, 9000));
    };

    // Positive-close events, and how many were followed by a customer reply within 48h (misfire proxy)
    await q(
      "positive-close then quick customer reply",
      `with pc as (
        select m.ticket_id, m.created_at
        from ticket_messages m
        where m.author_type='system' and m.body like '[System] Positive close%'
          and m.body not like '%suppressed%'
      )
      select count(*) as pc_events,
             count(*) filter (where exists (
               select 1 from ticket_messages r
               where r.ticket_id = pc.ticket_id and r.author_type='customer'
                 and r.created_at > pc.created_at
                 and r.created_at < pc.created_at + interval '48 hours'
             )) as reply_within_48h
      from pc`
    );

    await q(
      "positive-close suppressions (guard already firing)",
      `select left(body, 60) as kind, count(*) n, min(created_at)::date as first_seen
       from ticket_messages
       where author_type='system' and body like '[System] Positive close suppressed%'
       group by 1 order by n desc`
    );

    // identify-order asks vs auto-identifies over time
    await q(
      "playbook identify: asked vs auto over time",
      `select date_trunc('month', created_at)::date as mo,
        count(*) filter (where body like '%Asking customer to identify%') as asked,
        count(*) filter (where body like '%Auto-identified%' or body like '%Single order in last%' or body like '%AI matched customer message%' or body like '%Customer referenced most recent%') as auto_identified,
        count(*) filter (where body like '%Could not match customer reply%') as defaulted_after_ask
       from ticket_messages
       where author_type='system' and body like '[Playbook]%'
       group by 1 order by 1`
    );

    // Token volume per ticket (no cost column — report tokens)
    await q(
      "ai token volume per ticket (since may)",
      `select count(distinct ticket_id) as tickets,
              sum(input_tokens)::bigint as input_tok, sum(output_tokens)::bigint as output_tok,
              sum(cache_read_tokens)::bigint as cache_read_tok,
              round(sum(input_tokens+output_tokens)::numeric/nullif(count(distinct ticket_id),0)) as fresh_tok_per_ticket
       from ai_token_usage where created_at >= '2026-05-01' and ticket_id is not null`
    );

    // Time between AI clarify question and customer answer (latency cost of a turn), email vs chat
    await q(
      "median customer-reply latency after an AI turn, by channel",
      `with pairs as (
        select t.channel, m.ticket_id, m.created_at as ai_at,
          (select min(r.created_at) from ticket_messages r
            where r.ticket_id=m.ticket_id and r.author_type='customer' and r.created_at>m.created_at) as reply_at
        from ticket_messages m
        join tickets t on t.id=m.ticket_id and t.merged_into is null
        where m.author_type='ai' and m.direction='outbound' and m.visibility='external'
      )
      select channel, count(*) as n_pairs,
        round((percentile_cont(0.5) within group (order by extract(epoch from reply_at-ai_at)))::numeric/60, 1) as median_minutes
      from pairs where reply_at is not null
      group by channel order by n_pairs desc`
    );

    // Of tickets where AI asked the identify/clarify template, how many got NO customer reply ever (abandonment)
    await q(
      "abandonment after 'Which one are you referring to?'",
      `with asks as (
        select m.ticket_id, m.created_at
        from ticket_messages m
        where m.author_type='ai' and m.direction='outbound' and m.visibility='external'
          and coalesce(m.body_clean, m.body) like '%Which one are you referring to%'
      )
      select count(*) as asks,
        count(*) filter (where not exists (
          select 1 from ticket_messages r
          where r.ticket_id=asks.ticket_id and r.author_type='customer' and r.created_at > asks.created_at
        )) as never_answered
      from asks`
    );
  } finally {
    await c.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
