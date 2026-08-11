/** Read-only: which escalation_kinds have NO reconcileStaleParkCards family (= immortal cards)? */
import "./_bootstrap";
import { createAdminClient } from "../src/lib/supabase/admin";

const admin = createAdminClient();

// The families as they exist in src/lib/agents/approval-inbox.ts today.
const PARK = new Set(["needs_attention", "park_backstop", "park_design_change"]);
const BUILD_STUCK = new Set(["init_loop_guard", "groom_loop_guard", "escort_failed_repeat", "escort_loop_guard", "loop_guard"]);
const OTHER = new Set(["deploy_unsure", "cs_director_escalate_founder"]);

async function main() {
  const { data, error } = await admin
    .from("dashboard_notifications")
    .select("dismissed, created_at, metadata")
    .eq("type", "agent_approval_request")
    .eq("dismissed", false)
    .limit(2000);
  if (error) throw error;

  const stats = new Map<string, { open: number; total: number; covered: boolean }>();
  for (const r of (data ?? []) as Array<{ dismissed: boolean; metadata: Record<string, unknown> | null }>) {
    const m = r.metadata ?? {};
    const kind = typeof m["escalation_kind"] === "string" ? (m["escalation_kind"] as string) : null;
    if (!kind) continue; // routed Approval Requests — owned by the needs_approval dismiss loop
    const covered = PARK.has(kind) || BUILD_STUCK.has(kind) || OTHER.has(kind);
    const cur = stats.get(kind) ?? { open: 0, total: 0, covered };
    cur.total++;
    if (!r.dismissed) cur.open++;
    stats.set(kind, cur);
  }

  const rows = [...stats.entries()].sort((a, b) => Number(a[1].covered) - Number(b[1].covered) || b[1].open - a[1].open);
  console.log("escalation_kind                        covered  open  (open only)");
  for (const [kind, v] of rows) {
    console.log(`  ${kind.padEnd(36)} ${(v.covered ? "yes" : "NO ").padEnd(7)} ${String(v.open).padStart(4)}  ${v.total}`);
  }
  const orphanOpen = rows.filter(([, v]) => !v.covered).reduce((n, [, v]) => n + v.open, 0);
  console.log(`\n${rows.filter(([, v]) => !v.covered).length} kinds have NO family — ${orphanOpen} open card(s) that only a founder click can clear`);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
