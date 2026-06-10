import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { inngest } from "@/lib/inngest/client";

const DEFAULT_CONFIG = {
  enabled: false,
  require_approval: false,
  timezone: "America/Chicago",
  cadence: { reel: 3, feed: 4, story: 7 },
  time_slots: { feed: ["10:00", "18:30"], reel: ["12:00", "19:00"], story: ["09:00", "17:00", "20:00"] },
  min_resource_reuse_days: 21,
  max_posts_per_platform_per_day: 3,
  target_meta_page_ids: [] as string[],
};

async function auth(workspaceId: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  return user ? createAdminClient() : null;
}

// GET — everything the dashboard needs: config, target pages, upcoming + recent posts, promos.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: workspaceId } = await params;
  const admin = await auth(workspaceId);
  if (!admin) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const [ws, pages, upcoming, recent, promos] = await Promise.all([
    admin.from("workspaces").select("social_scheduler_config").eq("id", workspaceId).single(),
    admin.from("meta_pages").select("id, platform, meta_page_name, meta_instagram_id, is_active").eq("workspace_id", workspaceId).eq("is_active", true),
    admin.from("scheduled_social_posts").select("*").eq("workspace_id", workspaceId).in("status", ["draft", "scheduled", "publishing"]).order("scheduled_at", { ascending: true }).limit(200),
    admin.from("scheduled_social_posts").select("*").eq("workspace_id", workspaceId).in("status", ["posted", "failed", "cancelled"]).order("scheduled_at", { ascending: false }).limit(60),
    admin.from("social_campaigns").select("*").eq("workspace_id", workspaceId).order("starts_on", { ascending: false }),
  ]);

  const config = { ...DEFAULT_CONFIG, ...(ws.data?.social_scheduler_config || {}) };
  return NextResponse.json({ config, pages: pages.data || [], upcoming: upcoming.data || [], recent: recent.data || [], promos: promos.data || [] });
}

// PATCH — update the scheduler config.
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: workspaceId } = await params;
  const admin = await auth(workspaceId);
  if (!admin) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const { data: ws } = await admin.from("workspaces").select("social_scheduler_config").eq("id", workspaceId).single();
  const merged = { ...DEFAULT_CONFIG, ...(ws?.social_scheduler_config || {}), ...body };
  await admin.from("workspaces").update({ social_scheduler_config: merged, updated_at: new Date().toISOString() }).eq("id", workspaceId);
  return NextResponse.json({ config: merged });
}

// POST — trigger the planner now (fill the calendar immediately).
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: workspaceId } = await params;
  const admin = await auth(workspaceId);
  if (!admin) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  await inngest.send({ name: "social/plan.tick", data: { workspace_id: workspaceId } });
  return NextResponse.json({ ok: true });
}
