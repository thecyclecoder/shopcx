/**
 * Shadow-baseline replay: estimate what Sol WOULD have cost per ticket, if it
 * had been on when a batch of pre-Sol tickets came in. Writes ONE row to
 * public.sol_replay_runs; NEVER writes ticket_directions, ticket_messages, or
 * ai_token_usage. Idempotent-by-run — a re-run creates a new sol_replay_runs
 * row so the audit trail is preserved.
 *
 * Args:
 *   --sample_size N        default 200
 *   --start YYYY-MM-DD     default: window_end - 30 days
 *   --end   YYYY-MM-DD     default: today
 *   --workspace_id UUID    default: env WORKSPACE_ID or the ~first workspace found
 *
 * Simulation:
 *   - Direction-writer path (first-touch): a Haiku-priced dry token count on
 *     the ticket subject + first inbound body — the shape assembleDirectionContext
 *     hydrates at first touch.
 *   - Per-turn cheap loop: a Haiku-priced dry token count on the concatenated
 *     message thread — the shape a stubbed callSonnetOrchestratorV2 would see
 *     over the ticket's message history.
 *
 * Spec: docs/brain/specs/sol-cost-csat-measurement-vs-pre-sol-baseline.md § Phase 4
 * Table brain page: docs/brain/tables/sol_replay_runs.md
 *
 * Usage:
 *   npx tsx scripts/replay-tickets-through-sol.ts --sample_size 50
 *   npx tsx scripts/replay-tickets-through-sol.ts --start 2026-05-01 --end 2026-06-01
 */
import { createAdminClient, pgClient } from "./_bootstrap";
import { usageCostCents } from "../src/lib/ai-usage";

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0 || i + 1 >= process.argv.length) return null;
  return process.argv[i + 1];
}

const HAIKU_MODEL = "claude-haiku-4-5";
// Rough chars-per-token approximation Anthropic publishes (~4 chars/token for
// English). This is a DRY replay — off-by-a-multiple estimation is acceptable
// because we're calibrating against the real per-turn stamp once Sol is live.
function approxTokens(text: string): number {
  return Math.max(0, Math.ceil((text?.length ?? 0) / 4));
}

interface TicketRow {
  id: string;
  workspace_id: string;
  subject: string | null;
  created_at: Date;
}

interface MessageRow {
  ticket_id: string;
  body_clean: string | null;
  body: string | null;
  is_inbound: boolean | null;
  created_at: Date;
}

async function main() {
  const sampleSize = Math.max(1, parseInt(arg("sample_size") || "200", 10));
  const endStr = arg("end");
  const startStr = arg("start");
  const now = new Date();
  const windowEnd = endStr ? new Date(endStr) : now;
  const windowStart = startStr
    ? new Date(startStr)
    : new Date(windowEnd.getTime() - 30 * 24 * 60 * 60 * 1000);

  const c = pgClient();
  await c.connect();
  try {
    // Resolve workspace_id — either explicit or the first workspace.
    let workspaceId = arg("workspace_id") || process.env.WORKSPACE_ID || null;
    if (!workspaceId) {
      const { rows } = await c.query<{ id: string }>(
        `SELECT id FROM public.workspaces ORDER BY created_at ASC LIMIT 1`,
      );
      if (rows.length === 0) throw new Error("No workspaces found; pass --workspace_id");
      workspaceId = rows[0].id;
    }

    console.log(
      `Replay: workspace=${workspaceId} window=[${windowStart.toISOString()}, ${windowEnd.toISOString()}) sample_size=${sampleSize}`,
    );

    // Pre-Sol tickets in window: no ticket_directions row exists for the ticket.
    const { rows: candidates } = await c.query<TicketRow>(
      `SELECT t.id, t.workspace_id, t.subject, t.created_at
         FROM public.tickets t
        WHERE t.workspace_id = $1::uuid
          AND t.created_at >= $2::timestamptz
          AND t.created_at <  $3::timestamptz
          AND t.merged_into IS NULL
          AND NOT EXISTS (
                SELECT 1 FROM public.ticket_directions d
                 WHERE d.ticket_id = t.id
              )
        ORDER BY t.created_at DESC
        LIMIT $4::int`,
      [workspaceId, windowStart.toISOString(), windowEnd.toISOString(), sampleSize],
    );
    console.log(`Loaded ${candidates.length} pre-Sol ticket candidates.`);

    if (candidates.length === 0) {
      console.log("Nothing to replay. Exiting without a sol_replay_runs write.");
      return;
    }

    const ticketIds = candidates.map((t) => t.id);
    const { rows: messages } = await c.query<MessageRow>(
      `SELECT ticket_id, body_clean, body, is_inbound, created_at
         FROM public.ticket_messages
        WHERE ticket_id = ANY($1::uuid[])
        ORDER BY ticket_id, created_at ASC`,
      [ticketIds],
    );
    const byTicket = new Map<string, MessageRow[]>();
    for (const m of messages) {
      const arr = byTicket.get(m.ticket_id) ?? [];
      arr.push(m);
      byTicket.set(m.ticket_id, arr);
    }

    // Cost model: Haiku input tokens for the dry-replay. Direction is a
    // single prompt (subject + first inbound); per-turn loop is one Haiku
    // "call" per turn over the running message thread.
    const results = candidates.map((t) => {
      const msgs = byTicket.get(t.id) ?? [];
      const firstInbound = msgs.find((m) => m.is_inbound) ?? msgs[0];
      const firstInboundBody = (firstInbound?.body_clean ?? firstInbound?.body ?? "") + "";
      const directionPromptChars = (t.subject ?? "").length + firstInboundBody.length;
      const directionInputTokens = approxTokens(String(directionPromptChars));
      const directionCents = usageCostCents(HAIKU_MODEL, {
        input_tokens: directionInputTokens,
        output_tokens: Math.min(500, Math.ceil(directionInputTokens / 4)),
        cache_creation_tokens: 0,
        cache_read_tokens: 0,
      });

      // Per-turn loop: one Haiku call per inbound customer message on top of the
      // running-thread context. Approximates the cheap-execution loop's cost.
      let perTurnCents = 0;
      let running = "";
      let turnCount = 0;
      for (const m of msgs) {
        const body = (m.body_clean ?? m.body ?? "") + "";
        running += (running ? "\n" : "") + body;
        if (!m.is_inbound) continue;
        turnCount += 1;
        const inputTokens = approxTokens(running);
        perTurnCents += usageCostCents(HAIKU_MODEL, {
          input_tokens: inputTokens,
          output_tokens: Math.min(400, Math.ceil(inputTokens / 8)),
          cache_creation_tokens: 0,
          cache_read_tokens: 0,
        });
      }
      const total = Math.round(directionCents + perTurnCents);
      return {
        ticket_id: t.id,
        estimated_cents: total,
        direction_estimated_cents: Math.round(directionCents),
        per_turn_estimated_cents: Math.round(perTurnCents),
        turn_count: turnCount,
      };
    });

    const totalEstimatedCents = results.reduce((acc, r) => acc + r.estimated_cents, 0);
    const admin = createAdminClient();
    // INSERT-only — spec Phase 4 verification: a re-run with the same window
    // MUST write a new row, not mutate the prior one. Never .update()/.upsert().
    const { data: inserted, error } = await admin
      .from("sol_replay_runs")
      .insert({
        workspace_id: workspaceId,
        sample_size: candidates.length,
        window_start: windowStart.toISOString(),
        window_end: windowEnd.toISOString(),
        results,
        total_estimated_cents: totalEstimatedCents,
      })
      .select("id")
      .single();
    if (error || !inserted) {
      throw new Error(`sol_replay_runs insert failed: ${error?.message ?? "no row"}`);
    }

    const sorted = [...results.map((r) => r.estimated_cents)].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
    console.log(
      `✓ sol_replay_runs.id=${inserted.id} · sample_size=${candidates.length} · median=${median}¢ · total=${totalEstimatedCents}¢`,
    );
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
