/**
 * Probe 1 — problem lock-in research: base stats.
 * READ-ONLY. Turn distribution, clarification-column population,
 * ticket_analyses issue-type vocabulary, action-note volume.
 */
import { pgClient } from "./_bootstrap";

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    const q = async (label: string, sql: string) => {
      const r = await c.query(sql);
      console.log(`\n=== ${label} ===`);
      console.table(r.rows);
    };

    await q("workspaces", `select id, name from workspaces`);

    await q(
      "ai_clarification columns population",
      `select
         count(*) filter (where ai_clarification_turns > 0) as clar_turns_gt0,
         count(*) filter (where ai_clarification_turn > 0) as clar_turn_gt0,
         count(*) filter (where needs_clarification) as needs_clar_true,
         count(*) as total
       from tickets where merged_into is null`
    );

    await q(
      "AI-turn distribution (tickets with >=1 real AI turn, merged out excluded)",
      `with ai_turns as (
         select t.id, count(m.id) as turns, t.status, t.created_at
         from tickets t
         join ticket_messages m on m.ticket_id = t.id
           and m.author_type = 'ai' and m.direction = 'outbound' and m.visibility = 'external'
         where t.merged_into is null
         group by t.id
       )
       select turns, count(*) as tickets,
              round(100.0*count(*)/sum(count(*)) over (), 1) as pct
       from ai_turns group by turns order by turns limit 15`
    );

    await q(
      "AI-turn totals",
      `with ai_turns as (
         select t.id, count(m.id) as turns
         from tickets t
         join ticket_messages m on m.ticket_id = t.id
           and m.author_type = 'ai' and m.direction = 'outbound' and m.visibility = 'external'
         where t.merged_into is null
         group by t.id
       )
       select count(*) as ai_tickets, sum(turns) as total_ai_turns,
              round(avg(turns),2) as avg_turns,
              percentile_cont(0.5) within group (order by turns) as median
       from ai_turns`
    );

    await q(
      "action notes volume (completed/failed) by month",
      `select date_trunc('month', created_at)::date as mo,
              count(*) filter (where body like 'Action completed:%') as completed,
              count(*) filter (where body like 'Action failed:%') as failed
       from ticket_messages
       where author_type = 'system' and (body like 'Action completed:%' or body like 'Action failed:%')
       group by 1 order by 1`
    );

    await q(
      "sample action-completed note bodies",
      `select left(body, 110) as body, count(*) as n
       from ticket_messages
       where author_type='system' and body like 'Action completed:%'
       group by 1 order by n desc limit 30`
    );

    await q(
      "ticket_analyses issue types",
      `select issue->>'type' as issue_type, count(*) as n
       from ticket_analyses, jsonb_array_elements(issues) issue
       group by 1 order by n desc limit 25`
    );

    await q(
      "ticket_analyses coverage by month + score dist",
      `select date_trunc('month', created_at)::date as mo, count(*) as analyses,
              round(avg(score),2) as avg_score,
              count(*) filter (where score <= 5) as low_score
       from ticket_analyses group by 1 order by 1`
    );
  } finally {
    await c.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
