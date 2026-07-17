import { NextResponse } from "next/server";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadAccountGradeRollups } from "@/lib/media-buyer/grade-rollup";

// Growth → Media Buyer cohorts read (media-buyer-armed-flip-surface Phase 2 data source).
//
//   GET /api/growth/media-buyer/cohorts?workspaceId=…
//     → 200 { cohorts: [{ cohort, policy, authorization, sensor_trust }], policyWide }
//
// The dashboard tile calls this on mount. Each returned cohort carries:
//   • cohort           — the media_buyer_test_cohorts row (test ad set + ceiling + is_active).
//   • policy           — the currently-active (workspace-scoped) iteration_policies row (mode, version).
//                        v1 is one workspace-wide policy per iteration-policy-authoring.ts, so the same
//                        policy summary rides on every cohort — the tile renders it per row for clarity.
//   • authorization    — the NEWEST media_buyer_arming_authorization for (workspace, cohort.account?).
//                        The tile derives `arm_button_enabled = allowed && expires_at > now()`.
//   • sensor_trust     — the NEWEST media_buyer_sensor_trust row for the same scope. Read-only signal.
//   • policyWide       — the same policy summary at the top level for a workspace with no cohorts.
//
// RBAC: workspace_members membership (any role); service-role reads past RLS. The dashboard hides
// Arm/Disarm buttons for non-owner roles; this endpoint is read-only for every member.

interface CohortRow {
  id: string;
  meta_ad_account_id: string | null;
  test_meta_adset_id: string;
  daily_test_ceiling_cents: number;
  is_active: boolean;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

interface PolicySummary {
  id: string;
  version: number;
  status: string;
  mode: "shadow" | "armed";
  meta_ad_account_id: string | null;
  campaign_id: string | null;
}

interface AuthorizationSummary {
  id: string;
  allowed: boolean;
  reasons: unknown;
  iso_week: string;
  evaluated_at: string;
  expires_at: string;
  fresh: boolean;
}

interface SensorTrustSummary {
  id: string;
  snapshot_date: string;
  band: "green" | "yellow" | "red";
  reasons: unknown;
  window_days: number;
  coverage_ratio: number | null;
  updated_at: string;
}

async function assertWorkspaceMember(
  admin: ReturnType<typeof createAdminClient>,
  workspaceId: string,
  userId: string,
): Promise<{ ok: true } | { ok: false; res: NextResponse }> {
  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!member) {
    return { ok: false, res: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }
  return { ok: true };
}

async function loadActivePolicy(
  admin: ReturnType<typeof createAdminClient>,
  workspaceId: string,
): Promise<PolicySummary | null> {
  const { data } = await admin
    .from("iteration_policies")
    .select("id, version, status, mode, meta_ad_account_id, campaign_id")
    .eq("workspace_id", workspaceId)
    .eq("status", "active")
    .is("campaign_id", null)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data) return null;
  const row = data as Record<string, unknown>;
  return {
    id: row.id as string,
    version: Number(row.version ?? 0),
    status: (row.status as string) || "active",
    mode: row.mode === "armed" ? "armed" : "shadow",
    meta_ad_account_id: (row.meta_ad_account_id as string | null) ?? null,
    campaign_id: (row.campaign_id as string | null) ?? null,
  };
}

async function loadLatestAuthorization(
  admin: ReturnType<typeof createAdminClient>,
  workspaceId: string,
  metaAdAccountId: string | null,
  nowMs: number,
): Promise<AuthorizationSummary | null> {
  const q = admin
    .from("media_buyer_arming_authorization")
    .select("id, allowed, reasons, iso_week, evaluated_at, expires_at")
    .eq("workspace_id", workspaceId)
    .order("evaluated_at", { ascending: false })
    .limit(1);
  const { data } = metaAdAccountId
    ? await q.eq("meta_ad_account_id", metaAdAccountId).maybeSingle()
    : await q.is("meta_ad_account_id", null).maybeSingle();
  if (!data) return null;
  const row = data as Record<string, unknown>;
  const expiresAt = row.expires_at as string;
  const allowed = row.allowed === true;
  const fresh = allowed && Date.parse(expiresAt) > nowMs;
  return {
    id: row.id as string,
    allowed,
    reasons: row.reasons,
    iso_week: (row.iso_week as string) || "",
    evaluated_at: (row.evaluated_at as string) || "",
    expires_at: expiresAt || "",
    fresh,
  };
}

async function loadLatestSensorTrust(
  admin: ReturnType<typeof createAdminClient>,
  workspaceId: string,
  metaAdAccountId: string | null,
): Promise<SensorTrustSummary | null> {
  const q = admin
    .from("media_buyer_sensor_trust")
    .select("id, snapshot_date, band, reasons, window_days, coverage_ratio, updated_at")
    .eq("workspace_id", workspaceId)
    .order("snapshot_date", { ascending: false })
    .limit(1);
  const { data } = metaAdAccountId
    ? await q.eq("meta_ad_account_id", metaAdAccountId).maybeSingle()
    : await q.is("meta_ad_account_id", null).maybeSingle();
  if (!data) return null;
  const row = data as Record<string, unknown>;
  return {
    id: row.id as string,
    snapshot_date: (row.snapshot_date as string) || "",
    band: row.band === "green" || row.band === "yellow" || row.band === "red" ? row.band : "yellow",
    reasons: row.reasons,
    window_days: Number(row.window_days ?? 0),
    coverage_ratio: row.coverage_ratio == null ? null : Number(row.coverage_ratio),
    updated_at: (row.updated_at as string) || "",
  };
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const workspaceId = url.searchParams.get("workspaceId");

  const { user } = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!workspaceId) return NextResponse.json({ error: "workspaceId required" }, { status: 400 });

  const admin = createAdminClient();
  const gate = await assertWorkspaceMember(admin, workspaceId, user.id);
  if (!gate.ok) return gate.res;

  const [{ data: cohortRows }, policyWide] = await Promise.all([
    admin
      .from("media_buyer_test_cohorts")
      .select("id, meta_ad_account_id, test_meta_adset_id, daily_test_ceiling_cents, is_active, notes, created_at, updated_at")
      .eq("workspace_id", workspaceId)
      .eq("is_active", true)
      .order("created_at", { ascending: false }),
    loadActivePolicy(admin, workspaceId),
  ]);

  const cohorts = ((cohortRows ?? []) as CohortRow[]).map((c) => ({ cohort: c }));
  const nowMs = Date.now();

  // Fan out per-cohort scope reads. When there are no cohorts we still return a policy summary +
  // a workspace-wide authorization/sensor-trust snapshot so the tile can render "no cohorts yet".
  if (cohorts.length === 0) {
    const [auth, trust] = await Promise.all([
      loadLatestAuthorization(admin, workspaceId, null, nowMs),
      loadLatestSensorTrust(admin, workspaceId, null),
    ]);
    return NextResponse.json({
      cohorts: [],
      policyWide,
      workspace_authorization: auth,
      workspace_sensor_trust: trust,
    });
  }

  // media-buyer-grade-rollup-on-growth-director-brief Phase 2: roll up media_buyer_action_grades per
  // cohort account so each row renders an avg grade + a 14-day sparkline. Grades key by ad, mapped to
  // account through meta_ads inside loadAccountGradeRollups.
  const accountIds = [...new Set(cohorts.map(({ cohort }) => cohort.meta_ad_account_id).filter((a): a is string => !!a))];
  const gradeRollups = await loadAccountGradeRollups(admin, workspaceId, accountIds);

  const enriched = await Promise.all(
    cohorts.map(async ({ cohort }) => {
      const [auth, trust] = await Promise.all([
        loadLatestAuthorization(admin, workspaceId, cohort.meta_ad_account_id, nowMs),
        loadLatestSensorTrust(admin, workspaceId, cohort.meta_ad_account_id),
      ]);
      const grades = cohort.meta_ad_account_id ? gradeRollups.get(cohort.meta_ad_account_id) ?? null : null;
      return { cohort, policy: policyWide, authorization: auth, sensor_trust: trust, grades };
    }),
  );

  return NextResponse.json({ cohorts: enriched, policyWide });
}
