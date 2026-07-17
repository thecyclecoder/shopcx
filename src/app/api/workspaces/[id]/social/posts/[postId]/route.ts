import { NextResponse } from "next/server";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { inngest } from "@/lib/inngest/client";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string; postId: string }> }) {
  const { id: workspaceId, postId } = await params;
  const { user } = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const admin = createAdminClient();

  const { data: post } = await admin.from("scheduled_social_posts").select("id, status, scheduled_at").eq("id", postId).eq("workspace_id", workspaceId).maybeSingle();
  if (!post) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const body = await req.json();
  const action = body.action as string | undefined;

  // Cancel — only meaningful before it's posted.
  if (action === "cancel") {
    if (["posted", "publishing"].includes(post.status)) return NextResponse.json({ error: `cannot cancel a ${post.status} post` }, { status: 409 });
    await admin.from("scheduled_social_posts").update({ status: "cancelled", updated_at: new Date().toISOString() }).eq("id", postId);
    return NextResponse.json({ ok: true, status: "cancelled" });
  }

  // Post now — schedule for now + fire the publisher (which sleeps until now = immediate).
  if (action === "post_now") {
    if (!["draft", "scheduled", "failed"].includes(post.status)) return NextResponse.json({ error: `cannot post a ${post.status} post` }, { status: 409 });
    await admin.from("scheduled_social_posts").update({ status: "scheduled", scheduled_at: new Date().toISOString(), error: null, updated_at: new Date().toISOString() }).eq("id", postId);
    await inngest.send({ name: "social/publish", data: { post_id: postId } });
    return NextResponse.json({ ok: true, status: "scheduled" });
  }

  // Approve a draft — move to scheduled + arm the publisher for its slot.
  if (action === "approve") {
    if (post.status !== "draft") return NextResponse.json({ error: "only drafts can be approved" }, { status: 409 });
    await admin.from("scheduled_social_posts").update({ status: "scheduled", updated_at: new Date().toISOString() }).eq("id", postId);
    await inngest.send({ name: "social/publish", data: { post_id: postId } });
    return NextResponse.json({ ok: true, status: "scheduled" });
  }

  // Edit caption / scheduled time.
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (typeof body.caption === "string") updates.caption = body.caption;
  if (typeof body.scheduled_at === "string") updates.scheduled_at = body.scheduled_at;
  if (Object.keys(updates).length === 1) return NextResponse.json({ error: "nothing to update" }, { status: 400 });
  await admin.from("scheduled_social_posts").update(updates).eq("id", postId);
  return NextResponse.json({ ok: true });
}
