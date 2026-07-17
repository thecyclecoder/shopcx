/**
 * Winning Static-Creative Finder — Phase 4 pattern matrix (the deliverable).
 *
 *   GET ?workspaceId=&minBrands=  → slot patterns repeating across ≥N independent
 *                                   brands + the ranked hook×mechanism×proof×offer
 *                                   test matrix. Computed on demand (deterministic).
 *
 * See docs/brain/specs/winning-static-creative-finder.md.
 */
import { NextResponse } from "next/server";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { buildPatternMatrix } from "@/lib/creative-skeleton";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const workspaceId = url.searchParams.get("workspaceId");
  const { user } = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!workspaceId) return NextResponse.json({ error: "workspaceId required" }, { status: 400 });

  const admin = createAdminClient();
  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .single();
  if (!member || !["owner", "admin"].includes(member.role as string))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const minBrands = Number(url.searchParams.get("minBrands")) || 2;
  const matrix = await buildPatternMatrix(workspaceId, { minBrands });
  return NextResponse.json(matrix);
}
