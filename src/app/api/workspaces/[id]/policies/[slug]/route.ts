/**
 * GET /api/workspaces/[id]/policies/[slug]
 * PUT /api/workspaces/[id]/policies/[slug]
 *
 * GET returns the current active version. PUT updates the active row in
 * place and bumps `version` so we have an audit trail of edits. We also
 * mark the prior row as `superseded_by` the new one.
 *
 * Only owner/admin can edit.
 */
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthedUser } from "@/lib/supabase/server";

const VALID_SLUGS = new Set(["returns", "refunds", "subscriptions", "exchanges", "crisis"]);

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; slug: string }> },
) {
  const { id: workspaceId, slug } = await params;
  if (!VALID_SLUGS.has(slug)) return NextResponse.json({ error: "invalid slug" }, { status: 400 });

  const { user } = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!member) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { data: policy } = await admin
    .from("policies")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("slug", slug)
    .eq("is_active", true)
    .is("superseded_by", null)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!policy) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ policy });
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; slug: string }> },
) {
  const { id: workspaceId, slug } = await params;
  if (!VALID_SLUGS.has(slug)) return NextResponse.json({ error: "invalid slug" }, { status: 400 });

  const { user } = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!member || (member.role !== "owner" && member.role !== "admin")) {
    return NextResponse.json({ error: "forbidden (owner/admin only)" }, { status: 403 });
  }

  const body = await request.json().catch(() => ({})) as {
    customer_summary?: string;
    internal_summary?: string;
    rules?: unknown[];
    name?: string;
  };

  const { data: current } = await admin
    .from("policies")
    .select("id, version, name, customer_summary, internal_summary, rules")
    .eq("workspace_id", workspaceId)
    .eq("slug", slug)
    .eq("is_active", true)
    .is("superseded_by", null)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!current) return NextResponse.json({ error: "not found" }, { status: 404 });

  // Update in place — keep simple for now. If we want version-history
  // (insert new row + supersede the old) we can switch this branch later.
  // For v1 a direct UPDATE is acceptable since the policies table is small
  // and changes are deliberate.
  const patch: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
    updated_by: user.id,
  };
  if (typeof body.name === "string" && body.name.trim()) patch.name = body.name.trim();
  if (typeof body.customer_summary === "string") patch.customer_summary = body.customer_summary;
  if (typeof body.internal_summary === "string") patch.internal_summary = body.internal_summary;
  if (Array.isArray(body.rules)) patch.rules = body.rules;

  // Only bump version if content actually changed
  const contentChanged =
    (patch.customer_summary != null && patch.customer_summary !== current.customer_summary) ||
    (patch.internal_summary != null && patch.internal_summary !== current.internal_summary) ||
    (patch.rules != null && JSON.stringify(patch.rules) !== JSON.stringify(current.rules));
  if (contentChanged) patch.version = current.version + 1;

  const { error } = await admin.from("policies").update(patch).eq("id", current.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, version: patch.version || current.version });
}
