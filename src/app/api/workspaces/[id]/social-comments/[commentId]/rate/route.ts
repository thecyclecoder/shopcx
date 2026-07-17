/**
 * POST { rating: 'good'|'bad'|'needs_revision', notes?: string }
 * → human rating of the AI's decision on this comment. Powers the
 *   analyzer page where admins flag misclassifications and use them
 *   to refine sonnet_prompts.
 */
import { NextResponse } from "next/server";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

const ALLOWED_RATINGS = new Set(["good", "bad", "needs_revision"]);

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; commentId: string }> },
) {
  const { id: workspaceId, commentId } = await params;
  const { user } = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const { data: member } = await admin
    .from("workspace_members").select("role")
    .eq("workspace_id", workspaceId).eq("user_id", user.id).single();
  if (!member) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { rating, notes } = await request.json().catch(() => ({}));
  if (rating !== null && rating !== undefined && !ALLOWED_RATINGS.has(rating)) {
    return NextResponse.json({ error: "Invalid rating" }, { status: 400 });
  }

  const { error } = await admin
    .from("social_comments")
    .update({
      human_rating: rating || null,
      human_rating_notes: notes || null,
      human_rated_at: rating ? new Date().toISOString() : null,
      human_rated_by: rating ? user.id : null,
      updated_at: new Date().toISOString(),
    })
    .eq("workspace_id", workspaceId)
    .eq("id", commentId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
