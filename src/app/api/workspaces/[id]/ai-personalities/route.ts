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

  const { data } = await admin
    .from("ai_personalities")
    .select("*")
    .eq("workspace_id", workspaceId)
    .order("name");

  return NextResponse.json(data || []);
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
  const { name, tone, style_instructions, sign_off, greeting, emoji_usage, description } = body;

  if (!name) return NextResponse.json({ error: "Name required" }, { status: 400 });

  const { data: personality, error } = await admin
    .from("ai_personalities")
    .insert({
      workspace_id: workspaceId,
      name,
      description: description || null,
      tone: tone || "friendly",
      style_instructions: style_instructions || "",
      sign_off: sign_off || null,
      greeting: greeting || null,
      emoji_usage: emoji_usage || "minimal",
    })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(personality, { status: 201 });
}
