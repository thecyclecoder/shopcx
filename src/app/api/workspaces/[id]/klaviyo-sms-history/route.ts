/**
 * Read endpoint for imported Klaviyo SMS campaign history.
 * Returns the list, ordered by send_time desc, with optional sort
 * + size paging via query params.
 */
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

const SORT_FIELDS = new Set([
  "send_time", "scheduled_at", "recipients", "conversions",
  "conversion_rate", "conversion_value_cents", "click_rate",
  "unsubscribe_rate", "name",
]);

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: workspaceId } = await params;
  const url = new URL(request.url);

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const sortField = SORT_FIELDS.has(url.searchParams.get("sort") || "")
    ? url.searchParams.get("sort") as string
    : "send_time";
  const sortDir = url.searchParams.get("dir") === "asc" ? "asc" : "desc";
  const limit = Math.min(Number(url.searchParams.get("limit")) || 100, 500);

  const admin = createAdminClient();
  const { data } = await admin
    .from("klaviyo_sms_campaign_history")
    .select("*")
    .eq("workspace_id", workspaceId)
    .order(sortField, { ascending: sortDir === "asc" })
    .limit(limit);

  return NextResponse.json({ campaigns: data || [] });
}
