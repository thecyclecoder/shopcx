import { NextResponse } from "next/server";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * POST: enqueue a box `product-seed` job (the "Auto-populate" action).
 *
 * Near-zero input: just the product. The box infers ingredients + angle from the
 * PDP. Optional `angle_override` overrides the inferred angle. The box worker
 * claims kind='product-seed' and drives the product none → published.
 * See docs/brain/specs/box-product-seeding.md.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; productId: string }> },
) {
  const { id: workspaceId, productId } = await params;

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

  const { data: product } = await admin
    .from("products")
    .select("id, title")
    .eq("id", productId)
    .eq("workspace_id", workspaceId)
    .single();
  if (!product) return NextResponse.json({ error: "Product not found" }, { status: 404 });

  let angleOverride: string | null = null;
  try {
    const body = await request.json().catch(() => ({}));
    if (typeof body?.angle_override === "string" && body.angle_override.trim()) angleOverride = body.angle_override.trim();
  } catch {
    /* no body — angle stays inferred */
  }

  // Don't double-queue: reuse an in-flight seed job for this product if present.
  const { data: existing } = await admin
    .from("agent_jobs")
    .select("id, status")
    .eq("workspace_id", workspaceId)
    .eq("kind", "product-seed")
    .eq("spec_slug", productId)
    .in("status", ["queued", "queued_resume", "building"])
    .maybeSingle();
  if (existing) return NextResponse.json({ job_id: existing.id, status: existing.status, reused: true });

  const { data: job, error } = await admin
    .from("agent_jobs")
    .insert({
      workspace_id: workspaceId,
      spec_slug: productId,
      kind: "product-seed",
      status: "queued",
      instructions: JSON.stringify({ product_id: productId, angle_override: angleOverride }),
      created_by: user.id,
    })
    .select("id")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ job_id: job.id, status: "queued" });
}
