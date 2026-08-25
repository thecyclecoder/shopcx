/**
 * Review moderation — publish / reject / feature / unfeature one review, and
 * switch its review_type.
 *
 * **Local-only since the Klaviyo sunset.** This route used to round-trip every
 * action to Klaviyo's `/reviews/{id}/` PATCH whenever the row carried a
 * `klaviyo_review_id` — which is every one of the ~10.7k reviews we imported.
 * With the subscription cancelled that call is a guaranteed hard failure, so
 * moderation would have broken outright the moment the key stopped
 * authenticating. `product_reviews` is now the sole system of record for
 * moderation state. See [[../../../../../../../docs/brain/dashboard/reviews]]
 * and `@/lib/klaviyo-retired`.
 *
 * The rejection reason + explanation the moderator picks used to live only in
 * Klaviyo. They are now persisted on the row (`rejection_reason`,
 * `rejection_explanation`) so the moderator's intent isn't lost, and every
 * action stamps `moderated_at`.
 */
import { NextResponse } from "next/server";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

/** Kept in sync with the reasons the dashboard's reject dialog offers. */
type RejectionReason =
  | "profanity_or_inappropriate"
  | "private_information"
  | "unrelated"
  | "false_or_misleading"
  | "fake"
  | "other";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; reviewId: string }> },
) {
  const { id: workspaceId, reviewId } = await params;
  const { user } = await getAuthedUser();
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
  const { action, review_type, rejection_reason, rejection_explanation } = body as {
    action?: "publish" | "reject" | "feature" | "unfeature";
    review_type?: "review" | "store";
    rejection_reason?: RejectionReason;
    rejection_explanation?: string;
  };

  if (!action && !review_type) {
    return NextResponse.json({ error: "action or review_type required" }, { status: 400 });
  }
  if (action && !["publish", "reject", "feature", "unfeature"].includes(action)) {
    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  }
  if (review_type && !["review", "store"].includes(review_type)) {
    return NextResponse.json({ error: "Invalid review_type" }, { status: 400 });
  }

  // Scope the row to the workspace before writing — the reviewId alone is not
  // tenant-scoped.
  const { data: review } = await admin
    .from("product_reviews")
    .select("id")
    .eq("id", reviewId)
    .eq("workspace_id", workspaceId)
    .single();

  if (!review) return NextResponse.json({ error: "Review not found" }, { status: 404 });

  const nowIso = new Date().toISOString();

  // Handle status action
  if (action) {
    if (action === "reject" && !rejection_reason) {
      return NextResponse.json({ error: "A rejection reason is required" }, { status: 400 });
    }

    const updates: Record<string, unknown> = { moderated_at: nowIso };
    switch (action) {
      case "publish":
        updates.status = "published";
        updates.rejection_reason = null;
        updates.rejection_explanation = null;
        break;
      case "reject":
        updates.status = "rejected";
        updates.rejection_reason = rejection_reason;
        // Klaviyo only carried the free-text explanation for `other`; we keep
        // whatever the moderator typed, whichever reason they picked.
        updates.rejection_explanation = rejection_explanation || null;
        break;
      case "feature":
        updates.status = "featured";
        updates.featured = true;
        break;
      case "unfeature":
        updates.status = "published";
        updates.featured = false;
        break;
    }

    const { error } = await admin
      .from("product_reviews")
      .update(updates)
      .eq("id", reviewId)
      .eq("workspace_id", workspaceId);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Handle review type change
  if (review_type) {
    const { error } = await admin
      .from("product_reviews")
      .update({ review_type, moderated_at: nowIso })
      .eq("id", reviewId)
      .eq("workspace_id", workspaceId);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
