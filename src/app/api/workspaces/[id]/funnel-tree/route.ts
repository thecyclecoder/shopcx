/**
 * Hierarchical funnel for the rebuilt funnel page + Max. Thin HTTP wrapper over
 * [[libraries/funnel-tree]] computeFunnelTree / listFunnelProducts — all the
 * math lives in the SDK so this route and Max read identical numbers.
 *
 * GET ?start=YYYY-MM-DD&end=YYYY-MM-DD&product={handle}
 *   - start/end interpreted in Central time (matches the legacy funnel route).
 *   - product omitted/blank = All products.
 * Returns { range, productHandle, products[], unattributedEntry, blogEntry,
 *           grandTotal, productOptions[] } — productOptions is the stable
 *           slice-dropdown list. blogEntry is the synthetic top-level Blog
 *           bucket for /blog first-touch sessions.
 */
import { NextResponse } from "next/server";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { computeFunnelTree, listSliceOptions, computeBreakdowns, computeRunningExperiments } from "@/lib/storefront/funnel-tree";

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

  // Clamp to launch floor (pre-launch = testing + ad-review crawlers).
  const { data: ws } = await admin
    .from("workspaces").select("storefront_launch_at").eq("id", workspaceId).maybeSingle();

  let start = url.searchParams.get("start") || daysAgoCentral(7);
  const end = url.searchParams.get("end") || todayCentral();
  const launchAt = (ws?.storefront_launch_at as string | null) || null;
  if (launchAt) {
    const launchDate = new Date(launchAt).toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
    if (start < launchDate) start = launchDate;
  }
  const productHandle = url.searchParams.get("product") || null;
  const utmSource = url.searchParams.get("utm_source") || null;
  const referrer = url.searchParams.get("referrer") || null;

  const startIso = centralBoundary(start, false);
  const endIso = centralBoundary(end, true);

  // Dropdown list is computed over a WIDE window (launch floor → today) so it
  // stays stable regardless of the selected range — picking a narrow date
  // never prunes products out of the slice filter.
  const dropdownStart = launchAt
    ? new Date(launchAt).toLocaleDateString("en-CA", { timeZone: "America/Chicago" })
    : daysAgoCentral(90);

  const dropdownStartIso = centralBoundary(dropdownStart, false);
  const [tree, sliceOptions, breakdowns, runningExperiments] = await Promise.all([
    computeFunnelTree({ admin, workspaceId, startIso, endIso, productHandle, utmSource, referrer }),
    listSliceOptions({ admin, workspaceId, startIso: dropdownStartIso, endIso, product: productHandle, utmSource, referrer }),
    computeBreakdowns({ admin, workspaceId, startIso, endIso, productHandle, utmSource, referrer }),
    computeRunningExperiments({ admin, workspaceId }),
  ]);

  return NextResponse.json({
    range: { start, end },
    productHandle: tree.productHandle,
    utmSource: tree.utmSource,
    referrer: tree.referrer,
    products: tree.products,
    unattributedEntry: tree.unattributedEntry,
    blogEntry: tree.blogEntry,
    grandTotal: tree.grandTotal,
    ltvBasis: tree.ltvBasis,
    productOptions: sliceOptions.productOptions,
    utmSourceOptions: sliceOptions.utmSourceOptions,
    referrerOptions: sliceOptions.referrerOptions,
    breakdowns,
    runningExperiments,
  });
}
