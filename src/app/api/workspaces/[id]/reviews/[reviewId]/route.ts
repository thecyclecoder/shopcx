import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { updateReviewStatus } from "@/lib/klaviyo";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; reviewId: string }> },
) {
  const { id: workspaceId, reviewId } = await params;
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
  const { action } = body as { action: "publish" | "reject" | "feature" | "unfeature" };

  if (!action || !["publish", "reject", "feature", "unfeature"].includes(action)) {
    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  }

  // Get the review's Klaviyo ID
  const { data: review } = await admin
    .from("product_reviews")
    .select("klaviyo_review_id")
    .eq("id", reviewId)
    .eq("workspace_id", workspaceId)
    .single();

  if (!review) return NextResponse.json({ error: "Review not found" }, { status: 404 });

  if (review.klaviyo_review_id) {
    // Update via Klaviyo API
    const result = await updateReviewStatus(workspaceId, review.klaviyo_review_id, action);
    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 500 });
    }
  } else {
    // Local-only review — update directly
    const updates: Record<string, unknown> = {};
    switch (action) {
      case "publish": updates.status = "published"; break;
      case "reject": updates.status = "rejected"; break;
      case "feature": updates.status = "featured"; updates.featured = true; break;
      case "unfeature": updates.status = "published"; updates.featured = false; break;
    }
    await admin.from("product_reviews").update(updates).eq("id", reviewId);
  }

  return NextResponse.json({ success: true });
}
