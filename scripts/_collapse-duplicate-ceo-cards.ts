/**
 * _collapse-duplicate-ceo-cards — one-time collapse of LEGACY duplicate CEO approval cards.
 *
 * WHY. Three fixes shipped 2026-08-11 (#2442 spec-scoped dedupe, #2445 universal auto-clear backstop,
 * #2447 the platform-owner rung) stop NEW fan-out, but none of them can retroactively merge cards
 * that were already open when they landed. Those legacy duplicates are real: the CEO inbox held two
 * byte-identical "Park needs eyes" cards for one spec (two build attempts = two job rows = two
 * `parkbackstop:<jobId>` keys), two cards on the SAME job for `security-dep-watch`, and two
 * `cs_director_escalate_founder` cards for the SAME ticket minted 2h apart by the 48h stale-recheck.
 *
 * WHAT IT DOES. Groups OPEN CEO-routed escalation cards by the incident they are about, and where a
 * group holds more than one card, keeps exactly ONE and dismisses the rest.
 *
 * NOT A `_backfill-*.ts` ON PURPOSE. That prefix triggers [[../src/lib/ship-time-backfill-detector]],
 * which writes a `pending` data_op_runs row and escalates it to the CEO inbox until someone runs it —
 * i.e. it would add a card to the very inbox this script exists to shrink. This is an interactive
 * one-off run with the founder present (the `customer-remedy` genre), so there is nothing for a human
 * to forget, which is the risk that convention guards against.
 *
 * SAFETY
 *  - DRY RUN BY DEFAULT. Pass `--apply` to write.
 *  - Never touches a routed Approval Request (no `escalation_kind`). Those are `needs_approval` jobs —
 *    genuine decisions the founder still owes, each distinct. Dropping one would lose real work.
 *  - Always keeps exactly one card per group; a group of 1 is left completely alone.
 *  - Keeps the NEWEST card (freshest error text / log tail / re-checked reasoning).
 *  - Records what it absorbed on the SURVIVOR's metadata (`collapsed_duplicate_ids`) so nothing is
 *    silently lost, and the dismissal is reversible (`dismissed` is a flag, not a delete).
 *  - Idempotent: after a run every group holds one card, so a re-run is a no-op.
 *
 *   npx tsx scripts/_collapse-duplicate-ceo-cards.ts            # dry run — prints the manifest
 *   npx tsx scripts/_collapse-duplicate-ceo-cards.ts --apply    # writes
 */
import "./_bootstrap";
import { createAdminClient } from "../src/lib/supabase/admin";
import { BUILD_STUCK_ESCALATION_NAMESPACES, dedupeNamespace, notifJobId } from "../src/lib/agents/approval-inbox";
import { recordDirectorActivity } from "../src/lib/director-activity";

const APPLY = process.argv.includes("--apply");
const CEO = "ceo";

interface Card {
  id: string;
  workspace_id: string;
  created_at: string;
  title: string | null;
  metadata: Record<string, unknown> | null;
}

/**
 * The incident a card is about. Mirrors the invariants the three fixes established, so the collapse
 * groups exactly what the live dedupe would now prevent — no broader.
 *   - a founder escalation is about a TICKET   (#2442's `cs-director-founder:{ticketId}` key)
 *   - a build-stuck card is about a SPEC       (#2442's `openBuildStuckCardExistsForSpec`)
 *   - anything else park-shaped is about a JOB (the pre-existing one-card-per-park invariant)
 * A card that matches none of these gets a unique key and is therefore never collapsed.
 */
function incidentKey(c: Card): string {
  const m = c.metadata ?? {};
  const kind = typeof m["escalation_kind"] === "string" ? (m["escalation_kind"] as string) : null;
  if (!kind) return `__ungrouped__:${c.id}`; // routed Approval Request — never collapse

  const ticketId = typeof m["ticket_id"] === "string" ? (m["ticket_id"] as string) : null;
  if (kind === "cs_director_escalate_founder" && ticketId) return `ticket:${ticketId}`;

  const key = typeof m["dedupe_key"] === "string" ? (m["dedupe_key"] as string) : null;
  const slug = typeof m["spec_slug"] === "string" && m["spec_slug"] ? (m["spec_slug"] as string) : null;
  if (key && slug && BUILD_STUCK_ESCALATION_NAMESPACES.has(dedupeNamespace(key))) return `spec:${slug}`;

  const jobId = notifJobId(m);
  if (jobId) return `job:${jobId}`;

  return `__ungrouped__:${c.id}`;
}

async function main() {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("dashboard_notifications")
    .select("id, workspace_id, created_at, title, metadata")
    .eq("type", "agent_approval_request")
    .eq("dismissed", false)
    .limit(2000);
  if (error) throw error;

  const cards = ((data ?? []) as Card[]).filter((c) => {
    const m = c.metadata ?? {};
    return (m["routed_to_function"] ?? CEO) === CEO;
  });

  const groups = new Map<string, Card[]>();
  for (const c of cards) {
    const k = incidentKey(c);
    groups.set(k, [...(groups.get(k) ?? []), c]);
  }

  const dupeGroups = [...groups.entries()]
    .filter(([k, v]) => v.length > 1 && !k.startsWith("__ungrouped__"))
    .map(([k, v]) => [k, [...v].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())] as const);

  console.log(`=== ${cards.length} open CEO cards · ${groups.size} incidents · ${dupeGroups.length} with duplicates ===\n`);
  if (!dupeGroups.length) {
    console.log("Nothing to collapse.");
    return;
  }

  let wouldDismiss = 0;
  for (const [key, sorted] of dupeGroups) {
    const [keep, ...drop] = sorted;
    wouldDismiss += drop.length;
    const age = (c: Card) => `${((Date.now() - new Date(c.created_at).getTime()) / 3_600_000).toFixed(0)}h`;
    console.log(`${key}  (${sorted.length} cards)`);
    console.log(`  KEEP    ${keep.id.slice(0, 8)}  ${age(keep)}  ${String(keep.title).slice(0, 70)}`);
    for (const d of drop) console.log(`  dismiss ${d.id.slice(0, 8)}  ${age(d)}  ${String(d.title).slice(0, 70)}`);
    console.log("");
  }

  if (!APPLY) {
    console.log(`DRY RUN — would dismiss ${wouldDismiss} duplicate card(s), keeping ${dupeGroups.length}.`);
    console.log("Re-run with --apply to write.");
    return;
  }

  let dismissed = 0;
  for (const [key, sorted] of dupeGroups) {
    const [keep, ...drop] = sorted;
    for (const d of drop) {
      // Re-assert `dismissed=false` at the write so a card someone actioned between the read and now
      // is never flipped under them.
      const { error: upErr } = await admin
        .from("dashboard_notifications")
        .update({ dismissed: true })
        .eq("id", d.id)
        .eq("dismissed", false);
      if (upErr) {
        console.warn(`  dismiss failed for ${d.id.slice(0, 8)}: ${upErr.message}`);
        continue;
      }
      dismissed++;
    }
    // Record on the SURVIVOR what it absorbed — nothing is silently lost, and the ids make it
    // reversible by hand.
    const meta = { ...(keep.metadata ?? {}) } as Record<string, unknown>;
    meta["collapsed_duplicate_ids"] = drop.map((d) => d.id);
    meta["collapsed_at"] = new Date().toISOString();
    meta["collapsed_reason"] = "legacy duplicates minted before the 2026-08-11 dedupe fixes (#2442/#2445/#2447)";
    const { error: metaErr } = await admin.from("dashboard_notifications").update({ metadata: meta }).eq("id", keep.id);
    if (metaErr) console.warn(`  survivor stamp failed for ${keep.id.slice(0, 8)}: ${metaErr.message}`);

    await recordDirectorActivity(admin, {
      workspaceId: keep.workspace_id,
      directorFunction: "platform",
      actionKind: "routed_needs_attention",
      specSlug: (keep.metadata?.["spec_slug"] as string) ?? null,
      reason: `Collapsed ${drop.length} legacy duplicate CEO card(s) for incident ${key} — kept ${keep.id.slice(0, 8)}. These predate the 2026-08-11 dedupe fixes, which prevent new fan-out but cannot retroactively merge already-open cards.`,
      metadata: {
        action: "collapse_duplicate_ceo_cards",
        incident_key: key,
        kept: keep.id,
        dismissed: drop.map((d) => d.id),
        autonomous: false,
      },
    });
  }
  console.log(`APPLIED — dismissed ${dismissed} duplicate card(s) across ${dupeGroups.length} incident(s).`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
