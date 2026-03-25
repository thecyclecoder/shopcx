import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

// GET: Return distinct tags used across tickets in this workspace
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

  // Get all tickets with non-empty tags
  const { data: tickets } = await admin
    .from("tickets")
    .select("tags")
    .eq("workspace_id", workspaceId)
    .not("tags", "eq", "{}");

  const tagSet = new Set<string>();
  for (const t of tickets || []) {
    for (const tag of (t.tags as string[]) || []) {
      tagSet.add(tag);
    }
  }

  return NextResponse.json([...tagSet].sort());
}
