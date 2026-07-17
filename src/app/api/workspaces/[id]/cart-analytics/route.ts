/**
 * Abandoned-cart + lead capture SUMMARY (no per-cart logs), slice + destination
 * aware. Thin wrapper over [[libraries/funnel-tree]] computeCartAnalytics.
 * GET ?start&end&product&utm_source&referrer&destination
 */
import { NextResponse } from "next/server";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { computeCartAnalytics, computePopupFunnel, computeSurveyFunnel, computePackBreakdown } from "@/lib/storefront/funnel-tree";

function todayCentral(): string { return new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" }); }
function daysAgoCentral(n: number): string {
  const [y, m, d] = todayCentral().split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d - n, 12)).toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
}
function centralBoundary(yyyyMmDd: string, endOfDay: boolean): string {
  const time = endOfDay ? "T23:59:59.999Z" : "T00:00:00.000Z";
  const noon = new Date(`${yyyyMmDd}T12:00:00Z`);
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", timeZoneName: "longOffset" });
  const tzName = fmt.formatToParts(noon).find((p) => p.type === "timeZoneName")?.value || "";
  const mm = tzName.match(/GMT([+-])(\d\d):(\d\d)/);
  let off = 0; if (mm) off = (mm[1] === "+" ? 1 : -1) * (Number(mm[2]) * 60 + Number(mm[3]));
  return new Date(new Date(`${yyyyMmDd}${time}`).getTime() - off * 60_000).toISOString();
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: workspaceId } = await params;
  const url = new URL(request.url);
  const { user } = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const admin = createAdminClient();
  const { data: member } = await admin.from("workspace_members").select("role").eq("workspace_id", workspaceId).eq("user_id", user.id).single();
  if (!member) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { data: ws } = await admin.from("workspaces").select("storefront_launch_at").eq("id", workspaceId).maybeSingle();
  let start = url.searchParams.get("start") || daysAgoCentral(7);
  const end = url.searchParams.get("end") || todayCentral();
  const launchAt = (ws?.storefront_launch_at as string | null) || null;
  if (launchAt) { const d = new Date(launchAt).toLocaleDateString("en-CA", { timeZone: "America/Chicago" }); if (start < d) start = d; }

  const common = {
    admin, workspaceId,
    startIso: centralBoundary(start, false), endIso: centralBoundary(end, true),
    productHandle: url.searchParams.get("product") || null,
    utmSource: url.searchParams.get("utm_source") || null,
    referrer: url.searchParams.get("referrer") || null,
    destination: url.searchParams.get("destination") || null,
  };
  const [result, popupFunnel, surveyFunnel, packBreakdown] = await Promise.all([computeCartAnalytics(common), computePopupFunnel(common), computeSurveyFunnel(common), computePackBreakdown(common)]);
  return NextResponse.json({ range: { start, end }, ...result, popupFunnel, surveyFunnel, packBreakdown });
}
