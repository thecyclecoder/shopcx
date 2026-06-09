/**
 * GET /api/migrations — Appstle→internal migration audits for the dashboard
 * monitor. Returns status counts + the failed/pending rows (renewals at risk)
 * with their failing checks, plus recent passed ones for context.
 *
 * See docs/brain/specs/appstle-pricing-heal-and-migration-monitor.md § Phase 3.
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const cookieStore = await cookies();
  const workspaceId = cookieStore.get("workspace_id")?.value;
  if (!workspaceId) return NextResponse.json({ error: "No workspace" }, { status: 400 });

  const admin = createAdminClient();

  const { data: rows } = await admin
    .from("migration_audits")
    .select("id, subscription_id, appstle_contract_id, internal_contract_id, is_recovery, status, checks, retry_count, last_error, created_at, updated_at")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false })
    .limit(300);

  const all = rows || [];
  const counts = {
    passed: all.filter((r) => r.status === "passed").length,
    pending: all.filter((r) => r.status === "pending").length,
    failed: all.filter((r) => r.status === "failed").length,
    total: all.length,
  };
  // Surface the at-risk ones first (failed, then pending), then recent passed.
  const atRisk = all.filter((r) => r.status === "failed" || r.status === "pending");
  const recentPassed = all.filter((r) => r.status === "passed").slice(0, 25);

  return NextResponse.json({ counts, atRisk, recentPassed });
}
