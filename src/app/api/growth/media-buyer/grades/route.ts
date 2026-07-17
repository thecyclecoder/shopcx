import { NextResponse } from "next/server";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadAccountGrades } from "@/lib/media-buyer/grade-rollup";

// Growth → Media Buyer per-account grades read (media-buyer-grade-rollup-on-growth-director-brief Phase 2).
//
//   GET /api/growth/media-buyer/grades?workspaceId=…&account=<meta_ad_account_id>[&limit=50]
//     → 200 { grades: [{ id, actionKind, decisionQuality, outcomeQuality, overallGrade, realizedRoas, gradedAt, ... }] }
//
// The per-account detail page calls this on mount. Grades key by source_meta_ad_id and are mapped to
// the account through meta_ads inside loadAccountGrades. Any workspace member may read (read-only view).
export async function GET(req: Request) {
  const url = new URL(req.url);
  const workspaceId = url.searchParams.get("workspaceId");
  const account = url.searchParams.get("account");
  const limit = Math.min(Number(url.searchParams.get("limit") ?? "50") || 50, 200);

  const { user } = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!workspaceId) return NextResponse.json({ error: "workspaceId required" }, { status: 400 });
  if (!account) return NextResponse.json({ error: "account required" }, { status: 400 });

  const admin = createAdminClient();
  const { data: member } = await admin
    .from("workspace_members")
    .select("user_id")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!member) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const grades = await loadAccountGrades(admin, workspaceId, account, limit);
  return NextResponse.json({ grades });
}
