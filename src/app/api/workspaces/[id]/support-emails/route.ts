import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: workspaceId } = await params;
  void request;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();

  const { data: emails } = await admin
    .from("support_emails")
    .select("*")
    .eq("workspace_id", workspaceId)
    .order("is_default", { ascending: false })
    .order("created_at");

  return NextResponse.json(emails || []);
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: workspaceId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();

  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .single();

  if (!member || !["owner", "admin"].includes(member.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await request.json();
  const { email, label, is_default } = body;

  if (!email) {
    return NextResponse.json({ error: "Email is required" }, { status: 400 });
  }

  // If setting as default, unset existing default
  if (is_default) {
    await admin
      .from("support_emails")
      .update({ is_default: false })
      .eq("workspace_id", workspaceId);
  }

  // Check if it's the first one — auto-set as default
  const { count } = await admin
    .from("support_emails")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId);

  const { data: created, error } = await admin
    .from("support_emails")
    .insert({
      workspace_id: workspaceId,
      email: email.toLowerCase().trim(),
      label: label || null,
      is_default: is_default || count === 0,
    })
    .select()
    .single();

  if (error) {
    if (error.code === "23505") {
      return NextResponse.json({ error: "Email already exists" }, { status: 409 });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Also update the workspace support_email to the default
  const { data: defaultEmail } = await admin
    .from("support_emails")
    .select("email")
    .eq("workspace_id", workspaceId)
    .eq("is_default", true)
    .single();

  if (defaultEmail) {
    await admin
      .from("workspaces")
      .update({ support_email: defaultEmail.email })
      .eq("id", workspaceId);
  }

  return NextResponse.json(created, { status: 201 });
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: workspaceId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();

  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .single();

  if (!member || !["owner", "admin"].includes(member.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const emailId = searchParams.get("email_id");
  if (!emailId) return NextResponse.json({ error: "email_id required" }, { status: 400 });

  await admin
    .from("support_emails")
    .delete()
    .eq("id", emailId)
    .eq("workspace_id", workspaceId);

  return NextResponse.json({ ok: true });
}
