/**
 * POST /api/developer/agents/autonomy — toggle a function's live / autonomous flag.
 *
 * Owner-gated (mirrors GET /api/developer/agents). The progressive-offload switch behind the
 * org-chart approval router (approval-routing-engine spec, Phase 1): the workspace owner flips a
 * director `live` and/or `autonomous` from the Agents hub; resolveApprover then routes that
 * function's tools' approvals to it (live && autonomous) instead of up to the CEO.
 *
 * Body: { functionSlug: string, live?: boolean, autonomous?: boolean }. Upserts public
 * .function_autonomy (global config — one row per function slug). See docs/brain/tables/function_autonomy.md.
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { listFunctionSlugs } from "@/lib/brain-roadmap";


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
    return NextResponse.json({ error: "Only the workspace owner can toggle director autonomy" }, { status: 403 });
  }

  const body = (await req.json().catch(() => null)) as
    | { functionSlug?: string; live?: boolean; autonomous?: boolean }
    | null;
  const functionSlug = body?.functionSlug;
  if (!functionSlug || typeof functionSlug !== "string") {
    return NextResponse.json({ error: "functionSlug is required" }, { status: 400 });
  }
  // Only a real functions/*.md director may be toggled (the CEO is the implicit root, never a row).
  const slugs = await listFunctionSlugs();
  if (!slugs.includes(functionSlug)) {
    return NextResponse.json({ error: `Unknown function: ${functionSlug}` }, { status: 400 });
  }

  // Read the current row so a partial toggle (only `live` or only `autonomous`) preserves the other.
  const { data: existing } = await admin
    .from("function_autonomy")
    .select("live, autonomous")
    .eq("function_slug", functionSlug)
    .maybeSingle();

  const live = typeof body?.live === "boolean" ? body.live : (existing?.live ?? false);
  let autonomous = typeof body?.autonomous === "boolean" ? body.autonomous : (existing?.autonomous ?? false);
  // Invariant: autonomous implies live (an offline director can't auto-approve). Clear it if not live.
  if (!live) autonomous = false;

  const { error } = await admin.from("function_autonomy").upsert(
    {
      function_slug: functionSlug,
      live,
      autonomous,
      updated_by: member.display_name ?? user.email ?? "owner",
      updated_at: new Date().toISOString(),
    },
    { onConflict: "function_slug" },
  );
  if (error) {
    return NextResponse.json({ error: "Failed to update autonomy flag" }, { status: 500 });
  }

  return NextResponse.json({ functionSlug, live, autonomous });
}
