/**
 * Chapter diagnostics (the "why") for the funnel page card + Max. Thin HTTP
 * wrapper over [[libraries/funnel-tree]] computeChapterDiagnostics. Inherits the
 * page's Product × Source × Referrer slices and adds a card-local `destination`.
 *
 * GET ?start&end&product&utm_source&referrer&destination
 */
import { NextResponse } from "next/server";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { computeChapterDiagnostics, computeBottlenecks } from "@/lib/storefront/funnel-tree";

function todayCentral(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
}
function daysAgoCentral(n: number): string {
  const [y, m, d] = todayCentral().split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d - n, 12)).toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
}
function centralBoundary(yyyyMmDd: string, endOfDay: boolean): string {
  const time = endOfDay ? "T23:59:59.999Z" : "T00:00:00.000Z";
  const noon = new Date(`${yyyyMmDd}T12:00:00Z`);
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", timeZoneName: "longOffset" });
  const tzName = fmt.formatToParts(noon).find((p) => p.type === "timeZoneName")?.value || "";
  const match = tzName.match(/GMT([+-])(\d\d):(\d\d)/);
  let offsetMinutes = 0;
  if (match) offsetMinutes = (match[1] === "+" ? 1 : -1) * (Number(match[2]) * 60 + Number(match[3]));
  return new Date(new Date(`${yyyyMmDd}${time}`).getTime() - offsetMinutes * 60_000).toISOString();
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: workspaceId } = await params;
  const url = new URL(request.url);

  const { user } = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const { data: member } = await admin
    .from("workspace_members").select("role")
    .eq("workspace_id", workspaceId).eq("user_id", user.id).single();
  if (!member) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { data: ws } = await admin
    .from("workspaces").select("storefront_launch_at").eq("id", workspaceId).maybeSingle();

  let start = url.searchParams.get("start") || daysAgoCentral(7);
  const end = url.searchParams.get("end") || todayCentral();
  const launchAt = (ws?.storefront_launch_at as string | null) || null;
  if (launchAt) {
    const launchDate = new Date(launchAt).toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
    if (start < launchDate) start = launchDate;
  }

  const startIso = centralBoundary(start, false);
  const endIso = centralBoundary(end, true);
  const productHandle = url.searchParams.get("product") || null;
  const utmSource = url.searchParams.get("utm_source") || null;
  const referrer = url.searchParams.get("referrer") || null;
  const [result, bottlenecks] = await Promise.all([
    computeChapterDiagnostics({ admin, workspaceId, startIso, endIso, productHandle, utmSource, referrer, destination: url.searchParams.get("destination") || null }),
    computeBottlenecks({ admin, workspaceId, startIso, endIso, productHandle, utmSource, referrer }),
  ]);

  return NextResponse.json({ range: { start, end }, ...result, bottlenecks });
}
