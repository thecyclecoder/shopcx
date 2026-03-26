import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { inngest } from "@/lib/inngest/client";

// POST: Start scraping a help center URL
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
  const { url } = body;
  if (!url) return NextResponse.json({ error: "url required" }, { status: 400 });

  // Save the help center URL
  await admin.from("workspaces").update({ help_center_url: url }).eq("id", workspaceId);

  // Fire Inngest scraper
  await inngest.send({
    name: "kb/scrape-help-center",
    data: { workspace_id: workspaceId, url },
  });

  return NextResponse.json({ started: true });
}
