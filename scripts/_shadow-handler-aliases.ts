/**
 * _shadow-handler-aliases — read-only replay of every "Unknown action type"
 * hit in the last 30 days so you can eyeball which aliases to seed globally
 * BEFORE approving them per-workspace on the admin surface.
 *
 * Reads two sources:
 *   1. `proposed_action_aliases` — the going-forward review queue populated by
 *      the executor from Phase 2 onward.
 *   2. `ticket_messages` — historical sysNotes matching
 *      `Action failed: {type} — Unknown action type: {type}` so hits from
 *      BEFORE the queue existed still surface in the shadow report.
 *
 * Prints a top-N table sorted by total occurrences with the most-recent
 * ticket link and any suggested_target from the queue. Read-only against
 * everything — no mutations.
 *
 *   npx tsx scripts/_shadow-handler-aliases.ts [--top=25] [--days=30]
 */
import { createAdminClient } from "./_bootstrap";

const DEFAULT_TOP = 25;
const DEFAULT_DAYS = 30;

interface Row {
  source_type: string;
  workspace_id: string | null;
  occurrences: number;
  first_seen: string;
  last_seen: string;
  suggested_target: string | null;
  most_recent_ticket_id: string | null;
  source: "queue" | "historical" | "both";
}

function parseArgs(): { top: number; days: number } {
  let top = DEFAULT_TOP;
  let days = DEFAULT_DAYS;
  for (const arg of process.argv.slice(2)) {
    const m = arg.match(/^--(top|days)=(\d+)$/);
    if (m) {
      if (m[1] === "top") top = Number(m[2]);
      if (m[1] === "days") days = Number(m[2]);
    }
  }
  return { top, days };
}

async function main() {
  const { top, days } = parseArgs();
  const admin = createAdminClient();
  const sinceIso = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  console.log(`▸ Shadow report — last ${days} days (since ${sinceIso}), top ${top}\n`);

  const merged = new Map<string, Row>();

  // ── Source 1: proposed_action_aliases queue ──
  const { data: proposals } = await admin
    .from("proposed_action_aliases")
    .select("source_type, workspace_id, occurrences, first_seen, last_seen, suggested_target, ticket_id, status")
    .gte("last_seen", sinceIso)
    .order("occurrences", { ascending: false })
    .limit(1000);

  for (const p of proposals || []) {
    const key = `${p.workspace_id}::${p.source_type}`;
    merged.set(key, {
      source_type: p.source_type,
      workspace_id: p.workspace_id,
      occurrences: p.occurrences ?? 0,
      first_seen: p.first_seen,
      last_seen: p.last_seen,
      suggested_target: p.suggested_target,
      most_recent_ticket_id: p.ticket_id ?? null,
      source: "queue",
    });
  }

  // ── Source 2: historical sysNotes ──
  // The executor writes `Action failed: {type} — Unknown action type: {type}`.
  // We look for the tail so a payload substring can't false-positive.
  const { data: msgs } = await admin
    .from("ticket_messages")
    .select("body, ticket_id, created_at, tickets!inner(workspace_id)")
    .gte("created_at", sinceIso)
    .eq("author_type", "system")
    .eq("visibility", "internal")
    .like("body", "%Unknown action type: %")
    .limit(5000);

  const historicalRe = /Unknown action type:\s*([A-Za-z0-9_.\-]+)/;
  for (const m of msgs || []) {
    const match = String(m.body || "").match(historicalRe);
    if (!match) continue;
    const source_type = match[1];
    // The join returns tickets as an array in supabase-js typings.
    const wsId = Array.isArray(m.tickets)
      ? (m.tickets[0] as { workspace_id?: string } | undefined)?.workspace_id ?? null
      : ((m.tickets as { workspace_id?: string } | null)?.workspace_id ?? null);
    const key = `${wsId}::${source_type}`;
    const existing = merged.get(key);
    if (existing) {
      // Merge: the queue's occurrences are authoritative but a historical hit
      // may be more recent (or older) than the queue's window — extend
      // first_seen backward / last_seen forward as needed.
      if (m.created_at && m.created_at < existing.first_seen) existing.first_seen = m.created_at;
      if (m.created_at && m.created_at > existing.last_seen) {
        existing.last_seen = m.created_at;
        existing.most_recent_ticket_id = m.ticket_id ?? existing.most_recent_ticket_id;
      }
      if (existing.source === "queue") existing.source = "both";
    } else {
      merged.set(key, {
        source_type,
        workspace_id: wsId,
        occurrences: 1,
        first_seen: m.created_at,
        last_seen: m.created_at,
        suggested_target: null,
        most_recent_ticket_id: m.ticket_id ?? null,
        source: "historical",
      });
      // Increment further hits for the same key.
      continue;
    }
    // Bump the historical-only counter (the queue's count wins if it's a queue row).
    if (existing.source === "historical") existing.occurrences += 1;
  }

  const rows = [...merged.values()].sort((a, b) => b.occurrences - a.occurrences).slice(0, top);
  if (rows.length === 0) {
    console.log("No 'Unknown action type' hits in this window. Nothing to shadow.");
    return;
  }

  console.log("source_type".padEnd(32), "occ".padStart(5), " ws".padEnd(8), "suggested_target".padEnd(28), "last_seen              recent_ticket");
  console.log("-".repeat(120));
  for (const r of rows) {
    const wsShort = r.workspace_id ? r.workspace_id.slice(0, 8) : "GLOBAL";
    const src = r.source === "both" ? "*" : r.source === "queue" ? "q" : "h";
    console.log(
      `${(r.source_type + " (" + src + ")").padEnd(32)}`,
      String(r.occurrences).padStart(5),
      wsShort.padEnd(8),
      String(r.suggested_target ?? "—").padEnd(28),
      r.last_seen?.slice(0, 19).replace("T", " "),
      r.most_recent_ticket_id ?? "—",
    );
  }
  console.log("\nLegend: q=queue only · h=historical sysNote only · *=both");
  console.log("Approve the ones you want catalogued on /dashboard/settings/ai/handler-aliases.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
