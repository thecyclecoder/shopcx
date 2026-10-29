/**
 * Owner-only on/off for the `appstle_retired` switch ([[docs/brain/libraries/appstle-retired.md]]),
 * behind the Appstle card in Settings > Subscriptions.
 *
 * The switch is not a node in the control-tower registry, so the generic CEO writer
 * (`/api/developer/control-tower/switch`) rejects it; before this route it could only be flipped
 * with hand-run SQL. Same contract as that writer: owner-gated, ON = upsert the row, OFF = delete it
 * (missing row ⇒ Appstle live), cache invalidated, and every flip recorded in director_activity.
 *
 *   GET  → { retired, active_appstle_subs }
 *   POST { retired: boolean } → { ok, retired }
 */
import { NextResponse } from "next/server";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { invalidateKillSwitchCache } from "@/lib/control-tower/kill-switch-resolver";
import { recordDirectorActivity } from "@/lib/director-activity";
import { APPSTLE_RETIRED_SWITCH, invalidateAppstleRetiredCache, isAppstleRetired } from "@/lib/appstle-retired";

async function ownerOf(workspaceId: string) {
  const { user } = await getAuthedUser();
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) } as const;
  const admin = createAdminClient();
  const { data: member } = await admin
    .from("workspace_members")
    .select("role, display_name")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .single();
  if (!member || member.role !== "owner") {
    return { error: NextResponse.json({ error: "Only the workspace owner can change this" }, { status: 403 }) } as const;
  }
  return { admin, actor: (member.display_name as string | null) ?? user.email ?? "owner" } as const;
}

/** ACTIVE subs still billed by Appstle — turning the switch on while any exist risks a double bill. */
async function activeAppstleSubs(admin: ReturnType<typeof createAdminClient>, workspaceId: string): Promise<number> {
  const { count } = await admin
    .from("subscriptions")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId)
    .eq("billing_source", "appstle")
    .eq("status", "active");
  return count ?? 0;
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: workspaceId } = await params;
  const auth = await ownerOf(workspaceId);
  if ("error" in auth) return auth.error;
  invalidateAppstleRetiredCache();
  return NextResponse.json({
    retired: await isAppstleRetired(),
    active_appstle_subs: await activeAppstleSubs(auth.admin, workspaceId),
  });
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: workspaceId } = await params;
  const auth = await ownerOf(workspaceId);
  if ("error" in auth) return auth.error;
  const { admin, actor } = auth;

  const body = (await req.json().catch(() => null)) as { retired?: unknown } | null;
  if (typeof body?.retired !== "boolean") {
    return NextResponse.json({ error: "retired (boolean) is required" }, { status: 400 });
  }
  const retired = body.retired;

  if (retired) {
    const { error } = await admin.from("kill_switches").upsert(
      {
        node_id: APPSTLE_RETIRED_SWITCH,
        scope: "tool",
        off_by: actor,
        off_at: new Date().toISOString(),
        reason: "Appstle retired from Settings — revives build on ShopCX from our mirror",
      },
      { onConflict: "node_id" },
    );
    if (error) return NextResponse.json({ error: `Failed to retire Appstle: ${error.message}` }, { status: 500 });
  } else {
    const { error } = await admin.from("kill_switches").delete().eq("node_id", APPSTLE_RETIRED_SWITCH);
    if (error) return NextResponse.json({ error: `Failed to restore Appstle: ${error.message}` }, { status: 500 });
  }
  invalidateKillSwitchCache();
  invalidateAppstleRetiredCache();

  await recordDirectorActivity(admin, {
    workspaceId,
    directorFunction: "platform",
    actionKind: "kill_switch_toggle",
    specSlug: null,
    reason: retired ? `Retired Appstle (${APPSTLE_RETIRED_SWITCH} on)` : `Restored Appstle (${APPSTLE_RETIRED_SWITCH} off)`,
    metadata: { node_id: APPSTLE_RETIRED_SWITCH, off: retired, actor },
  });
  return NextResponse.json({ ok: true, retired });
}
