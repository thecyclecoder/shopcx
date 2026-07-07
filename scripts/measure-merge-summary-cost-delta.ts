// measure-merge-summary-cost-delta — compute the Opus/Sonnet cost delta for
// a merged long-running ticket (default: 49ddd6c4-… the baseline the spec
// cites at $8.92) before vs after the ticket-merge-summary-and-context-cap
// deploy. READ-ONLY probe — no writes. Queries public.ai_token_usage rows
// tagged with ticket_id + purpose starting with `orchestrator-decision:`,
// splits them into two windows (pre-vs-post a `--cutoff <ISO>` boundary,
// or `--pre-days N` before / `--post-days N` after the deploy), and reports
// total cents + a per-turn breakdown via ai-usage.ts usageCostCents (the
// canonical cache-accounting helper — cache_read at 10% of input,
// cache_creation at 125% of input).
//
// Usage:
//   npx tsx scripts/measure-merge-summary-cost-delta.ts \
//     --ticket 49ddd6c4-... \
//     --cutoff 2026-07-07T00:00:00Z          # or --pre-days 14 --post-days 14
//
// Optional flags:
//   --workspace <uuid>     scope to a single workspace (safer on shared boxes)
//   --json                 machine-readable output (default: human table)
//
// Implements Phase 3's verification bullet: "Replaying 49ddd6c4 through the
// new assembly yields a large measured cost reduction versus the $8.92
// baseline (report the number)." Ties into docs/brain/specs/ticket-merge-
// summary-and-context-cap.md.
import { createAdminClient } from "./_bootstrap";
import { usageCostCents } from "../src/lib/ai-usage";

interface UsageRow {
  id: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  purpose: string | null;
  created_at: string;
}

interface Args {
  ticketId: string;
  workspaceId: string | null;
  cutoff: string | null;
  preDays: number | null;
  postDays: number | null;
  json: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { ticketId: "", workspaceId: null, cutoff: null, preDays: null, postDays: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--ticket") out.ticketId = argv[++i];
    else if (a === "--workspace") out.workspaceId = argv[++i];
    else if (a === "--cutoff") out.cutoff = argv[++i];
    else if (a === "--pre-days") out.preDays = Number(argv[++i]);
    else if (a === "--post-days") out.postDays = Number(argv[++i]);
    else if (a === "--json") out.json = true;
  }
  if (!out.ticketId) {
    throw new Error("--ticket <uuid> required");
  }
  return out;
}

function inWindow(row: UsageRow, from: string | null, to: string | null): boolean {
  if (from && row.created_at < from) return false;
  if (to && row.created_at >= to) return false;
  return true;
}

function totalCents(rows: UsageRow[]): number {
  let sum = 0;
  for (const r of rows) {
    sum += usageCostCents(r.model, {
      input_tokens: r.input_tokens,
      output_tokens: r.output_tokens,
      cache_creation_tokens: r.cache_creation_tokens,
      cache_read_tokens: r.cache_read_tokens,
    });
  }
  return sum;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const admin = createAdminClient();

  // Fetch every orchestrator-tagged usage row for this ticket. Filter
  // in-memory into pre/post windows so a single query serves multiple
  // slicings. Only orchestrator-decision rows count — merge_summary
  // rollups are a Phase-2 cost line, not the recost we're measuring.
  let q = admin
    .from("ai_token_usage")
    .select("id, model, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, purpose, created_at")
    .eq("ticket_id", args.ticketId)
    .like("purpose", "orchestrator-decision:%")
    .order("created_at", { ascending: true });
  if (args.workspaceId) q = q.eq("workspace_id", args.workspaceId);
  const { data, error } = await q;
  if (error) throw error;
  const rows = (data || []) as UsageRow[];

  if (rows.length === 0) {
    const msg = `No ai_token_usage rows found for ticket ${args.ticketId} with purpose like 'orchestrator-decision:%'.`;
    if (args.json) console.log(JSON.stringify({ ticket: args.ticketId, rows: 0, note: msg }));
    else console.log(msg);
    return;
  }

  // Cutoff derivation. --cutoff wins; else if --pre-days + --post-days,
  // pick the midpoint of the row window.
  let cutoffIso = args.cutoff;
  if (!cutoffIso && args.preDays && args.postDays) {
    const mid = new Date(rows[Math.floor(rows.length / 2)].created_at);
    cutoffIso = mid.toISOString();
  }
  if (!cutoffIso) {
    // No cutoff → single-window summary. Still useful for a snapshot.
    const cents = totalCents(rows);
    if (args.json) {
      console.log(JSON.stringify({ ticket: args.ticketId, rows: rows.length, total_cents: cents, total_dollars: cents / 100 }));
    } else {
      console.log(`Ticket ${args.ticketId}: ${rows.length} orchestrator turns, total = $${(cents / 100).toFixed(2)} (no --cutoff, single window)`);
    }
    return;
  }

  const pre = rows.filter((r) => inWindow(r, null, cutoffIso));
  const post = rows.filter((r) => inWindow(r, cutoffIso, null));
  const preCents = totalCents(pre);
  const postCents = totalCents(post);
  const delta = postCents - preCents;
  const preTurns = pre.length;
  const postTurns = post.length;
  const perTurnPre = preTurns ? preCents / preTurns : 0;
  const perTurnPost = postTurns ? postCents / postTurns : 0;

  if (args.json) {
    console.log(JSON.stringify({
      ticket: args.ticketId,
      cutoff: cutoffIso,
      pre: { turns: preTurns, cents: preCents, dollars: preCents / 100, per_turn_cents: perTurnPre },
      post: { turns: postTurns, cents: postCents, dollars: postCents / 100, per_turn_cents: perTurnPost },
      delta_cents: delta,
      delta_dollars: delta / 100,
      per_turn_delta_cents: perTurnPost - perTurnPre,
    }));
    return;
  }

  console.log(`── Cost delta for ticket ${args.ticketId} across cutoff ${cutoffIso} ──`);
  console.log(`  PRE  : ${preTurns} turns · $${(preCents / 100).toFixed(2)} total · $${(perTurnPre / 100).toFixed(4)}/turn`);
  console.log(`  POST : ${postTurns} turns · $${(postCents / 100).toFixed(2)} total · $${(perTurnPost / 100).toFixed(4)}/turn`);
  console.log(`  Δ    : $${(delta / 100).toFixed(2)} total · $${((perTurnPost - perTurnPre) / 100).toFixed(4)}/turn`);
  console.log(`  Baseline referenced in spec: 49ddd6c4 = $8.92 across full history.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
