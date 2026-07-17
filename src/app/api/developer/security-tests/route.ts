/**
 * GET /api/developer/security-tests — Vault's security-review log (developer/security-tests dashboard).
 *
 * Owner-gated, read-only. Returns every security review Vault has run on a merged spec build (clean
 * ones included), newest-first, enriched with the reviewed spec's title. Each row carries her verdict
 * (clean · false-positive · real-vuln · needs-human · running · failed), the finding text, and — for a
 * routed real-vuln — the authored fix spec slug.
 *
 * `?count=1` short-circuits to just the surfaced count (the sidebar badge — a routed real-vuln fix or
 * a needs-human finding awaiting the owner). See docs/brain/dashboard/security-tests.md.
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { listSecurityReviews, countOpenSecurityReviews } from "@/lib/security-agent";

export async function GET(req: Request) {
  const { user } = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const cookieStore = await cookies();
  const workspaceId = cookieStore.get("workspace_id")?.value;
  if (!workspaceId) return NextResponse.json({ error: "No workspace" }, { status: 400 });

  const admin = createAdminClient();
  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .single();
  if (!member || member.role !== "owner") {
    return NextResponse.json({ error: "Only the workspace owner can view security tests" }, { status: 403 });
  }

  if (new URL(req.url).searchParams.get("count")) {
    const surfacedCount = await countOpenSecurityReviews(admin, workspaceId);
    return NextResponse.json({ surfacedCount });
  }

  const items = await listSecurityReviews(admin, workspaceId);
  return NextResponse.json({ items });
}
