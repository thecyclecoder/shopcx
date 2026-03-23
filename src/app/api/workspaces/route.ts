import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { cookies } from "next/headers";

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const { name } = body;

  if (!name || typeof name !== "string" || name.trim().length === 0) {
    return NextResponse.json({ error: "Name is required" }, { status: 400 });
  }

  const admin = createAdminClient();

  // Create workspace
  const { data: workspace, error: wsError } = await admin
    .from("workspaces")
    .insert({ name: name.trim() })
    .select()
    .single();

  if (wsError || !workspace) {
    return NextResponse.json({ error: "Failed to create workspace" }, { status: 500 });
  }

  // Add creator as owner
  const { error: memberError } = await admin.from("workspace_members").insert({
    workspace_id: workspace.id,
    user_id: user.id,
    role: "owner",
  });

  if (memberError) {
    // Rollback workspace
    await admin.from("workspaces").delete().eq("id", workspace.id);
    return NextResponse.json({ error: "Failed to add member" }, { status: 500 });
  }

  // Set active workspace
  await admin.auth.admin.updateUserById(user.id, {
    app_metadata: { workspace_id: workspace.id },
  });

  const cookieStore = await cookies();
  cookieStore.set("workspace_id", workspace.id, {
    path: "/",
    httpOnly: false,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 60 * 60 * 24 * 365,
  });

  return NextResponse.json(workspace, { status: 201 });
}
