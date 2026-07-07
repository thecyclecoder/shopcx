/**
 * READ-ONLY probe: how much of the "resolution record" is reconstructable?
 * For resolved tickets in a recent window, measure coverage of:
 *  - problem bucket: cls:* tags, j:/pb:/w:/ft: tags, escalation_reason
 *  - orchestrator reasoning system notes ("[System] Sonnet:" / "Opus:")
 *  - actions: "Action completed:" / "Action failed:" system notes
 *  - journey_sessions with outcome (structured accepted/declined)
 *  - ticket_analyses rows (paused pipeline)
 *  - vestigial: ai_detected_intent / ai_turn_count
 */
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

    // Window: last 60 days of closed, non-merged, customer tickets
    const base = `
      FROM tickets t
      WHERE t.created_at >= now() - interval '60 days'
        AND t.status = 'closed'
        AND t.merged_into IS NULL
    `;

    await q("population", `SELECT count(*) AS closed_tickets_60d ${base}`);

    await q("tag coverage on closed tickets (60d)", `
      SELECT
        count(*) AS total,
        count(*) FILTER (WHERE EXISTS (SELECT 1 FROM unnest(t.tags) tg WHERE tg LIKE 'cls:%')) AS has_cls_tag,
        count(*) FILTER (WHERE EXISTS (SELECT 1 FROM unnest(t.tags) tg WHERE tg LIKE 'j:%')) AS has_journey_tag,
        count(*) FILTER (WHERE EXISTS (SELECT 1 FROM unnest(t.tags) tg WHERE tg LIKE 'pb:%')) AS has_playbook_tag,
        count(*) FILTER (WHERE EXISTS (SELECT 1 FROM unnest(t.tags) tg WHERE tg LIKE 'w:%')) AS has_workflow_tag,
        count(*) FILTER (WHERE EXISTS (SELECT 1 FROM unnest(t.tags) tg WHERE tg LIKE 'ft:%')) AS has_ft_tag,
        count(*) FILTER (WHERE t.ai_detected_intent IS NOT NULL) AS has_ai_detected_intent,
        count(*) FILTER (WHERE t.ai_turn_count > 0) AS ai_turn_count_gt0,
        count(*) FILTER (WHERE t.escalation_reason IS NOT NULL) AS has_escalation_reason
      ${base}
    `);

    // AI-touched subset: has at least one outbound ai message OR 'ai' tag
    await q("AI-touched closed tickets (60d): decision-note & action-note coverage", `
      WITH pop AS (
        SELECT t.id ${base}
          AND ('ai' = ANY(t.tags) OR EXISTS (
            SELECT 1 FROM ticket_messages m
            WHERE m.ticket_id = t.id AND m.author_type = 'ai'
          ))
      )
      SELECT
        (SELECT count(*) FROM pop) AS ai_touched,
        count(DISTINCT p.id) FILTER (WHERE m.body LIKE '[System] Sonnet:%' OR m.body LIKE '[System] Opus:%') AS has_decision_note,
        count(DISTINCT p.id) FILTER (WHERE m.body LIKE 'Action completed:%') AS has_action_completed,
        count(DISTINCT p.id) FILTER (WHERE m.body LIKE 'Action failed:%') AS has_action_failed
      FROM pop p
      JOIN ticket_messages m ON m.ticket_id = p.id AND m.author_type = 'system' AND m.visibility = 'internal'
    `);

    await q("journey_sessions structured-outcome coverage (60d)", `
      SELECT
        count(*) AS sessions,
        count(*) FILTER (WHERE ticket_id IS NOT NULL) AS tied_to_ticket,
        count(*) FILTER (WHERE outcome IS NOT NULL) AS has_outcome,
        count(*) FILTER (WHERE outcome_action_taken) AS outcome_action_taken,
        count(*) FILTER (WHERE responses::text <> '{}') AS has_responses
      FROM journey_sessions
      WHERE created_at >= now() - interval '60 days'
    `);

    await q("distinct journey outcomes (60d)", `
      SELECT outcome, count(*) FROM journey_sessions
      WHERE created_at >= now() - interval '60 days'
      GROUP BY 1 ORDER BY 2 DESC LIMIT 15
    `);

    await q("ticket_analyses recency", `
      SELECT date_trunc('month', created_at) AS month, count(*)
      FROM ticket_analyses GROUP BY 1 ORDER BY 1 DESC LIMIT 6
    `);

    await q("closed tickets 60d with a ticket_analyses row", `
      SELECT count(DISTINCT t.id) AS with_analysis ${base}
        AND EXISTS (SELECT 1 FROM ticket_analyses a WHERE a.ticket_id = t.id)
    `);

    // What do cls: tags actually look like (granularity check)
    await q("cls: tag distribution (60d closed)", `
      SELECT tg AS tag, count(*) ${base.replace("FROM tickets t", "FROM tickets t, unnest(t.tags) tg")}
        AND tg LIKE 'cls:%' GROUP BY 1 ORDER BY 2 DESC LIMIT 10
    `);

    // Action-note text samples: are they parseable?
    await q("sample Action completed notes", `
      SELECT left(m.body, 140) AS body FROM ticket_messages m
      WHERE m.author_type = 'system' AND m.body LIKE 'Action completed:%'
        AND m.created_at >= now() - interval '30 days'
      ORDER BY m.created_at DESC LIMIT 8
    `);

    // Decision-note samples: reasoning prose that gets discarded
    await q("sample decision notes", `
      SELECT left(m.body, 200) AS body FROM ticket_messages m
      WHERE m.author_type = 'system' AND (m.body LIKE '[System] Sonnet:%' OR m.body LIKE '[System] Opus:%')
        AND m.created_at >= now() - interval '14 days'
      ORDER BY m.created_at DESC LIMIT 6
    `);

    // customer_events tied to tickets?
    await q("customer_events sources (60d)", `
      SELECT source, count(*),
        count(*) FILTER (WHERE properties ? 'ticket_id') AS with_ticket_id
      FROM customer_events
      WHERE created_at >= now() - interval '60 days'
      GROUP BY 1 ORDER BY 2 DESC LIMIT 12
    `);
  } finally {
    await c.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
