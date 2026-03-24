import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getActiveWorkspaceId } from "@/lib/workspace";

const VALID_SORT_FIELDS = [
  "retention_score",
  "ltv_cents",
  "total_orders",
  "last_order_at",
  "email",
  "first_name",
  "created_at",
] as const;

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaceId = await getActiveWorkspaceId();
  if (!workspaceId)
    return NextResponse.json(
      { error: "No active workspace" },
      { status: 400 }
    );

  const admin = createAdminClient();

  // Verify membership
  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .single();

  if (!member) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const searchParams = request.nextUrl.searchParams;
  const search = searchParams.get("search") || "";
  const sort = searchParams.get("sort") || "retention_score";
  const order = searchParams.get("order") === "asc" ? true : false;
  const limit = Math.min(parseInt(searchParams.get("limit") || "25", 10), 100);
  const offset = parseInt(searchParams.get("offset") || "0", 10);

  const sortField = VALID_SORT_FIELDS.includes(
    sort as (typeof VALID_SORT_FIELDS)[number]
  )
    ? sort
    : "retention_score";

  let query = admin
    .from("customers")
    .select("*", { count: "exact" })
    .eq("workspace_id", workspaceId);

  if (search) {
    if (search.includes("@")) {
      // Email search
      query = query.ilike("email", `%${search}%`);
    } else {
      const words = search.trim().split(/\s+/);
      if (words.length >= 2) {
        // Multi-word: first word = first_name, last word = last_name
        const first = words[0];
        const last = words[words.length - 1];
        query = query.ilike("first_name", `${first}%`).ilike("last_name", `${last}%`);
      } else {
        // Single word: match first_name OR last_name OR email prefix
        query = query.or(
          `first_name.ilike.${search}%,last_name.ilike.${search}%,email.ilike.${search}%`
        );
      }
    }
  }

  query = query
    .order(sortField, { ascending: order })
    .range(offset, offset + limit - 1);

  const { data: customers, count, error } = await query;

  if (error) {
    return NextResponse.json(
      { error: "Failed to fetch customers" },
      { status: 500 }
    );
  }

  return NextResponse.json({
    customers: customers || [],
    total: count || 0,
    limit,
    offset,
  });
}
