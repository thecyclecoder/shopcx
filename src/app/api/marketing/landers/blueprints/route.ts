import { NextResponse } from "next/server";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  listBlueprints,
  listContentGaps,
  type LanderBlueprint,
  type LanderContentGap,
} from "@/lib/lander-blueprints";

// Marketing → Lander uploads reader (content-upload-and-lander-build.md Phase 1). The founder-
// facing surface — every lander_blueprint in `awaiting_upload` with its open lander_content_gaps
// so the page can render one card per real-evidence asset Carrie flagged.
//
//   GET ?workspaceId=…            → { blueprints: [{ …blueprint, product, gaps: [...] }] }
//   GET ?workspaceId=…&count=1    → { pending_uploads: N } — cheap badge-count path for the
//                                   sidebar. N = total OPEN gaps on awaiting_upload blueprints.
//
// Owner-only (role !== 'owner' → 403), mirroring /api/research/landers.

export async function GET(req: Request) {
  const url = new URL(req.url);
  const workspaceId = url.searchParams.get("workspaceId");
  const wantCount = url.searchParams.get("count") === "1";

  const { user } = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!workspaceId) return NextResponse.json({ error: "workspaceId required" }, { status: 400 });

  const admin = createAdminClient();
  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .single();
  if (!member || (member.role as string) !== "owner") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const blueprints = await listBlueprints(workspaceId, { status: "awaiting_upload" });

  if (wantCount) {
    if (blueprints.length === 0) return NextResponse.json({ pending_uploads: 0 });
    const gapsByBp = await Promise.all(
      blueprints.map((b) => listContentGaps(workspaceId, { blueprint_id: b.id, status: "open" })),
    );
    const pending = gapsByBp.reduce((sum, arr) => sum + arr.length, 0);
    return NextResponse.json({ pending_uploads: pending });
  }

  if (blueprints.length === 0) return NextResponse.json({ blueprints: [] });

  // Product titles / handles for the product a blueprint is bound to.
  const productIds = Array.from(new Set(blueprints.map((b) => b.product_id)));
  const { data: products } = await admin
    .from("products")
    .select("id, title, handle")
    .eq("workspace_id", workspaceId)
    .in("id", productIds);
  const productById = new Map<string, { id: string; title: string | null; handle: string | null }>();
  for (const p of products || []) productById.set(p.id as string, p as { id: string; title: string | null; handle: string | null });

  const gapsByBp = await Promise.all(
    blueprints.map((b) => listContentGaps(workspaceId, { blueprint_id: b.id, status: "open" })),
  );

  const payload = blueprints.map((b: LanderBlueprint, i: number) => ({
    id: b.id,
    product_id: b.product_id,
    product: productById.get(b.product_id) || null,
    funnel_type: b.funnel_type,
    status: b.status,
    rationale: b.rationale,
    skeleton: b.skeleton,
    content: b.content,
    created_at: b.created_at,
    updated_at: b.updated_at,
    gaps: gapsByBp[i].map((g: LanderContentGap) => ({
      id: g.id,
      asset_role: g.asset_role,
      block_ref: g.block_ref,
      description: g.description,
      status: g.status,
    })),
  }));

  return NextResponse.json({ blueprints: payload });
}
