/**
 * POST /api/roadmap/box/drain — owner toggles the build box's "Queue restart" drain (worker_controls).
 *
 *   { drain: true }  → stage a restart: the box stops CLAIMING new work so in-flight lanes finish, it
 *                      reaches idle, its idle self-update fires (SHA advances), and the fresh worker's
 *                      boot clears the flag. New builds queue until the box is current, then resume.
 *   { drain: false } → cancel the drain (resume claiming immediately).
 *
 * Owner-gated. Stamps requested_at_sha (the box's current SHA, so boot can detect the advance),
 * requested_by, requested_at. See docs/brain/recipes/build-box-setup.md § Queue restart.
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export async function POST(request: Request) {
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
    .maybeSingle();
  if (member?.role !== "owner") return NextResponse.json({ error: "Owner only" }, { status: 403 });

  const body = (await request.json().catch(() => ({}))) as { drain?: boolean };
  const drain = body.drain === true;

  // Stamp the box's current SHA so the worker's boot can detect the advance and clear the flag.
  const { data: hb } = await admin.from("worker_heartbeats").select("running_sha").eq("id", "box").maybeSingle();
  const sha = (hb?.running_sha as string | null) ?? null;

  const { error } = await admin
    .from("worker_controls")
    .update({
      drain_for_update: drain,
      requested_at_sha: drain ? sha : null,
      requested_by: drain ? (member?.display_name ?? user.email ?? "owner") : null,
      requested_at: drain ? new Date().toISOString() : null,
      updated_at: new Date().toISOString(),
    })
    .eq("box_id", "box");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, draining: drain });
}
