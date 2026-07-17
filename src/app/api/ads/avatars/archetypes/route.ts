import { NextResponse } from "next/server";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getProductArchetypes } from "@/lib/ad-avatar-proposals";

export const maxDuration = 60;

/**
 * GET — the SELECTED product's buyer archetypes (gender + age + share), used to
 * pre-fill the avatar face dropdowns with that product's actual buyers (not
 * overall demographics). Opus-free: reads the demographics_snapshots cache,
 * recomputing from raw demographics only on a cache miss.
 */
export async function GET(req: Request) {
  const { user } = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const workspaceId = url.searchParams.get("workspaceId");
  const productId = url.searchParams.get("productId");
  if (!workspaceId || !productId)
    return NextResponse.json({ error: "workspaceId and productId required" }, { status: 400 });

  const admin = createAdminClient();
  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .single();
  if (!member) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  // Confirm the product belongs to this workspace.
  const { data: product } = await admin
    .from("products")
    .select("id, workspace_id")
    .eq("id", productId)
    .single();
  if (!product || product.workspace_id !== workspaceId)
    return NextResponse.json({ error: "not_found" }, { status: 404 });

  const result = await getProductArchetypes(productId);
  if (!result) return NextResponse.json({ archetypes: [], used_fallback: false, reason: "no_demographic_data" });
  return NextResponse.json(result);
}
