/**
 * Probe 4 — problem lock-in research: transcripts for misread candidates,
 * remaining clarification exchanges, denominators. READ-ONLY.
 */
import { pgClient } from "./_bootstrap";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

const MISREAD_TICKETS = [
  "82008b43-89bb-49b8-975b-821c5a7a8dcf",
  "b50a02c9-c653-4da0-ae66-e817450c4914",
  "525b1920-607d-4820-94d4-5cbe9fbbbe40",
  "1499ae6b-607e-424a-9e4d-30a4caca056f",
  "456d3fe5-1a38-403d-9abf-3337a24d01b0",
  "a1a13be5-902b-4e77-ad98-c8c991f1a800",
  "85965f9c-4012-477b-9f17-574641d31e60",
  "08dba9c1-2ebf-47d5-b676-ea4431243bbc", // over-clarify example check
  "36f7664d-9be9-4ddb-8533-956d93d768fb", // which-order despite SC number given
];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    const q = async (label: string, sql: string, params: unknown[] = []) => {
      const r = await c.query(sql, params);
      console.log(`\n=== ${label} (${r.rowCount} rows) ===`);
      console.log(JSON.stringify(r.rows, null, 1).slice(0, 16000));
    };

    // Denominators
    await q(
      "denominators",
      `select
        (select count(distinct ticket_id) from ticket_analyses) as analyzed_tickets,
        (select count(distinct t.id) from tickets t join ticket_messages m on m.ticket_id=t.id
          and m.author_type='ai' and m.direction='outbound' and m.visibility='external'
          where t.merged_into is null and t.created_at >= '2026-05-01') as ai_tickets_since_may,
        (select count(distinct m.ticket_id) from ticket_messages m
          join tickets t on t.id=m.ticket_id and t.merged_into is null
          where m.author_type='system' and m.body like 'Action completed:%'
          and m.body not like '%Closed ticket%' and m.body not like '%Deactivated ticket%'
          and m.created_at >= '2026-05-01') as action_tickets_since_may`
    );

    // Transcripts
    for (const tid of MISREAD_TICKETS) {
      await q(
        `transcript ${tid.slice(0, 8)}`,
        `select to_char(m.created_at, 'MM-DD HH24:MI') as at, m.author_type as who, m.direction as dir, m.visibility as vis,
                left(regexp_replace(coalesce(m.body_clean, m.body), '\\s+',' ','g'), 280) as body
         from ticket_messages m where m.ticket_id = $1
         order by m.created_at limit 30`,
        [tid]
      );
    }

    // Remaining narrow clarification exchanges (older ones)
    await q(
      "narrow clarification exchanges (older, offset 40)",
      `select m.ticket_id,
              left(regexp_replace((
                select coalesce(p.body_clean,p.body) from ticket_messages p
                where p.ticket_id=m.ticket_id and p.author_type='customer' and p.created_at < m.created_at
                order by p.created_at desc limit 1), '\\s+',' ','g'), 240) as customer_before,
              left(regexp_replace(coalesce(m.body_clean,m.body), '\\s+',' ','g'), 160) as ai_clarify
       from ticket_messages m
       join tickets t on t.id = m.ticket_id and t.merged_into is null and t.workspace_id = $1
       where m.author_type='ai' and m.direction='outbound' and m.visibility='external'
         and lower(coalesce(m.body_clean, m.body)) ~ '(which (one|order|subscription|flavor|product|item|email|account|address) (are|do|did|is|was|would)|are you referring to|can you (confirm|clarify|tell me which)|could you (confirm|clarify|tell me which|let me know which)|just to (make sure i understand|clarify)|did you mean|what (is|was) the (issue|problem)|what can i (help|assist)|how can i help)'
       order by m.created_at desc
       offset 40 limit 40`,
      [WS]
    );
  } finally {
    await c.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
