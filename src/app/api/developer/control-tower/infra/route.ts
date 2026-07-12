/**
 * GET /api/developer/control-tower/infra?owner=<fn> — the per-department Infra tab
 * payload ([[../../../../../docs/brain/specs/control-tower-infra-sub-page]] Phase 1).
 *
 * Owner-gated, read-only. The org mirror's three-tier drill-in already gives the CEO a
 * per-department card; this route feeds its Infra tab — the error-feed rows +
 * DB-health panel (platform-only) + supabase-log-poll entries (a source inside the
 * error-feed already) filtered to that department's node ancestry. A red rollup on
 * `retention` can now be traced down to the exact `error_events` row that caused it
 * without the CEO leaving the Control Tower.
 *
 * The pre-shape happens in [[../../../../../lib/control-tower/infra-tab]] `buildInfraTabPayload`;
 * this route is the auth/gate wrapper.
 *
 * See docs/brain/libraries/control-tower-infra-tab.md.
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { OWNER_FUNCTIONS, type OwnerFunction } from "@/lib/control-tower/registry";
import { buildInfraTabPayload } from "@/lib/control-tower/infra-tab";

const OWNER_IDS: OwnerFunction[] = OWNER_FUNCTIONS.map((f) => f.id);

function isOwnerFunction(v: string | null): v is OwnerFunction {
  return v != null && (OWNER_IDS as string[]).includes(v);
}

export async function GET(req: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
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
    return NextResponse.json({ error: "Only the workspace owner can view the Control Tower" }, { status: 403 });
  }

  const url = new URL(req.url);
  const owner = url.searchParams.get("owner");
  if (!isOwnerFunction(owner)) {
    return NextResponse.json({ error: "?owner=<function> is required" }, { status: 400 });
  }

  const payload = await buildInfraTabPayload(admin, owner, workspaceId);
  return NextResponse.json(payload);
}
