/**
 * Backfill: populate tickets.ai_cost_cents for historical rows by summing
 * ai_token_usage.usage_cost_cents (computed via usageCostCents) per ticket_id.
 *
 * Cursors on tickets ordered by created_at DESC, chunks of 500, dry-run by
 * default. --apply writes the sum via UPDATE tickets SET ai_cost_cents=$sum
 * WHERE id=$id. Idempotent — it computes the FULL sum per ticket every run,
 * not a delta, so re-running is a no-op once every row matches.
 *
 * Usage:
 *   npx tsx scripts/backfill-ticket-ai-cost.ts               # dry-run manifest
 *   npx tsx scripts/backfill-ticket-ai-cost.ts --apply       # write
 *   npx tsx scripts/backfill-ticket-ai-cost.ts --chunk 1000  # override chunk size
 *
 * Spec: docs/brain/specs/sol-cost-csat-measurement-vs-pre-sol-baseline.md § Phase 2
 * Recipe: docs/brain/recipes/backfill-ticket-ai-cost.md
 */
import { pgClient } from "./_bootstrap";
import { usageCostCents } from "../src/lib/ai-usage";

const APPLY = process.argv.includes("--apply");
const chunkArgIdx = process.argv.indexOf("--chunk");
const CHUNK = chunkArgIdx >= 0 && process.argv[chunkArgIdx + 1]
  ? Math.max(1, parseInt(process.argv[chunkArgIdx + 1], 10))
  : 500;

interface UsageRow {
  ticket_id: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
}

async function main() {
  const c = pgClient();
  await c.connect();
  console.log(`Mode: ${APPLY ? "APPLY" : "DRY-RUN"}`);
  console.log(`Chunk size: ${CHUNK}\n`);
  try {
    let cursor: string | null = null;
    let ticketsSeen = 0;
    let ticketsMatched = 0;
    let ticketsWritten = 0;
    let ticketsAlreadyCorrect = 0;
    let chunkIndex = 0;

    while (true) {
      const params: (string | number)[] = [CHUNK];
      let where = "";
      if (cursor) {
        params.push(cursor);
        where = ` WHERE created_at < $2::timestamptz`;
      }
      const { rows: chunk } = await c.query<{ id: string; ai_cost_cents: string; created_at: Date }>(
        `SELECT id, ai_cost_cents, created_at
           FROM public.tickets${where}
          ORDER BY created_at DESC
          LIMIT $1::int`,
        params,
      );
      if (chunk.length === 0) break;
      chunkIndex += 1;
      ticketsSeen += chunk.length;

      const ticketIds = chunk.map((r) => r.id);
      const { rows: usageRows } = await c.query<UsageRow>(
        `SELECT ticket_id, model, input_tokens, output_tokens,
                cache_creation_tokens, cache_read_tokens
           FROM public.ai_token_usage
          WHERE ticket_id = ANY($1::uuid[])`,
        [ticketIds],
      );

      const sumByTicket = new Map<string, number>();
      for (const r of usageRows) {
        const cents = usageCostCents(r.model, {
          input_tokens: Number(r.input_tokens) || 0,
          output_tokens: Number(r.output_tokens) || 0,
          cache_creation_tokens: Number(r.cache_creation_tokens) || 0,
          cache_read_tokens: Number(r.cache_read_tokens) || 0,
        });
        sumByTicket.set(r.ticket_id, (sumByTicket.get(r.ticket_id) ?? 0) + cents);
      }

      const changes: { id: string; from: number; to: number }[] = [];
      for (const row of chunk) {
        const rounded = Math.round(sumByTicket.get(row.id) ?? 0);
        const current = Number(row.ai_cost_cents) || 0;
        if (rounded === current) continue;
        changes.push({ id: row.id, from: current, to: rounded });
      }
      ticketsMatched += chunk.filter((r) => sumByTicket.has(r.id)).length;
      ticketsAlreadyCorrect += chunk.length - changes.length;

      const chunkSum = changes.reduce((acc, c) => acc + c.to, 0);
      const oldestInChunk = chunk[chunk.length - 1];
      console.log(
        `chunk ${chunkIndex} · seen=${chunk.length} · would-change=${changes.length} · sum(to)=${chunkSum}¢ · oldest=${oldestInChunk.created_at.toISOString()}`,
      );

      if (APPLY && changes.length > 0) {
        // Compare-and-set on the read-time value so a concurrent per-turn
        // stamp (add_ticket_ai_cost via the executor) doesn't get clobbered
        // by an async-stale sum. When the CAS misses (someone else already
        // wrote), we skip the row this pass and pick it up on re-run —
        // idempotent by construction (full-sum semantics).
        for (const ch of changes) {
          const { rowCount } = await c.query(
            `UPDATE public.tickets
                SET ai_cost_cents = $1::bigint
              WHERE id = $2::uuid
                AND ai_cost_cents = $3::bigint`,
            [ch.to, ch.id, ch.from],
          );
          if (rowCount === 1) ticketsWritten += 1;
        }
      }

      cursor = oldestInChunk.created_at.toISOString();
      if (chunk.length < CHUNK) break;
    }

    console.log(
      `\nDone. tickets_seen=${ticketsSeen} matched_ai_usage=${ticketsMatched} already_correct=${ticketsAlreadyCorrect} ${APPLY ? `written=${ticketsWritten}` : `would_write=${ticketsSeen - ticketsAlreadyCorrect}`}`,
    );
    if (!APPLY) console.log("Dry-run only. Re-run with --apply to write.");
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
