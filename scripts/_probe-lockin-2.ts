/**
 * Probe 2 — problem lock-in research: misread + over-clarify candidates.
 * READ-ONLY.
 */
import { pgClient } from "./_bootstrap";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    const q = async (label: string, sql: string, params: unknown[] = []) => {
      const r = await c.query(sql, params);
      console.log(`\n=== ${label} (${r.rowCount} rows) ===`);
      console.log(JSON.stringify(r.rows, null, 1).slice(0, 12000));
    };

    // Denominator: tickets with a REAL account action (exclude ticket housekeeping)
    await q(
      "tickets with real AI actions (denominator)",
      `select count(distinct m.ticket_id) as action_tickets,
              count(*) as action_notes
       from ticket_messages m
       join tickets t on t.id = m.ticket_id and t.merged_into is null and t.workspace_id = $1
       where m.author_type='system' and m.body like 'Action completed:%'
         and m.body not like 'Action completed: Closed ticket%'
         and m.body not like 'Action completed: Deactivated ticket%'`,
      [WS]
    );

    // Misread candidates: real action note, then LATER customer inbound with corrective language
    await q(
      "misread candidates (action then corrective customer reply)",
      `with actions as (
        select m.ticket_id, min(m.created_at) as first_action_at
        from ticket_messages m
        join tickets t on t.id = m.ticket_id and t.merged_into is null and t.workspace_id = $1
        where m.author_type='system' and m.body like 'Action completed:%'
          and m.body not like 'Action completed: Closed ticket%'
          and m.body not like 'Action completed: Deactivated ticket%'
        group by m.ticket_id
      )
      select a.ticket_id, t.subject,
             left(regexp_replace(cm.body_clean, '\\s+', ' ', 'g'), 200) as customer_reply,
             cm.created_at
      from actions a
      join tickets t on t.id = a.ticket_id
      join ticket_messages cm on cm.ticket_id = a.ticket_id
        and cm.author_type='customer' and cm.direction='inbound'
        and cm.created_at > a.first_action_at
      where lower(coalesce(cm.body_clean, cm.body)) ~ '(not what i (asked|meant|wanted|requested)|didn.t ask|did not ask|never asked|you misunderstood|that.s not (what|right|correct)|that is not (what|right|correct)|i meant|instead i|no[,!] i (said|asked|want|meant)|wrong (item|order|subscription|flavor|product)|undo|reverse th|put it back|change it back|don.t want that|i didn.t want)'
      order by cm.created_at desc
      limit 60`,
      [WS]
    );

    // Issue samples: inaccuracy / missed_opportunity / false_promise / drift — see what they actually describe
    await q(
      "issue samples by type",
      `select ta.ticket_id, issue->>'type' as type,
              left(regexp_replace(issue->>'description', '\\s+', ' ', 'g'), 220) as descr,
              ta.score
       from ticket_analyses ta, jsonb_array_elements(ta.issues) issue
       where issue->>'type' in ('inaccuracy','missed_opportunity','false_promise','drift','broken_action')
       order by random()
       limit 40`
    );

    // Clarifying-question AI messages
    await q(
      "AI clarifying-question turns (candidates)",
      `select count(*) as clar_msgs, count(distinct m.ticket_id) as clar_tickets
       from ticket_messages m
       join tickets t on t.id = m.ticket_id and t.merged_into is null and t.workspace_id = $1
       where m.author_type='ai' and m.direction='outbound' and m.visibility='external'
         and lower(coalesce(m.body_clean, m.body)) ~ '(just to (confirm|make sure|clarify)|to confirm[,:]|can you confirm|could you (confirm|clarify|let me know which)|which (subscription|order|flavor|product|item|one) (do|did|would|are|were)|did you mean|are you (looking|asking|trying|wanting)|do you want me to|would you like me to|so i (can )?(get|make) (this|sure)|want me to)'`,
      [WS]
    );

    // sample clarifying turns with the customer message BEFORE them (to judge necessity)
    await q(
      "sample clarifying exchanges",
      `select m.ticket_id,
              left(regexp_replace((
                select coalesce(p.body_clean,p.body) from ticket_messages p
                where p.ticket_id=m.ticket_id and p.author_type='customer' and p.created_at < m.created_at
                order by p.created_at desc limit 1), '\\s+',' ','g'), 260) as customer_before,
              left(regexp_replace(coalesce(m.body_clean,m.body), '\\s+',' ','g'), 260) as ai_clarify
       from ticket_messages m
       join tickets t on t.id = m.ticket_id and t.merged_into is null and t.workspace_id = $1
       where m.author_type='ai' and m.direction='outbound' and m.visibility='external'
         and lower(coalesce(m.body_clean, m.body)) ~ '(just to (confirm|make sure|clarify)|to confirm[,:]|can you confirm|could you (confirm|clarify|let me know which)|which (subscription|order|flavor|product|item|one) (do|did|would|are|were)|did you mean|are you (looking|asking|trying|wanting)|do you want me to|would you like me to)'
       order by random()
       limit 25`,
      [WS]
    );
  } finally {
    await c.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
