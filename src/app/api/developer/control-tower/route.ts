/**
 * GET /api/developer/control-tower — the Control Tower snapshot (control-tower spec, Phase 1).
 *
 * Owner-gated, read-only. Returns the green/amber/red status of every monitored loop
 * (box worker liveness, cron freshness, agent-kind stuck jobs) plus per-loop last-ran /
 * last-produced / recent history / open alerts — the data behind /dashboard/developer/control-tower.
 * Evaluation is shared with the control-tower-monitor cron (src/lib/control-tower/monitor.ts);
 * this endpoint never mutates (no alert open/resolve, no paging).
 *
 * Two levels (control-tower-switch-controls-three-tier Phase 1 — L0 department-only load):
 *   - level=0 (default): the CEO-glance payload — counts + department rollups + page-level
 *     auxiliary panels (errorFeed / dbHealth / spec drift / repairs / director-dismissed /
 *     coverage register / claude health / self-audit). `loops` is OMITTED so the initial render
 *     doesn't ship every per-loop tile before the CEO drills into a department.
 *   - level=1&owner=<fn>: the drill-in payload for ONE department — `{ generatedAt, loops }`
 *     filtered to that owner. Fired lazily when the CEO expands a DepartmentSection.
 *
 * See docs/brain/dashboard/control-tower.md.
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { buildControlTowerSnapshot } from "@/lib/control-tower/monitor";
import { buildErrorFeedSnapshot } from "@/lib/control-tower/error-feed";
import { getControlTowerDbPanels } from "@/lib/control-tower/snapshot";
import { OWNER_FUNCTIONS, type OwnerFunction } from "@/lib/control-tower/registry";

const OWNER_IDS: OwnerFunction[] = OWNER_FUNCTIONS.map((f) => f.id);

function isOwnerFunction(v: string | null): v is OwnerFunction {
  return v != null && (OWNER_IDS as string[]).includes(v);
}

export async function GET(req: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const cookieStore = await cookies();
  const workspaceId = cookieStore.get("workspace_id")?.value;
  if (!workspaceId) return NextResponse.json({ error: "No workspace" }, { status: 400 });

  const admin = createAdminClient();
  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .single();
  if (!member || member.role !== "owner") {
    return NextResponse.json({ error: "Only the workspace owner can view the Control Tower" }, { status: 403 });
  }

  const url = new URL(req.url);
  const levelParam = url.searchParams.get("level");
  const level = levelParam === "1" ? 1 : 0;

  // ── level=1 — one department's loops only (lazy drill-in). ─────────────────
  if (level === 1) {
    const owner = url.searchParams.get("owner");
    if (!isOwnerFunction(owner)) {
      return NextResponse.json({ error: "level=1 requires ?owner=<function>" }, { status: 400 });
    }
    const snapshot = await buildControlTowerSnapshot(admin);
    return NextResponse.json({
      generatedAt: snapshot.generatedAt,
      loops: snapshot.loops.filter((l) => l.owner === owner),
    });
  }

  // ── level=0 (default) — CEO-glance: counts + rollups + auxiliary panels. loops omitted. ──
  // cut-internal-egress-pooler-and-spec-rpcs Phase 3: the six raw-SELECT panels (db-health / repairs
  // / director-dismissed / coverage-register / spec-drift / claude-health) are now consolidated by
  // the `public.control_tower_snapshot(uuid)` RPC into ONE round trip via `getControlTowerDbPanels`.
  // The heavier `buildControlTowerSnapshot` (per-loop iteration + rollups) + `buildErrorFeedSnapshot`
  // (per-source dedup) stay as their own concurrent reads — their fan-outs need their own derivation.
  const [snapshot, errorFeed, dbPanels] = await Promise.all([
    buildControlTowerSnapshot(admin),
    buildErrorFeedSnapshot(admin),
    getControlTowerDbPanels(admin, workspaceId),
  ]);

  // Fold the error panels into the header health count so an unconfigured panel (amber
  // "not configured") is NEVER counted as healthy — the self-honest count of the spec.
  const counts = { ...snapshot.counts };
  for (const p of errorFeed.panels) counts[p.color]++;

  return NextResponse.json({
    generatedAt: snapshot.generatedAt,
    counts,
    departments: snapshot.departments,
    selfAudit: snapshot.selfAudit,
    errorFeed,
    specDrift:         dbPanels.specDrift,
    repairs:           dbPanels.repairs,
    directorDismissed: dbPanels.directorDismissed,
    dbHealth:          dbPanels.dbHealth,
    coverageRegister:  dbPanels.coverageRegister,
    claudeHealth:      dbPanels.claudeHealth,
  });
}
