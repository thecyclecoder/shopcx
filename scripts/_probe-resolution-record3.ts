/** READ-ONLY reconciliation: ticket_analyses coverage denominator + journey session ticket linkage. */
import { pgClient } from "./_bootstrap";
async function main() {
  const c = pgClient(); await c.connect();
  try {
    const q = async (l: string, s: string) => { const r = await c.query(s); console.log(`\n== ${l} ==`); console.table(r.rows); };
    await q("analyses per closed-ticket population, split by AI-touched", `
      WITH pop AS (
        SELECT t.id,
          ('ai' = ANY(t.tags) OR EXISTS (SELECT 1 FROM ticket_messages m WHERE m.ticket_id=t.id AND m.author_type='ai')) AS ai_touched
        FROM tickets t
        WHERE t.created_at >= now() - interval '60 days' AND t.status='closed' AND t.merged_into IS NULL)
      SELECT ai_touched, count(*) AS n,
        count(*) FILTER (WHERE EXISTS (SELECT 1 FROM ticket_analyses a WHERE a.ticket_id=pop.id)) AS with_analysis
      FROM pop GROUP BY 1
    `);
    await q("where do 60d analyses' tickets come from", `
      SELECT count(*) AS analyses_60d,
        count(*) FILTER (WHERE t.status='closed') AS on_closed,
        count(*) FILTER (WHERE t.created_at >= now() - interval '60 days') AS ticket_created_60d
      FROM ticket_analyses a JOIN tickets t ON t.id=a.ticket_id
      WHERE a.created_at >= now() - interval '60 days'
    `);
    await q("60d journey sessions: their tickets' status", `
      SELECT t.status, count(*) FROM journey_sessions js JOIN tickets t ON t.id=js.ticket_id
      WHERE js.created_at >= now() - interval '60 days' GROUP BY 1 ORDER BY 2 DESC
    `);
    await q("commerce call log volume (30d)", `
      SELECT count(*) AS calls, count(*) FILTER (WHERE ticket_id IS NOT NULL) AS with_ticket
      FROM commerce_call_log WHERE created_at >= now() - interval '30 days'
    `);
  } finally { await c.end(); }
}
main().catch(e => { console.error(e); process.exit(1); });
