/**
 * meta-autonomous — one-command on/off for the meta decision-engine's 4a AUTONOMOUS ad actions
 * (pause/scale/replenish). When OFF, the media buyer (Bianca) is the sole owner of live ad actions;
 * the engine's 4b recommendations + scorecards + executor keep running. CEO 2026-07-11.
 *
 *   npx tsx scripts/meta-autonomous.ts status   # show current state
 *   npx tsx scripts/meta-autonomous.ts off       # disable 4a (Bianca-only)
 *   npx tsx scripts/meta-autonomous.ts on        # re-enable the engine's 4a
 *
 * Gated by decision-engine.isMetaAutonomousActionsEnabled → workspaces.meta_autonomous_actions_enabled.
 */
import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";

const WORKSPACE_ID = process.env.MB_WORKSPACE_ID || "fdc11e10-b89f-4989-8b73-ed6526c4d906"; // Superfoods

async function main() {
  const cmd = (process.argv[2] || "status").toLowerCase();
  const admin = createAdminClient();
  if (cmd === "on" || cmd === "off") {
    const enabled = cmd === "on";
    const { error } = await admin.from("workspaces").update({ meta_autonomous_actions_enabled: enabled }).eq("id", WORKSPACE_ID);
    if (error) { console.error("update failed:", error.message); process.exit(1); }
    console.log(`✓ meta decision-engine 4a autonomous actions: ${enabled ? "ON (engine may scale/pause)" : "OFF (Bianca-only)"}`);
    return;
  }
  const { data } = await admin.from("workspaces").select("meta_autonomous_actions_enabled").eq("id", WORKSPACE_ID).maybeSingle();
  const on = (data as { meta_autonomous_actions_enabled?: boolean } | null)?.meta_autonomous_actions_enabled === true;
  console.log(`meta decision-engine 4a autonomous actions: ${on ? "ON" : "OFF (Bianca is sole owner of live ad actions)"}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
