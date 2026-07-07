/** READ-ONLY follow-up probe: ft: tag values, ticket_analyses trigger/shape, ai_token_usage purposes, playbook residual state, journey↔ticket overlap. */
import { pgClient } from "./_bootstrap";

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    const q = async (label: string, sql: string) => {
      const r = await c.query(sql);
      console.log(`\n== ${label} ==`);
      console.table(r.rows);
    };

    await q("ft: tag values (60d closed)", `
      SELECT tg, count(*) FROM tickets t, unnest(t.tags) tg
      WHERE t.created_at >= now() - interval '60 days' AND t.status='closed' AND t.merged_into IS NULL
        AND tg LIKE 'ft:%' GROUP BY 1 ORDER BY 2 DESC LIMIT 10
    `);

    await q("ticket_analyses trigger values (90d)", `
      SELECT trigger, count(*), max(created_at) AS latest
      FROM ticket_analyses WHERE created_at >= now() - interval '90 days'
      GROUP BY 1 ORDER BY 2 DESC
    `);

    await q("ticket_analyses sample issues/action_items shape", `
      SELECT score, left(summary, 100) AS summary, left(issues::text, 160) AS issues, left(action_items::text, 120) AS action_items
      FROM ticket_analyses WHERE created_at >= now() - interval '30 days'
      ORDER BY created_at DESC LIMIT 5
    `);

    await q("ai_token_usage purpose distribution (30d)", `
      SELECT split_part(purpose, ':round', 1) AS purpose_base, count(*)
      FROM ai_token_usage WHERE created_at >= now() - interval '30 days' AND purpose LIKE 'orchestrator%'
      GROUP BY 1 ORDER BY 2 DESC LIMIT 12
    `);

    await q("residual playbook state on closed tickets (60d)", `
      SELECT
        count(*) FILTER (WHERE playbook_context::text <> '{}') AS nonempty_playbook_context,
        count(*) FILTER (WHERE active_playbook_id IS NOT NULL) AS active_playbook_still_set,
        count(*) FILTER (WHERE journey_data::text <> '{}') AS nonempty_journey_data
      FROM tickets t
      WHERE t.created_at >= now() - interval '60 days' AND t.status='closed' AND t.merged_into IS NULL
    `);

    await q("journey_data sample (closed, nonempty)", `
      SELECT left(journey_data::text, 220) AS jd FROM tickets
      WHERE created_at >= now() - interval '60 days' AND status='closed' AND merged_into IS NULL
        AND journey_data::text <> '{}' ORDER BY created_at DESC LIMIT 4
    `);

    await q("playbook_context sample (closed, nonempty)", `
      SELECT left(playbook_context::text, 260) AS pc FROM tickets
      WHERE created_at >= now() - interval '60 days' AND status='closed' AND merged_into IS NULL
        AND playbook_context::text <> '{}' ORDER BY created_at DESC LIMIT 4
    `);

    await q("journey_sessions responses sample (with outcome)", `
      SELECT outcome, left(responses::text, 220) AS responses
      FROM journey_sessions WHERE created_at >= now() - interval '60 days' AND outcome IS NOT NULL
      ORDER BY created_at DESC LIMIT 5
    `);

    // Of AI-touched closed tickets, how many have a journey session w/ outcome?
    await q("AI-touched closed x journey session overlap (60d)", `
      WITH pop AS (
        SELECT t.id FROM tickets t
        WHERE t.created_at >= now() - interval '60 days' AND t.status='closed' AND t.merged_into IS NULL
          AND ('ai' = ANY(t.tags) OR EXISTS (SELECT 1 FROM ticket_messages m WHERE m.ticket_id=t.id AND m.author_type='ai'))
      )
      SELECT
        (SELECT count(*) FROM pop) AS ai_touched,
        count(DISTINCT p.id) FILTER (WHERE js.id IS NOT NULL) AS has_session,
        count(DISTINCT p.id) FILTER (WHERE js.outcome IS NOT NULL) AS has_session_outcome
      FROM pop p LEFT JOIN journey_sessions js ON js.ticket_id = p.id
    `);
  } finally {
    await c.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
