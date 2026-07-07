/** READ-ONLY corrected coverage: resolved = closed OR archived, merged_into IS NULL, 60d. */
import { pgClient } from "./_bootstrap";
async function main() {
  const c = pgClient(); await c.connect();
  try {
    const q = async (l: string, s: string) => { const r = await c.query(s); console.log(`\n== ${l} ==`); console.table(r.rows); };
    const base = `FROM tickets t WHERE t.created_at >= now() - interval '60 days' AND t.status IN ('closed','archived') AND t.merged_into IS NULL`;
    await q("population + tag coverage (resolved 60d)", `
      SELECT count(*) AS total,
        count(*) FILTER (WHERE EXISTS (SELECT 1 FROM unnest(t.tags) tg WHERE tg LIKE 'cls:%')) AS has_cls,
        count(*) FILTER (WHERE EXISTS (SELECT 1 FROM unnest(t.tags) tg WHERE tg LIKE 'j:%')) AS has_j,
        count(*) FILTER (WHERE EXISTS (SELECT 1 FROM unnest(t.tags) tg WHERE tg LIKE 'pb:%')) AS has_pb,
        count(*) FILTER (WHERE EXISTS (SELECT 1 FROM unnest(t.tags) tg WHERE tg LIKE 'w:%')) AS has_w,
        count(*) FILTER (WHERE t.ai_detected_intent IS NOT NULL) AS vestigial_intent,
        count(*) FILTER (WHERE t.ai_turn_count > 0) AS vestigial_turns
      ${base}`);
    await q("AI-touched resolved: record fragments", `
      WITH pop AS (
        SELECT t.id ${base}
          AND ('ai' = ANY(t.tags) OR EXISTS (SELECT 1 FROM ticket_messages m WHERE m.ticket_id=t.id AND m.author_type='ai')))
      SELECT (SELECT count(*) FROM pop) AS ai_touched,
        count(DISTINCT p.id) FILTER (WHERE m.body LIKE '[System] Sonnet:%' OR m.body LIKE '[System] Opus:%') AS has_decision_note,
        count(DISTINCT p.id) FILTER (WHERE m.body LIKE 'Action completed:%') AS has_action_completed,
        count(DISTINCT p.id) FILTER (WHERE m.body LIKE 'Action failed:%') AS has_action_failed
      FROM pop p JOIN ticket_messages m ON m.ticket_id = p.id AND m.author_type='system' AND m.visibility='internal'`);
    await q("AI-touched resolved: analysis + journey coverage", `
      WITH pop AS (
        SELECT t.id ${base}
          AND ('ai' = ANY(t.tags) OR EXISTS (SELECT 1 FROM ticket_messages m WHERE m.ticket_id=t.id AND m.author_type='ai')))
      SELECT (SELECT count(*) FROM pop) AS ai_touched,
        count(DISTINCT p.id) FILTER (WHERE a.id IS NOT NULL) AS has_analysis,
        count(DISTINCT p.id) FILTER (WHERE js.id IS NOT NULL) AS has_journey_session,
        count(DISTINCT p.id) FILTER (WHERE js.outcome IS NOT NULL) AS has_journey_outcome
      FROM pop p
      LEFT JOIN ticket_analyses a ON a.ticket_id = p.id
      LEFT JOIN journey_sessions js ON js.ticket_id = p.id`);
    await q("cls tag distribution (resolved 60d)", `
      SELECT tg, count(*) FROM tickets t, unnest(t.tags) tg
      WHERE t.created_at >= now() - interval '60 days' AND t.status IN ('closed','archived') AND t.merged_into IS NULL
        AND tg LIKE 'cls:%' GROUP BY 1 ORDER BY 2 DESC`);
  } finally { await c.end(); }
}
main().catch(e => { console.error(e); process.exit(1); });
