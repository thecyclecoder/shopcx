import { NextResponse } from "next/server";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { inngest } from "@/lib/inngest/client";
import { frequencyHint } from "@/lib/social/optimizer";

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
  const { user } = await getAuthedUser();
  return user ? createAdminClient() : null;
}

// GET — everything the dashboard needs: config, target pages, upcoming + recent posts, promos.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: workspaceId } = await params;
  const admin = await auth(workspaceId);
  if (!admin) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const [ws, pages, upcoming, recent, promos, prods] = await Promise.all([
    admin.from("workspaces").select("social_scheduler_config").eq("id", workspaceId).single(),
    admin.from("meta_pages").select("id, platform, meta_page_name, meta_instagram_id, is_active").eq("workspace_id", workspaceId).eq("is_active", true),
    admin.from("scheduled_social_posts").select("*").eq("workspace_id", workspaceId).in("status", ["draft", "scheduled", "publishing"]).order("scheduled_at", { ascending: true }).limit(200),
    admin.from("scheduled_social_posts").select("*").eq("workspace_id", workspaceId).in("status", ["posted", "failed", "cancelled"]).order("scheduled_at", { ascending: false }).limit(60),
    admin.from("social_campaigns").select("*").eq("workspace_id", workspaceId).order("starts_on", { ascending: false }),
    admin.from("products").select("id, title").eq("workspace_id", workspaceId).order("title"),
  ]);
  // Only products with an isolated image can get AI promo graphics.
  const { data: isoVariants } = await admin.from("product_variants").select("product_id").not("isolated_image_url", "is", null);
  const isoSet = new Set((isoVariants || []).map((v) => v.product_id));
  const products = (prods.data || []).map((p) => ({ id: p.id, title: p.title, has_isolated: isoSet.has(p.id) }));

  // Attach a previewable URL to each post: private-bucket assets get a fresh
  // signed URL; public resource images pass through. Marks videos (reels).
  type Row = { media_bucket: string | null; media_path: string | null; media_url: string | null; post_type: string; preview_url?: string | null; is_video?: boolean };
  const enrich = async (rows: Row[]) => {
    await Promise.all(rows.map(async (r) => {
      r.is_video = r.post_type === "reel" || !!r.media_path?.endsWith(".mp4");
      if (r.media_bucket && r.media_path) {
        const { data } = await admin.storage.from(r.media_bucket).createSignedUrl(r.media_path, 3600);
        r.preview_url = data?.signedUrl || null;
      } else {
        r.preview_url = r.media_url || null;
      }
    }));
    return rows;
  };
  await Promise.all([enrich((upcoming.data || []) as Row[]), enrich((recent.data || []) as Row[])]);

  const config = { ...DEFAULT_CONFIG, ...(ws.data?.social_scheduler_config || {}) };
  const freqHint = await frequencyHint(admin, workspaceId);
  return NextResponse.json({ config, pages: pages.data || [], upcoming: upcoming.data || [], recent: recent.data || [], promos: promos.data || [], products, freqHint });
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
