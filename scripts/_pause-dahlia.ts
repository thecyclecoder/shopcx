/**
 * Pause Dahlia (ad-creative agent) for the copy-engine retool freeze.
 * Founder-approved 2026-07-15. Reversible: delete the kill_switches row to re-enable.
 *
 * Mechanism: kill_switches row node_id='ad-creative' → the claim_agent_job RPC suppresses
 * every queued kind='ad-creative' job via node-ancestry (MISSING ROW ⇒ ON, so this row ⇒ OFF).
 * Does NOT touch Bianca (media-buyer) — her live tests keep running + grading; only her
 * replenish will no-op against the (now-wiped) bin, which is intended during the freeze.
 */
import "./_bootstrap";
import { createAdminClient } from "../src/lib/supabase/admin";

const APPLY = process.argv.includes("--apply");
const NODE = "ad-creative";
const REASON = "Retool freeze — rebuilding Dahlia's copy engine (imitate-then-innovate + shopgrowth Five Frameworks + Cold/Warm/Hot temperature + Max director-QC). Founder-approved 2026-07-15.";

async function main() {
  const admin = createAdminClient();
  const { data: existing } = await admin.from("kill_switches").select("*").eq("node_id", NODE).maybeSingle();
  console.log(existing ? `kill_switches[${NODE}] ALREADY OFF (off_by=${existing.off_by}, at=${existing.off_at})` : `kill_switches[${NODE}] currently ON`);
  if (!APPLY) { console.log("DRY RUN — pass --apply to turn Dahlia OFF."); return; }
  const { error } = await admin.from("kill_switches").upsert(
    { node_id: NODE, scope: "agent", off_by: "dylan", reason: REASON },
    { onConflict: "node_id" },
  );
  if (error) throw new Error(`kill_switches upsert: ${error.message}`);
  // best-effort audit ledger row (mirrors the Control Tower route)
  try {
    await admin.from("director_activity").insert({
      workspace_id: null, kind: "kill_switch_toggle",
      summary: `Dahlia (ad-creative) turned OFF for copy-engine retool`,
      metadata: { node_id: NODE, off: true, reason: REASON, actor: "dylan" },
    });
  } catch (e) { console.warn("(audit row skipped:", (e as Error).message, ")"); }
  const { data: after } = await admin.from("kill_switches").select("*").eq("node_id", NODE).maybeSingle();
  console.log(`✓ Dahlia PAUSED — kill_switches[${NODE}] OFF (off_by=${after?.off_by}). Reverse: delete this row.`);
}
main().catch((e) => { console.error(e); process.exit(1); });
