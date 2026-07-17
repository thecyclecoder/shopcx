import { NextResponse } from "next/server";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { inngest } from "@/lib/inngest/client";

async function authorize(workspaceId: string | null) {
  const { user } = await getAuthedUser();
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  if (!workspaceId) return { error: NextResponse.json({ error: "workspaceId required" }, { status: 400 }) };
  const admin = createAdminClient();
  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .single();
  if (!member || !["owner", "admin"].includes(member.role as string))
    return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  return { user, admin };
}

const ARCHETYPES = [
  // cold-50+ "killer" set (trust-first; both 4:5 + 9:16)
  "advertorial", "testimonial", "authority", "big_claim", "before_after", "ingredient_breakdown",
  // legacy set (kept for back-compat)
  "review", "offer", "benefit_authority",
];

/**
 * Generate a STATIC ad (separate process from video). One archetype → a designed
 * Remotion still. The cold-50+ "killer" archetypes render both 4:5 + 9:16; the
 * legacy archetypes render 1:1 / 4:5 / 9:16. See docs/brain/lifecycles/ad-static.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const workspaceId: string | null = body.workspaceId ?? null;
  const auth = await authorize(workspaceId);
  if (auth.error) return auth.error;

  const archetype = ARCHETYPES.includes(body.archetype) ? body.archetype : "";
  if (!archetype) return NextResponse.json({ error: `archetype required (one of: ${ARCHETYPES.join("|")})` }, { status: 400 });

  const { data: campaign } = await auth.admin
    .from("ad_campaigns")
    .select("id")
    .eq("id", id)
    .eq("workspace_id", workspaceId as string)
    .single();
  if (!campaign) return NextResponse.json({ error: "not_found" }, { status: 404 });

  await inngest.send({
    name: "ad-tool/static-requested",
    data: { workspace_id: workspaceId as string, campaign_id: id, archetype, copy: body.copy || undefined },
  });

  return NextResponse.json({ queued: true, archetype });
}
