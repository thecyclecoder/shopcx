/**
 * POST /api/developer/control-tower/switch — the CEO-only kill-switch writer
 * ([[../../../docs/brain/specs/a-kill-switch-can-always-be-turned-back-on.md]] Phase 1).
 *
 * The [[../../../docs/brain/tables/kill_switches.md]] table has been documented as writeable
 * via this route since Phase 1 of the kill-switches spec, but the route file did not exist —
 * `.from('kill_switches')` writes appear nowhere in `src/` or `scripts/`. That gap was a trap:
 * the `ad-creative` node was switched off on 2026-07-15 for a retool freeze and stayed off
 * until 2026-08-18 because nothing in the product could clear the row (RLS is service-role only
 * — `off_by` + free-text `reason` are audit-trail-not-broadcast). Lifting it required a raw
 * service-role delete run by hand.
 *
 * This route is that missing writer, and its most important property is that it CLEARS as
 * well as sets — a switch that can be flipped on but not back off is a single-use fuse, not a
 * kill switch.
 *
 *   Body: { node_id: string, off: boolean, reason?: string }
 *   `off:true`  → upsert the row (stamping off_by + off_at + reason + scope from the registry)
 *   `off:false` → DELETE the row (MISSING ROW ⇒ ON per the table's fail-open invariant — a
 *                 cleared switch is a deleted row, not a flag flip)
 *
 * Owner-gated (same shape as sibling developer/control-tower routes). Validates node_id
 * through the canonical registry — an unknown node is rejected before any DB touch. Every
 * set + every clear ALSO writes a [[../../../docs/brain/tables/director_activity.md]] row
 * (action_kind='kill_switch_toggle') so the audit trail survives the DELETE — losing the
 * record of WHO lifted a freeze would trade one blind spot for another.
 *
 * See docs/brain/tables/kill_switches.md · docs/brain/tables/director_activity.md ·
 * docs/brain/libraries/control-tower-node-registry.md.
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getNode, type OrgNode, type NodeKind } from "@/lib/control-tower/node-registry";
import { invalidateKillSwitchCache, type KillSwitchScope } from "@/lib/control-tower/kill-switch-resolver";
import { recordDirectorActivity } from "@/lib/director-activity";

/**
 * Resolve an incoming `node_id` to its canonical `OrgNode`. Accepts the canonical id
 * (`agent:ad-creative`, `agent-kind:build`, `dept:growth`, `director:platform`, `box`,
 * MONITORED_LOOPS ids) OR a bare agent-kind slug (`ad-creative`, `build`) — mirrors the
 * same normalization contract as `resolveNodeOwner` / `resolveOrgNode`, so a caller with
 * either form gets validated + placed. Returns null when the id is genuinely unknown.
 */
function findOrgNode(nodeId: string): OrgNode | null {
  return (
    getNode(nodeId) ??
    getNode(`agent-kind:${nodeId}`) ??
    getNode(`agent:${nodeId}`) ??
    null
  );
}

/**
 * Bucket a NodeKind into the four scope values the `public.kill_switches.scope` CHECK
 * constraint allows. `cron` / `reactive` are scheduling primitives (tool-like — mirrors the
 * `loopKindToNodeKind('worker') → 'tool'` mapping); `inline-agent` is agent-like.
 */
function scopeForNodeKind(kind: NodeKind): KillSwitchScope {
  switch (kind) {
    case "department":
      return "department";
    case "director":
      return "director";
    case "agent":
    case "inline-agent":
      return "agent";
    case "tool":
    case "cron":
    case "reactive":
      return "tool";
  }
}

export async function POST(req: Request) {
  const { user } = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const cookieStore = await cookies();
  const workspaceId = cookieStore.get("workspace_id")?.value;
  if (!workspaceId) return NextResponse.json({ error: "No workspace" }, { status: 400 });

  const admin = createAdminClient();
  const { data: member } = await admin
    .from("workspace_members")
    .select("role, display_name")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .single();
  if (!member || member.role !== "owner") {
    return NextResponse.json({ error: "Only the workspace owner can toggle a kill switch" }, { status: 403 });
  }

  const body = (await req.json().catch(() => null)) as
    | { node_id?: unknown; off?: unknown; reason?: unknown }
    | null;
  const nodeIdInput = typeof body?.node_id === "string" ? body.node_id.trim() : "";
  const off = typeof body?.off === "boolean" ? body.off : null;
  const reason = typeof body?.reason === "string" ? body.reason.slice(0, 4000) : null;
  if (!nodeIdInput || off === null) {
    return NextResponse.json({ error: "node_id (string) and off (boolean) are required" }, { status: 400 });
  }

  const node = findOrgNode(nodeIdInput);
  if (!node) {
    return NextResponse.json({ error: `Unknown node: '${nodeIdInput}' — not registered in the canonical node registry` }, { status: 400 });
  }

  const actor = member.display_name ?? user.email ?? "owner";

  if (off) {
    // ON → OFF. Upsert on node_id — repeated flips replace the audit fields rather than fanning out
    // rows (PK is node_id). Store under the CANONICAL id from the registry so a row is discoverable
    // by both the resolver's canonical lookup and its slug-convenience walk.
    const scope = scopeForNodeKind(node.kind);
    const { error } = await admin.from("kill_switches").upsert(
      {
        node_id: node.id,
        scope,
        off_by: actor,
        off_at: new Date().toISOString(),
        reason,
      },
      { onConflict: "node_id" },
    );
    if (error) {
      return NextResponse.json({ error: `Failed to switch off: ${error.message}` }, { status: 500 });
    }
    invalidateKillSwitchCache();
    // Audit — the row itself carries off_by/off_at/reason, but recording director_activity too keeps
    // the ledger uniform with the clear path (whose delete leaves nothing behind).
    await recordDirectorActivity(admin, {
      workspaceId,
      directorFunction: "platform",
      actionKind: "kill_switch_toggle",
      specSlug: null,
      reason: reason ? `Switched OFF ${node.id}: ${reason}` : `Switched OFF ${node.id}`,
      metadata: { node_id: node.id, input_node_id: nodeIdInput, scope, off: true, actor },
    });
    return NextResponse.json({ ok: true, node_id: node.id, off: true, scope });
  }

  // OFF → ON. MISSING ROW ⇒ ON per the table's fail-open invariant, so clearing is a DELETE, not a
  // flag flip. Delete BOTH the canonical id AND the caller's raw input — a legacy row stored under
  // the bare slug (`ad-creative`) coexists with a canonical (`agent:ad-creative`) row, and clearing
  // must lift both or the freeze survives on the other key.
  const keysToDelete = Array.from(new Set([node.id, nodeIdInput]));
  const { error } = await admin.from("kill_switches").delete().in("node_id", keysToDelete);
  if (error) {
    return NextResponse.json({ error: `Failed to clear switch: ${error.message}` }, { status: 500 });
  }
  invalidateKillSwitchCache();
  // Audit — the row is gone, so the ledger is the ONLY surviving record of who lifted the freeze.
  await recordDirectorActivity(admin, {
    workspaceId,
    directorFunction: "platform",
    actionKind: "kill_switch_toggle",
    specSlug: null,
    reason: reason ? `Switched ON ${node.id}: ${reason}` : `Switched ON ${node.id} (freeze lifted)`,
    metadata: { node_id: node.id, input_node_id: nodeIdInput, off: false, actor, keys_deleted: keysToDelete },
  });
  return NextResponse.json({ ok: true, node_id: node.id, off: false });
}
